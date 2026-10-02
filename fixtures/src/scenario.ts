// Shared shape for a fixture corpus scenario: a mock Figma node tree
// (constructed with the extractor's own `../plugin/src/test/*` builders)
// plus everything needed to feed it through `extractSelection` the same way
// the real plugin would.
import { fileURLToPath } from "node:url";
import type {
  FigmaNode,
  FigmaVariable,
  FigmaVariableCollection,
} from "@figma-exporter/plugin/src/extractor/types.js";

export interface FixtureScenario {
  /** kebab-case scenario name; must match its folder name under src/corpus/. */
  name: string;
  /** One-line description of what this scenario exercises, surfaced in test output and README. */
  description: string;
  fileKey: string;
  version: string;
  /**
   * Builds the root mock node tree(s) passed as the plugin selection. Called
   * fresh for every run (rather than built once at module load) so the
   * shared auto-incrementing mock id counter in `nodeBuilders.ts` can be
   * reset first and produce identical ids run over run.
   */
  buildSelection(): FigmaNode[];
  variables?: Record<string, FigmaVariable>;
  variableCollections?: Record<string, FigmaVariableCollection>;
}

/** Absolute path to `fixtures/src/corpus/<scenario.name>/expected.ir.json`. */
export function expectedIrPath(scenario: Pick<FixtureScenario, "name">): string {
  return fileURLToPath(new URL(`./corpus/${scenario.name}/expected.ir.json`, import.meta.url));
}
