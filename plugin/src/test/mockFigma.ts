// Extensible stub of the Figma plugin API global, for running plugin logic
// headlessly in vitest without a real Figma sandbox. Extend this as the
// extractor/panel grows to need more of the real `figma` surface.
import { vi } from "vitest";
import type { ExtractFigmaAPI } from "../code.js";
import type { FigmaNode, FigmaVariable, FigmaVariableCollection } from "../extractor/types.js";
import type { UIToPluginMessage } from "../messages.js";

export interface MockFigmaOptions {
  selection?: ExtractFigmaAPI["currentPage"]["selection"];
  fileKey?: string;
  variables?: Record<string, FigmaVariable>;
  variableCollections?: Record<string, FigmaVariableCollection>;
  /** Nodes `getNodeByIdAsync` can resolve, e.g. for `select-node` message tests. */
  nodesById?: Record<string, FigmaNode>;
  /**
   * Set false to simulate an older Figma build with no
   * `getLocalVariableCollectionsAsync`, which the token export must report
   * rather than crash on.
   */
  supportsLocalVariableCollections?: boolean;
}

export type MockFigma = ExtractFigmaAPI & {
  /** Test helper: invokes the `selectionchange` listener registered via `on`, as if Figma fired it. */
  triggerSelectionChange(): void;
  /** Test helper: invokes the `message` listener registered via `ui.on`, as if the UI iframe posted it. */
  triggerUIMessage(message: UIToPluginMessage): void;
};

export function createMockFigma(options: MockFigmaOptions = {}): MockFigma {
  const variables = options.variables ?? {};
  const variableCollections = options.variableCollections ?? {};
  const nodesById = options.nodesById ?? {};

  let selectionChangeListener: (() => void) | undefined;
  let uiMessageListener: ((message: UIToPluginMessage) => void) | undefined;

  const mockFigma: MockFigma = {
    currentPage: { selection: options.selection ?? [] },
    variables: {
      getVariableByIdAsync: vi.fn(async (id: string) => variables[id] ?? null),
      getVariableCollectionByIdAsync: vi.fn(async (id: string) => variableCollections[id] ?? null),
      ...(options.supportsLocalVariableCollections === false
        ? {}
        : {
            getLocalVariableCollectionsAsync: vi.fn(async () => Object.values(variableCollections)),
          }),
    },
    fileKey: options.fileKey ?? "test-file-key",
    notify: vi.fn(),
    showUI: vi.fn(),
    closePlugin: vi.fn(),
    ui: {
      postMessage: vi.fn(),
      on: vi.fn((event: "message", callback: (message: UIToPluginMessage) => void) => {
        if (event === "message") uiMessageListener = callback;
      }),
    },
    on: vi.fn((event: "selectionchange", callback: () => void) => {
      if (event === "selectionchange") selectionChangeListener = callback;
    }),
    getNodeByIdAsync: vi.fn(async (id: string) => nodesById[id] ?? null),
    viewport: { scrollAndZoomIntoView: vi.fn() },
    triggerSelectionChange(): void {
      selectionChangeListener?.();
    },
    triggerUIMessage(message: UIToPluginMessage): void {
      uiMessageListener?.(message);
    },
  };

  return mockFigma;
}
