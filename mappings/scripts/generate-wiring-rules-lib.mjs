// Shared logic for generating mappings/src/generated/wiring-rules.json from
// mappings/wiring-rules/wiring-rules.yaml. Used by both the
// `generate:wiring-rules` CLI script and the "generated JSON is not stale"
// vitest check, so the two can never drift apart from each other.
//
// Same build-time-parse rationale as generate-map-lib.mjs: the plugin bundle
// runs inside Figma's plugin sandbox (no Node `fs`, and shipping a YAML
// parser into the sandbox to parse a file that never changes at runtime
// would be silly).
import yaml from "js-yaml";
import prettier from "prettier";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const yamlPath = path.join(here, "..", "wiring-rules", "wiring-rules.yaml");
export const generatedFilePath = path.join(here, "..", "src", "generated", "wiring-rules.json");

/** Parses wiring-rules.yaml and returns the generated JSON file contents (as a string). */
export async function generateWiringRulesJson() {
  const raw = await readFile(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  const json = JSON.stringify(parsed, null, 2) + "\n";
  return await prettier.format(json, { filepath: generatedFilePath });
}
