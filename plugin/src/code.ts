// Sandboxed plugin-API-side entry point (no DOM access — this runs in
// Figma's plugin sandbox, not the UI iframe). Bundled by esbuild into
// `dist/code.js`, which `manifest.json`'s `main` field points at.
//
// Keeps the panel (`ui.ts`/`ui.html`) open for the whole session rather than
// running once and closing: it forwards selection changes to the UI, and
// handles `extract`/`select-node`/`export` messages from it (see
// `./messages.ts` for the full protocol both sides share).
import {
  extractSelection,
  NodeBudgetExceededError,
  type ExtractionResult,
  type FigmaNode,
} from "./extractor/index.js";
import { findSymbolPath } from "./extractor/mixed.js";
import type { PluginToUIMessage, SelectionSummary, UIToPluginMessage } from "./messages.js";
import type { UnresolvedEntry } from "@figma-normalizator/schema";

/** The minimal slice of the real Figma plugin API this entry point depends on. */
export interface ExtractFigmaAPI {
  currentPage: { selection: readonly FigmaNode[] };
  variables: {
    getVariableByIdAsync: (id: string) => Promise<unknown>;
    getVariableCollectionByIdAsync: (id: string) => Promise<unknown>;
  };
  fileKey?: string;
  notify(message: string): void;
  showUI(html: string, options?: { visible?: boolean; width?: number; height?: number }): void;
  closePlugin(message?: string): void;
  ui: {
    postMessage(message: PluginToUIMessage): void;
    on(event: "message", callback: (message: UIToPluginMessage) => void): void;
  };
  on(event: "selectionchange", callback: () => void): void;
  getNodeByIdAsync?(id: string): Promise<FigmaNode | null>;
  viewport?: { scrollAndZoomIntoView(nodes: readonly FigmaNode[]): void };
}

function describeSelection(selection: readonly FigmaNode[]): SelectionSummary {
  const node = selection[0];
  return {
    nodeId: node?.id ?? null,
    name: node?.name ?? null,
    nodeType: node?.type ?? null,
  };
}

function postSelectionChanged(api: ExtractFigmaAPI, selection: readonly FigmaNode[]): void {
  api.ui.postMessage({ type: "selection-changed", ...describeSelection(selection) });
}

/**
 * `figma.fileKey` requires `enablePrivatePluginApi` in manifest.json (see
 * manifest.json's own comment) **and** only resolves for private/org
 * plugins or Figma-owned resources — it can legitimately be `undefined` in
 * any other context (a public/dev-mode install, or before the org grants
 * that capability). Rather than silently degrading every `Provenance.fileKey`
 * to `""` (which made two different Figma files' exports indistinguishable
 * and broke the export filename's `{fileKey}` segment), surface the gap as
 * an explicit `UnresolvedEntry` — same "never substitute silently"
 * philosophy the rest of the extractor already follows for tokens/variants.
 */
function resolveFileKey(
  api: ExtractFigmaAPI,
  selectionRootId: string,
): { fileKey: string; unresolved: UnresolvedEntry[] } {
  const fileKey = api.fileKey;
  if (fileKey) {
    return { fileKey, unresolved: [] };
  }
  return {
    fileKey: "",
    unresolved: [
      {
        nodeId: selectionRootId,
        reason: "missing-file-key",
        detail:
          "figma.fileKey is unavailable (requires enablePrivatePluginApi in manifest.json, " +
          "and is only ever populated for private/org plugins or Figma-owned resources). " +
          "Provenance.fileKey and the exported filename's {fileKey} segment fall back to an " +
          "empty/placeholder value; exports from different Figma files may be indistinguishable.",
      },
    ],
  };
}

/**
 * Runs the extractor against the current selection and posts either an
 * `ir-result` or a descriptive `error` back to the UI. Never throws:
 * `extractSelection`'s only expected failure mode (`NodeBudgetExceededError`,
 * see extractor/budget.ts) is turned into a visible error rather than an
 * uncaught rejection, and any other unexpected error is reported too rather
 * than silently swallowed.
 */
