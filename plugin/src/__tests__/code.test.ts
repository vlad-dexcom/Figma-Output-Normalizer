import { describe, expect, it, vi } from "vitest";
import { handleUIMessage, initializePlugin } from "../code.js";
import { createMockFigma } from "../test/mockFigma.js";
import { mockFrame, mockText } from "../test/nodeBuilders.js";
import { DEFAULT_NODE_BUDGET } from "../extractor/index.js";

describe("initializePlugin", () => {
  it("shows the UI and posts the initial selection on startup", () => {
    const selected = mockFrame({ name: "Screen", children: [] });
    const mockFigma = createMockFigma({ selection: [selected] });

    initializePlugin(mockFigma);

    expect(mockFigma.showUI).toHaveBeenCalledTimes(1);
    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith({
      type: "selection-changed",
      nodeId: selected.id,
      name: "Screen",
      nodeType: "FRAME",
    });
  });

  it("posts selection-changed again whenever the Figma selection changes", () => {
    const mockFigma = createMockFigma({ selection: [] });
    initializePlugin(mockFigma);
    (mockFigma.ui.postMessage as unknown as { mockClear: () => void }).mockClear();

    const selected = mockFrame({ name: "New selection", children: [] });
    mockFigma.currentPage.selection = [selected];
    mockFigma.triggerSelectionChange();

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith({
      type: "selection-changed",
      nodeId: selected.id,
      name: "New selection",
      nodeType: "FRAME",
    });
  });

  it("routes incoming UI messages to handleUIMessage", async () => {
    const mockFigma = createMockFigma({ selection: [] });
    initializePlugin(mockFigma);

    mockFigma.triggerUIMessage({ type: "extract" });
    // handleUIMessage is invoked fire-and-forget (`void handleUIMessage(...)`); flush microtasks.
    await Promise.resolve();
    await Promise.resolve();

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", code: "empty-selection" }),
    );
  });
});

describe("handleUIMessage: extract", () => {
  it("posts an error, not a throw, when nothing is selected", async () => {
    const mockFigma = createMockFigma({ selection: [] });

    await handleUIMessage(mockFigma, { type: "extract" });

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "Select at least one layer to extract.",
      code: "empty-selection",
    });
  });

  it("extracts the selection and posts the IR + export source to the UI", async () => {
    const selectedText = mockText("Hello", [
      {
        characters: "Hello",
        fontSize: 14,
        fontName: { family: "Inter", style: "Regular" },
        fills: [],
      },
    ]);
    const mockFigma = createMockFigma({ selection: [selectedText], fileKey: "file-abc" });

    await handleUIMessage(mockFigma, { type: "extract" });

    expect(mockFigma.ui.postMessage).toHaveBeenCalledTimes(1);
    const [message] = (mockFigma.ui.postMessage as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [{ type: string; ir: { nodes: unknown[] }; source: Record<string, string> }];
    expect(message.type).toBe("ir-result");
    expect(message.ir.nodes).toHaveLength(1);
    // `version` is a content-hash derived from the extracted IR (see
    // extractor/versioning.ts), not a literal — assert its shape/scheme
    // rather than a fixed value.
    expect(message.source.version).toMatch(/^c1-[0-9a-f]{16}$/);
    expect(message.source).toEqual({
      fileKey: "file-abc",
      nodeId: selectedText.id,
      version: message.source.version,
    });
  });

  it("prunes an empty non-auto-layout frame to no IR nodes", async () => {
    const emptyFrame = mockFrame({ name: "Empty", children: [] });
    const mockFigma = createMockFigma({ selection: [emptyFrame] });

    await handleUIMessage(mockFigma, { type: "extract" });

    const [message] = (mockFigma.ui.postMessage as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [{ ir: { nodes: unknown[] } }];
    expect(message.ir.nodes).toHaveLength(0);
  });

  it("falls back to an empty fileKey and surfaces a missing-file-key warning when figma.fileKey is unavailable", async () => {
    // `figma.fileKey` requires `enablePrivatePluginApi` in manifest.json and
    // is only ever populated for private/org plugins — it can legitimately
    // resolve to `undefined`/`""` (see code.ts's `resolveFileKey`). This must
    // surface as an explicit UnresolvedEntry, not a silently empty
    // Provenance.fileKey with no trace of why.
    const selected = mockFrame({ name: "Screen", children: [] });
    const mockFigma = createMockFigma({ selection: [selected], fileKey: "" });

    await handleUIMessage(mockFigma, { type: "extract" });

    const [message] = (mockFigma.ui.postMessage as unknown as { mock: { calls: unknown[][] } }).mock
      .calls[0] as [
      { ir: { unresolved: { nodeId: string; reason: string }[] }; source: { fileKey: string } },
    ];
    expect(message.source.fileKey).toBe("");
    expect(message.ir.unresolved).toContainEqual(
      expect.objectContaining({ nodeId: selected.id, reason: "missing-file-key" }),
    );
  });

  it("posts a visible budget-exceeded error instead of throwing when the node budget is hit", async () => {
    // DEFAULT_NODE_BUDGET counts every node visited, including pruned empty
    // frames — build enough flat siblings under an Auto Layout root to
    // exceed it and confirm handleExtract turns the resulting
    // NodeBudgetExceededError into a posted error, not an uncaught
    // rejection.
    const children = Array.from({ length: DEFAULT_NODE_BUDGET + 1 }, (_, i) =>
      mockFrame({ name: `child-${i}`, children: [] }),
    );
    const root = mockFrame({ name: "Root", layoutMode: "VERTICAL", children });
    const mockFigma = createMockFigma({ selection: [root] });

    await handleUIMessage(mockFigma, { type: "extract" });

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({ type: "error", code: "budget-exceeded" }),
    );
  });

  it("posts a clear symbol-leak diagnostic instead of an opaque structured-clone crash when a stray Symbol reaches the result", async () => {
    // Simulates a still-unguarded read site (present or future) letting a
    // `figma.mixed`-style Symbol slip past every currently-known `isMixed`
    // guard, all the way into the extraction result — the defense-in-depth
    // safety net (`findSymbolPath`, invoked here inside `handleExtract`)
    // must catch it before `postMessage` would otherwise crash with the
    // real browser's opaque "Cannot unwrap symbol" structured-clone error.
    const extractorModule = await import("../extractor/index.js");
    const spy = vi.spyOn(extractorModule, "extractSelection").mockResolvedValue({
      schemaVersion: 1,
      nodes: [
        {
          kind: "layout",
          direction: "column",
          gap: null,
          padding: {},
          mainAxisAlign: "start",
          crossAxisAlign: "start",
          sizing: { width: "fixed", height: "fixed" },
          background: null,
          // A stray, unguarded Symbol nested inside the result tree.
          cornerRadius: Symbol("figma.mixed") as never,
          children: [],
          source: { fileKey: "fk", nodeId: "1:1", version: "1", path: [] },
        },
      ],
      unresolved: [],
      version: "1",
    });

    const selected = mockFrame({ name: "Screen", children: [] });
    const mockFigma = createMockFigma({ selection: [selected] });

    await handleUIMessage(mockFigma, { type: "extract" });

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "error",
        code: "symbol-leak",
        message: expect.stringContaining("nodes.0.cornerRadius"),
      }),
    );

    spy.mockRestore();
  });
});

