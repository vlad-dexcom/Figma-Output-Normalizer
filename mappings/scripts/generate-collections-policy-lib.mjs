// Shared logic for generating mappings/src/generated/collections-policy.json
// from mappings/collections-policy.yaml. Used by both the
// `generate:collections-policy` CLI script and the "generated JSON is not
// stale" vitest check, so the two can never drift apart from each other.
//
// Same build-time-parse rationale as generate-map-lib.mjs: the plugin bundle
// runs inside Figma's plugin sandbox, which has no filesystem and no network
// access, so a policy file has to be bundled rather than read at runtime.
import yaml from "js-yaml";
import prettier from "prettier";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const yamlPath = path.join(here, "..", "collections-policy.yaml");
export const generatedFilePath = path.join(
  here,
  "..",
  "src",
  "generated",
  "collections-policy.json",
);

/** Parses collections-policy.yaml and returns the generated JSON file contents (as a string). */
export async function generateCollectionsPolicyJson() {
  const raw = await readFile(yamlPath, "utf8");
  const parsed = yaml.load(raw);
  const json = JSON.stringify(parsed, null, 2) + "\n";
  return await prettier.format(json, { filepath: generatedFilePath });
}
