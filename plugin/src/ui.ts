// The UI iframe side of the panel — DOM-capable, but no Figma plugin API
// access (see `./code.ts` for that side, and `./messages.ts` for the shared
// protocol). Deliberately kept thin: the only non-trivial logic here
// (warning grouping, export filename generation) lives in pure, tested
// modules under `./ui/` that this file just calls and renders.
import type { ExtractionResult } from "./extractor/index.js";
import { canonicalStringify } from "./extractor/canonical.js";
import type { TokenDocument, UnresolvedEntry } from "@figma-normalizator/schema";
import { buildExportFilename, buildTokenExportFilename } from "./ui/filename.js";
import { buildWarningsViewModel } from "./ui/warnings.js";
import { copyToClipboard, type ClipboardDeps } from "./ui/clipboard.js";
import type {
  ExportSource,
  PluginToUIMessage,
  TokenExportSourceInfo,
  UIToPluginMessage,
} from "./messages.js";

function byId<T extends HTMLElement>(id: string): T {
  const el = document.getElementById(id);
  if (!el) throw new Error(`ui.ts: expected element #${id} to exist in ui.html`);
  return el as T;
}

const selectionNameEl = byId<HTMLDivElement>("selection-name");
const extractButton = byId<HTMLButtonElement>("extract-button");
const exportButton = byId<HTMLButtonElement>("export-button");
const copyButton = byId<HTMLButtonElement>("copy-button");
const copyStatusEl = byId<HTMLSpanElement>("copy-status");
const bannerEl = byId<HTMLDivElement>("banner");
const warningsEl = byId<HTMLDivElement>("warnings");
const warningsToggleButton = byId<HTMLButtonElement>("warnings-toggle");
const irPreviewEl = byId<HTMLPreElement>("ir-preview");
const extractTokensButton = byId<HTMLButtonElement>("extract-tokens-button");
const exportTokensButton = byId<HTMLButtonElement>("export-tokens-button");
const tokensStatusEl = byId<HTMLSpanElement>("tokens-status");

let copyStatusResetTimer: number | undefined;

/** State needed across messages: the latest extraction result plus enough provenance to name an export. */
let lastResult: ExtractionResult | null = null;
let lastSource: ExportSource | null = null;

/**
 * Token-export state, kept separate from `lastResult`/`lastSource` on
 * purpose: a token document is file-scoped and survives selection changes,
 * so tying it to the selection-scoped result would throw it away every time
 * the designer clicked a different layer.
 */
let lastTokens: TokenDocument | null = null;
let lastTokenSource: TokenExportSourceInfo | null = null;

/**
 * "Collapse all" toggle for the warnings panel: hides each group's
 * individual entries (titles/counts stay visible) so a screen with many
 * `unmapped-component` warnings — e.g. one with few/no design-system
 * components — doesn't crowd out the IR preview. Manual, off by default,
 * and persists across re-Extracts within the same panel session (reset
 * only if the panel itself is reopened) — matches `lastResult`'s lifetime.
 */
let warningsCollapsed = false;

function postToPlugin(message: UIToPluginMessage): void {
  parent.postMessage({ pluginMessage: message }, "*");
}

function showBanner(message: string): void {
  bannerEl.textContent = message;
  bannerEl.classList.add("visible");
}

function clearBanner(): void {
  bannerEl.textContent = "";
  bannerEl.classList.remove("visible");
}

function renderSelection(name: string | null, nodeType: string | null): void {
  selectionNameEl.textContent = name
    ? `${name} (${nodeType ?? "unknown type"})`
    : "Nothing selected";
}

function renderIRPreview(result: ExtractionResult): void {
  irPreviewEl.textContent = JSON.stringify(result.nodes, null, 2);
}

function renderWarningEntry(entry: UnresolvedEntry): HTMLDivElement {
  const row = document.createElement("div");
  row.className = "warning-entry";

  const text = document.createElement("div");
  text.className = "text";

  const reason = document.createElement("div");
  reason.textContent = entry.reason;
  text.appendChild(reason);

  if (entry.detail) {
    const detail = document.createElement("div");
    detail.className = "detail";
    detail.textContent = entry.detail;
    text.appendChild(detail);
  }

  const nodeId = document.createElement("div");
  nodeId.className = "node-id";
  nodeId.textContent = entry.nodeId;
  text.appendChild(nodeId);

  row.appendChild(text);

  const selectButton = document.createElement("button");
  selectButton.textContent = "Select";
  selectButton.addEventListener("click", () => {
    postToPlugin({ type: "select-node", nodeId: entry.nodeId });
  });
  row.appendChild(selectButton);

  return row;
}

function renderWarnings(unresolved: readonly UnresolvedEntry[]): void {
  warningsEl.innerHTML = "";

  const view = buildWarningsViewModel(unresolved, warningsCollapsed);

  warningsToggleButton.hidden = !view.hasWarnings;
  warningsToggleButton.textContent = view.toggleLabel;

  if (!view.hasWarnings) {
    const empty = document.createElement("p");
    empty.id = "empty-warnings";
    empty.textContent = "No warnings — this selection is fully resolved.";
    warningsEl.appendChild(empty);
    return;
  }

  for (const group of view.groups) {
    const groupEl = document.createElement("div");
    groupEl.className = "warning-group";

    const title = document.createElement("div");
    title.className = "warning-group-title";
    title.textContent = `${group.label} (${group.entries.length})`;
    groupEl.appendChild(title);

    if (view.entriesVisible) {
      for (const entry of group.entries) {
        groupEl.appendChild(renderWarningEntry(entry));
      }
    }

    warningsEl.appendChild(groupEl);
  }
}

