#!/usr/bin/env node
// Regenerates mappings/src/generated/wiring-rules.json from
// mappings/wiring-rules/wiring-rules.yaml.
//
// Do NOT hand-edit the generated file: run `npm run generate:wiring-rules`
// (from the mappings/ package) after changing wiring-rules.yaml, then commit
// the diff.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import { generateWiringRulesJson, generatedFilePath } from "./generate-wiring-rules-lib.mjs";

async function main() {
  const contents = await generateWiringRulesJson();
  await writeFile(generatedFilePath, contents);
  console.log(`Wrote ${path.relative(process.cwd(), generatedFilePath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