async function handleExtract(api: ExtractFigmaAPI): Promise<void> {
  const selection = api.currentPage.selection;

  if (selection.length === 0) {
    api.ui.postMessage({
      type: "error",
      message: "Select at least one layer to extract.",
      code: "empty-selection",
    });
    return;
  }

  try {
    // `variables` is typed loosely on `ExtractFigmaAPI` above (to keep this
    // file's own API surface small); `extractSelection` wants the narrower
    // shape it actually calls. Real Figma's `variables` API is a structural
    // superset of what we need here.
    // No `version` is passed here: extractSelection derives a deterministic
    // content-hash version from the extracted IR itself (see
    // extractor/versioning.ts) rather than us inventing one up front.
    const rootId = selection[0]?.id ?? "";
    const { fileKey, unresolved: fileKeyUnresolved } = resolveFileKey(api, rootId);
    const result: ExtractionResult = await extractSelection(
      {
        variables: api.variables as unknown as Parameters<typeof extractSelection>[0]["variables"],
      },
      selection,
      { fileKey },
    );
    if (fileKeyUnresolved.length > 0) {
      result.unresolved.push(...fileKeyUnresolved);
    }

    // Defense-in-depth: even with every currently-known read site guarded
    // against `figma.mixed` (see extractor/mixed.ts's `isMixed`), a
    // still-unguarded read of some other mixed-capable Figma API surface
    // (present or future) could let a stray `Symbol` slip into `result`.
    // `figma.ui.postMessage` uses structured clone, which cannot serialize
    // a `Symbol` and would otherwise crash the panel with the opaque
    // "Cannot unwrap symbol" error this whole fix exists to prevent. Scan
    // the full result tree first so any such leak surfaces as a clear,
    // actionable diagnostic (naming exactly which property leaked) instead
    // of an uncaught structured-clone failure.
    const symbolPath = findSymbolPath(result);
    if (symbolPath) {
      api.ui.postMessage({
        type: "error",
        message:
          `Extraction produced an unserializable value (a Symbol, likely an unguarded ` +
          `figma.mixed read) at path "${symbolPath.join(".")}" in the result. This is a ` +
          "plugin bug — please report it, including the node/property that produced this path.",
        code: "symbol-leak",
      });
      return;
    }

    api.ui.postMessage({
      type: "ir-result",
      ir: result,
      source: {
        fileKey,
        nodeId: rootId,
        version: result.version,
      },
    });
  } catch (error) {
    if (error instanceof NodeBudgetExceededError) {
      api.ui.postMessage({ type: "error", message: error.message, code: "budget-exceeded" });
      return;
    }
    const message = error instanceof Error ? error.message : "Unknown error during extraction.";
    api.ui.postMessage({ type: "error", message, code: "unknown" });
  }
}

/** Re-selects and scrolls to a node by id, so a designer can click a warning and jump to it on the canvas. */
async function handleSelectNode(api: ExtractFigmaAPI, nodeId: string): Promise<void> {
  if (!api.getNodeByIdAsync) {
    api.ui.postMessage({
      type: "error",
      message: "This Figma version cannot look up nodes by id.",
      code: "unsupported",
    });
    return;
  }

  const node = await api.getNodeByIdAsync(nodeId);
  if (!node) {
    api.ui.postMessage({
      type: "error",
      message: `Node ${nodeId} no longer exists in this document.`,
      code: "node-not-found",
    });
    return;
  }

  api.currentPage.selection = [node];
  api.viewport?.scrollAndZoomIntoView([node]);
  postSelectionChanged(api, [node]);
}

/**
 * The IR JSON is written to disk by the UI itself (only it has DOM access
 * to build a Blob + trigger an anchor download) — this hook just lets the
 * plugin-sandbox side observe that an export happened, and gives the later
 * `ir-export` task a place to extend export behavior without touching
 * `ui.ts`.
 */
function handleExport(api: ExtractFigmaAPI): void {
  api.notify("Figma Normalizator: IR exported.");
}

export async function handleUIMessage(
  api: ExtractFigmaAPI,
  message: UIToPluginMessage,
): Promise<void> {
  switch (message.type) {
    case "extract":
      await handleExtract(api);
      return;
    case "select-node":
      await handleSelectNode(api, message.nodeId);
      return;
    case "export":
      handleExport(api);
      return;
  }
}

/** Wires up the persistent panel: shows the UI, and forwards selection/message events to it. */
export function initializePlugin(api: ExtractFigmaAPI): void {
  // `__html__` is an ambient global populated by Figma at runtime from
  // manifest.json's `ui` field (see @figma/plugin-typings). It doesn't
  // exist in the headless test environment, so guard with `typeof` rather
  // than referencing it directly (which would throw a ReferenceError).
  const html = typeof __html__ !== "undefined" ? __html__ : "";
  api.showUI(html, { width: 360, height: 560 });

  postSelectionChanged(api, api.currentPage.selection);
  api.on("selectionchange", () => postSelectionChanged(api, api.currentPage.selection));
  api.ui.on("message", (message) => void handleUIMessage(api, message));
}

// Only invoke against the real Figma sandbox when one is present (i.e. not
// when this module is imported by the headless test harness).
if (typeof figma !== "undefined") {
  // Real Figma nodes are a structural superset of this module's `FigmaNode`
  // (see extractor/types.ts) — this is the one place the plugin sandbox API
  // meets the extractor's narrower, more testable node shape.
  initializePlugin(figma as unknown as ExtractFigmaAPI);
}
