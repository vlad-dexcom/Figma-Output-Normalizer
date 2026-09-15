// Shared list of golden-output cases (migration plan, stage 8.2), used by
// both `scripts/update-golden.ts` (freezes output -- deliberate use only,
// after reviewing the diff) and `src/__tests__/golden.test.ts` (asserts
// current output still matches the frozen files). Keeping one list avoids
// the update script and the test silently drifting apart on what "golden"
// covers.
import path from "node:path";
import type { KotlinEmitOptions } from "./emit/kotlin.js";

export interface GoldenCase {
  /** kebab-case name; frozen output lives under testdata/golden/<name>/. */
  name: string;
  /** Path to the *.tokens.json input, relative to this package's root. */
  inputPath: string;
  options: KotlinEmitOptions;
}

const PACKAGE_ROOT = path.join(import.meta.dirname, "..");

export const GOLDEN_CASES: readonly GoldenCase[] = [
  {
    name: "minimal",
    inputPath: path.join(PACKAGE_ROOT, "testdata/minimal.tokens.json"),
    options: { packageName: "com.example.tokens" },
  },
  {
    name: "real-world",
    inputPath: path.join(
      PACKAGE_ROOT,
      "../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-88d0431a4019ec4b.tokens.json",
    ),
    options: { packageName: "com.dexcom.tokens", excludeModePattern: /ios/i },
  },
];
