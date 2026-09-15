// Golden-output test (migration plan, stage 8.2): asserts the emitter's
// current output for each case in golden.config.ts still matches its
// frozen testdata/golden/<name>/ files byte-for-byte. On an intentional
// emitter change, regenerate with `npm run golden:update` and review the
// diff before committing -- the same doctrine as fixtures/'s corpus.
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { GOLDEN_CASES } from "../golden.config.js";
import { loadTokenDocument } from "../input/load.js";
import { buildTokenModel } from "../model/build.js";
import { generateKotlinFiles } from "../emit/kotlin.js";

const GOLDEN_ROOT = path.join(import.meta.dirname, "../../testdata/golden");

describe("golden Kotlin output", () => {
  for (const goldenCase of GOLDEN_CASES) {
    it(`${goldenCase.name}: matches its frozen testdata/golden/${goldenCase.name}/ output`, async () => {
      const document = await loadTokenDocument(goldenCase.inputPath);
      const model = buildTokenModel(document);
      const files = generateKotlinFiles(model, goldenCase.options);

      const caseDir = path.join(GOLDEN_ROOT, goldenCase.name);
      for (const file of files) {
        const frozen = await readFile(path.join(caseDir, file.relativePath), "utf8");
        expect(file.contents, `${goldenCase.name}/${file.relativePath}`).toBe(frozen);
      }

      // No stale frozen file left over from a since-renamed/removed collection.
      const frozenPaths = await listFilesRecursive(caseDir);
      const generatedPaths = new Set(files.map((f) => f.relativePath));
      expect(frozenPaths.sort()).toEqual([...generatedPaths].sort());
    });
  }
});

async function listFilesRecursive(dir: string, prefix = ""): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const results: string[] = [];
  for (const entry of entries) {
    const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      results.push(...(await listFilesRecursive(path.join(dir, entry.name), relative)));
    } else {
      results.push(relative);
    }
  }
  return results;
}