describe("handleUIMessage: select-node", () => {
  it("re-selects and scrolls to the node, and posts the updated selection", async () => {
    const target = mockFrame({ name: "Target", children: [] });
    const mockFigma = createMockFigma({ selection: [], nodesById: { [target.id]: target } });

    await handleUIMessage(mockFigma, { type: "select-node", nodeId: target.id });

    expect(mockFigma.currentPage.selection).toEqual([target]);
    expect(mockFigma.viewport?.scrollAndZoomIntoView).toHaveBeenCalledWith([target]);
    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith({
      type: "selection-changed",
      nodeId: target.id,
      name: "Target",
      nodeType: "FRAME",
    });
  });

  it("posts a node-not-found error for an id that no longer resolves", async () => {
    const mockFigma = createMockFigma({ selection: [] });

    await handleUIMessage(mockFigma, { type: "select-node", nodeId: "missing:1" });

    expect(mockFigma.ui.postMessage).toHaveBeenCalledWith({
      type: "error",
      message: "Node missing:1 no longer exists in this document.",
      code: "node-not-found",
    });
  });
});

describe("handleUIMessage: export", () => {
  it("notifies that the export happened", async () => {
    const mockFigma = createMockFigma({ selection: [] });

    await handleUIMessage(mockFigma, {
      type: "export",
      source: { fileKey: "fk", nodeId: "1:1", version: "1" },
    });

    expect(mockFigma.notify).toHaveBeenCalledWith("Figma Normalizator: IR exported.");
  });
});

describe("handleUIMessage: extract-tokens", () => {
  const collections = {
    "col:base": {
      id: "col:base",
      name: "base",
      remote: false,
      defaultModeId: "light",
      modes: [
        { modeId: "light", name: "light" },
        { modeId: "dark", name: "dark" },
      ],
      variableIds: ["var:1"],
    },
  };
  const variables = {
    "var:1": {
      id: "var:1",
      name: "color/text/base/default",
      variableCollectionId: "col:base",
      resolvedType: "COLOR" as const,
      valuesByMode: { light: { r: 0, g: 0, b: 0 }, dark: { r: 1, g: 1, b: 1 } },
    },
  };

  it("posts a token-result with a summary the panel can render", async () => {
    const mockFigma = createMockFigma({
      fileKey: "file-key",
      variables,
      variableCollections: collections,
    });

    await handleUIMessage(mockFigma, { type: "extract-tokens" });

    const posted = vi.mocked(mockFigma.ui.postMessage).mock.calls.at(-1)?.[0];
    expect(posted?.type).toBe("token-result");
    if (posted?.type !== "token-result") throw new Error("expected a token-result");

    expect(posted.tokens.envelope.fileKey).toBe("file-key");
    expect(posted.tokens.envelope.kind).toBe("tokens");
    expect(posted.source.version).toBe(posted.tokens.envelope.version);
    expect(posted.summary.variableCount).toBe(1);
    expect(posted.tokens.collections[0]?.tokens[0]?.path).toBe("color/text/base/default");
  });

  it("reports a missing variables API instead of throwing", async () => {
    const mockFigma = createMockFigma({ supportsLocalVariableCollections: false });

    await handleUIMessage(mockFigma, { type: "extract-tokens" });

    const posted = vi.mocked(mockFigma.ui.postMessage).mock.calls.at(-1)?.[0];
    expect(posted).toMatchObject({ type: "error", code: "variables-api-unavailable" });
  });

  it("notifies on export-tokens", async () => {
    const mockFigma = createMockFigma();
    await handleUIMessage(mockFigma, {
      type: "export-tokens",
      source: { fileKey: "f", version: "c1-0" },
    });
    expect(mockFigma.notify).toHaveBeenCalledWith("Figma Normalizator: tokens exported.");
  });
});