function handlePluginMessage(message: PluginToUIMessage): void {
  switch (message.type) {
    case "selection-changed":
      renderSelection(message.name, message.nodeType);
      return;

    case "ir-result": {
      clearBanner();
      lastResult = message.ir;
      lastSource = message.source;
      exportButton.disabled = false;
      copyButton.disabled = false;
      renderIRPreview(message.ir);
      renderWarnings(message.ir.unresolved);
      return;
    }

    case "token-result": {
      clearBanner();
      lastTokens = message.tokens;
      lastTokenSource = message.source;
      exportTokensButton.disabled = false;

      const collections = message.tokens.collections.length;
      const tokens = message.tokens.collections.reduce((n, c) => n + c.tokens.length, 0);
      const unresolved = message.tokens.unresolved.length;
      const skipped = message.summary.skippedCollections.length;
      // Unresolved count is always shown, even at zero: the whole point of
      // the unresolved channel is that it is never silently empty because
      // something was dropped.
      tokensStatusEl.textContent =
        `${tokens} tokens in ${collections} collections · ${unresolved} unresolved` +
        (skipped > 0 ? ` · ${skipped} collections skipped by policy` : "");
      return;
    }

    case "error": {
      lastResult = null;
      lastSource = null;
      exportButton.disabled = true;
      copyButton.disabled = true;
      // A budget-exceeded error means extraction was stopped, not silently
      // truncated (see extractor/budget.ts) — this MUST be visible to the
      // designer, not a silently-dropped notification.
      showBanner(message.message);
      return;
    }
  }
}

extractButton.addEventListener("click", () => {
  clearBanner();
  postToPlugin({ type: "extract" });
});

extractTokensButton.addEventListener("click", () => {
  clearBanner();
  tokensStatusEl.textContent = "Extracting tokens…";
  postToPlugin({ type: "extract-tokens" });
});

exportTokensButton.addEventListener("click", () => {
  if (!lastTokens || !lastTokenSource) return;

  // Same canonical serialization as the IR export, for the same reason:
  // re-exporting unchanged content must be byte-identical, not merely
  // deep-equal.
  const blob = new Blob([canonicalStringify(lastTokens, 2)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = buildTokenExportFilename(lastTokenSource);
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  postToPlugin({ type: "export-tokens", source: lastTokenSource });
});

warningsToggleButton.addEventListener("click", () => {
  warningsCollapsed = !warningsCollapsed;
  renderWarnings(lastResult?.unresolved ?? []);
});

/**
 * Both the file download and the clipboard copy serialize through
 * `canonicalStringify` (recursively sorted object keys, see
 * `extractor/canonical.ts`) rather than a plain `JSON.stringify` — this is
 * what makes "export the same unchanged selection twice, diff the two
 * outputs" byte-identical, not just deep-equal.
 */
function serializeForExport(result: ExtractionResult): string {
  return canonicalStringify(result, 2);
}

exportButton.addEventListener("click", () => {
  if (!lastResult || !lastSource) return;

  const filename = buildExportFilename(lastSource);
  const blob = new Blob([serializeForExport(lastResult)], { type: "application/json" });
  const url = URL.createObjectURL(blob);

  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = filename;
  document.body.appendChild(anchor);
  anchor.click();
  anchor.remove();
  URL.revokeObjectURL(url);

  postToPlugin({ type: "export", source: lastSource });
});

/** Builds the real browser `ClipboardDeps` — kept separate from `./ui/clipboard.ts` so that module stays DOM-free and testable without a browser. */
function buildClipboardDeps(): ClipboardDeps {
  const clipboard = (navigator as Navigator & { clipboard?: { writeText?: unknown } }).clipboard;
  const writeText =
    clipboard && typeof clipboard.writeText === "function"
      ? (text: string) => (clipboard.writeText as (t: string) => Promise<void>)(text)
      : undefined;

  const fallbackCopy = (text: string): boolean => {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    // Keep it out of the visible/scrollable layout and off-screen, but
    // still focusable/selectable — both required for execCommand("copy")
    // to have a selection to act on.
    textarea.style.position = "fixed";
    textarea.style.top = "0";
    textarea.style.left = "-9999px";
    textarea.style.opacity = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      return document.execCommand("copy");
    } finally {
      textarea.remove();
    }
  };

  return { writeText, fallbackCopy };
}

function showCopyStatus(text: string, isError: boolean): void {
  if (copyStatusResetTimer !== undefined) window.clearTimeout(copyStatusResetTimer);
  copyStatusEl.textContent = text;
  copyStatusEl.classList.toggle("error", isError);
  copyStatusResetTimer = window.setTimeout(() => {
    copyStatusEl.textContent = "";
    copyStatusEl.classList.remove("error");
  }, 4000);
}

copyButton.addEventListener("click", () => {
  if (!lastResult) return;

  const json = serializeForExport(lastResult);
  void copyToClipboard(json, buildClipboardDeps()).then((outcome) => {
    if (outcome.ok) {
      showCopyStatus("Copied to clipboard.", false);
    } else {
      // Never fail silently: a failed copy MUST be visible, same principle
      // as the budget-exceeded banner above.
      showCopyStatus(`Copy failed: ${outcome.error ?? "unknown error"}`, true);
    }
  });
});

window.onmessage = (event: MessageEvent<{ pluginMessage?: PluginToUIMessage }>) => {
  const message = event.data.pluginMessage;
  if (message) handlePluginMessage(message);
};
