#!/usr/bin/env node
// Regenerates mappings/src/generated/collections-policy.json from
// mappings/collections-policy.yaml.
//
// Do NOT hand-edit the generated file: run
// `npm run generate:collections-policy` (from the mappings/ package) after
// changing collections-policy.yaml, then commit the diff.
import { writeFile } from "node:fs/promises";
import path from "node:path";
import {
  generateCollectionsPolicyJson,
  generatedFilePath,
} from "./generate-collections-policy-lib.mjs";

async function main() {
  const contents = await generateCollectionsPolicyJson();
  await writeFile(generatedFilePath, contents);
  console.log(`Wrote ${path.relative(process.cwd(), generatedFilePath)}`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
