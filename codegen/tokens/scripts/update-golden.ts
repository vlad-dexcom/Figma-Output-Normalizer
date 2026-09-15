#!/usr/bin/env node
// Regenerates testdata/golden/<case>/ for every case in golden.config.ts, by
// running the real Kotlin emitter against each case's input and freezing
// its output. For *deliberate* use only -- after intentionally changing
// emitter behavior and reviewing the new output for correctness -- never
// run automatically in CI. Mirrors fixtures/scripts/update-fixtures.ts.
//
// Usage: npm run golden:update --workspace=@figma-normalizator/codegen-tokens
import { mkdir, readdir, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTokenDocument } from "../src/input/load.js";
import { buildTokenModel } from "../src/model/build.js";
import { generateKotlinFiles } from "../src/emit/kotlin.js";
import { GOLDEN_CASES } from "../src/golden.config.js";

const GOLDEN_ROOT = path.join(import.meta.dirname, "../testdata/golden");

async function main(): Promise<void> {
  for (const goldenCase of GOLDEN_CASES) {
    const caseDir = path.join(GOLDEN_ROOT, goldenCase.name);
    await rm(caseDir, { recursive: true, force: true });

    const document = await loadTokenDocument(goldenCase.inputPath);
    const model = buildTokenModel(document);
    const files = generateKotlinFiles(model, goldenCase.options);

    for (const file of files) {
      const dest = path.join(caseDir, file.relativePath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.contents, "utf8");
    }
    console.log(`wrote ${files.length} file(s) to testdata/golden/${goldenCase.name}/`);
  }

  // Nothing but this script's own output should live under testdata/golden/.
  const entries = await readdir(GOLDEN_ROOT).catch(() => []);
  const known = new Set(GOLDEN_CASES.map((c) => c.name));
  for (const entry of entries) {
    if (!known.has(entry)) {
      console.warn(`testdata/golden/${entry} is not in golden.config.ts -- consider removing it.`);
    }
  }
}

main().catch((err: unknown) => {
  console.error(err);
  process.exitCode = 1;
});
