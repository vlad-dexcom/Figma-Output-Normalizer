// Runs a `FixtureScenario` through the real extractor and returns the full
// `ExtractionResult`. Used by both the snapshot test and the
// `fixtures:update` regeneration script, so the two can never drift from
// each other.
//
// Deliberately builds its own minimal `variables` stub rather than reusing
// `plugin/src/test/mockFigma.ts`'s `createMockFigma`: that helper wraps its
// functions in vitest's `vi.fn()`, which requires a live vitest worker
// context and throws when imported from a plain script (as `fixtures:update`
// does via `tsx`). The stub below only needs to satisfy `extractSelection`'s
// `FigmaAPI["variables"]` shape.
import {
  extractSelection,
  type ExtractionResult,
} from "@figma-exporter/plugin/src/extractor/index.js";
import type {
  FigmaAPI,
  FigmaVariable,
  FigmaVariableCollection,
} from "@figma-exporter/plugin/src/extractor/types.js";
import { resetAutoIds } from "@figma-exporter/plugin/src/test/nodeBuilders.js";
import type { FixtureScenario } from "./scenario.js";

function buildVariablesApi(
  variables: Record<string, FigmaVariable>,
  variableCollections: Record<string, FigmaVariableCollection>,
): FigmaAPI["variables"] {
  return {
    getVariableByIdAsync: async (id: string) => variables[id] ?? null,
    getVariableCollectionByIdAsync: async (id: string) => variableCollections[id] ?? null,
  };
}

export async function runScenario(scenario: FixtureScenario): Promise<ExtractionResult> {
  resetAutoIds();
  const selection = scenario.buildSelection();

  const figma: FigmaAPI = {
    variables: buildVariablesApi(scenario.variables ?? {}, scenario.variableCollections ?? {}),
  };

  return extractSelection(figma, selection, {
    fileKey: scenario.fileKey,
    version: scenario.version,
  });
}
