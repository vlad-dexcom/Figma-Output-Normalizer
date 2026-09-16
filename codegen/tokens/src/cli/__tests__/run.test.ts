import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { runCli } from "../run.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

function capturingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    stdout: (m: string) => out.push(m),
    stderr: (m: string) => err.push(m),
    out,
    err,
  };
}

describe("runCli — real-world fixture", () => {
  let outDir: string;

  beforeEach(async () => {
    outDir = await mkdtemp(path.join(os.tmpdir(), "codegen-tokens-cli-"));
  });

  afterEach(async () => {
    await rm(outDir, { recursive: true, force: true });
  });

  const baseArgs = (extra: string[] = []) => [
    "--input",
    REAL_WORLD_TOKENS_PATH,
    "--output",
    outDir,
    "--package",
    "com.dexcom.tokens",
    "--exclude-mode",
    "ios",
    "--on-unresolved",
    "unsupported-value=warn",
    ...extra,
  ];

  it("succeeds by default now that this fixture has no more unsupported-value entries", async () => {
    // Was "fails by default because this fixture has real unsupported-value
    // entries" before the COMPOSE_COLOR alias-typed-opacity fix (BACKLOG
    // G14): the fixture's 168 unsupported-value entries were all fixed by
    // re-exporting with the fixed plugin, leaving only
    // excluded-collection-alias entries, which triage to warnings (not
    // failures) by default.
    const io = capturingIo();
    const code = await runCli(
      [
        "--input",
        REAL_WORLD_TOKENS_PATH,
        "--output",
        outDir,
        "--package",
        "com.dexcom.tokens",
        "--exclude-mode",
        "ios",
      ],
      io,
    );
    expect(code).toBe(0);
    expect(io.out.some((m) => m.includes("file(s) generated"))).toBe(true);
  });

  it("fails when an override escalates a real reason code (excluded-collection-alias) to a failure", async () => {
    const io = capturingIo();
    const code = await runCli(
      [
        "--input",
        REAL_WORLD_TOKENS_PATH,
        "--output",
        outDir,
        "--package",
        "com.dexcom.tokens",
        "--exclude-mode",
        "ios",
        "--on-unresolved",
        "excluded-collection-alias=fail",
      ],
      io,
    );
    expect(code).toBe(1);
    expect(io.err.some((m) => m.includes("unresolved token(s) require action"))).toBe(true);
  });

  it("writes one Kotlin file per non-empty collection when the override is supplied", async () => {
    const io = capturingIo();
    const code = await runCli(baseArgs(), io);
    expect(code).toBe(0);
    const written = await readFile(path.join(outDir, "com/dexcom/tokens/Primitives.kt"), "utf8");
    expect(written).toContain("data class Primitives");
    expect(io.out.some((m) => m.includes("4 file(s) generated"))).toBe(true);
  });

  it("--dry-run reports files without writing them", async () => {
    const io = capturingIo();
    const code = await runCli(baseArgs(["--dry-run"]), io);
    expect(code).toBe(0);
    await expect(
      readFile(path.join(outDir, "com/dexcom/tokens/Primitives.kt"), "utf8"),
    ).rejects.toThrow();
    expect(io.out.some((m) => m.includes("would be generated"))).toBe(true);
  });

  it("--check fails when nothing has been written yet, then succeeds after a real generation", async () => {
    const first = capturingIo();
    expect(await runCli(baseArgs(["--check"]), first)).toBe(1);
    expect(first.err.some((m) => m.includes("stale or missing"))).toBe(true);

    expect(await runCli(baseArgs(), capturingIo())).toBe(0);

    const second = capturingIo();
    expect(await runCli(baseArgs(["--check"]), second)).toBe(0);
    expect(second.out.some((m) => m.includes("up to date"))).toBe(true);
  });

  it("two consecutive generations are byte-for-byte identical (determinism)", async () => {
    await runCli(baseArgs(), capturingIo());
    const firstRun = await readFile(path.join(outDir, "com/dexcom/tokens/Components.kt"), "utf8");
    await rm(outDir, { recursive: true, force: true });
    outDir = await mkdtemp(path.join(os.tmpdir(), "codegen-tokens-cli-"));
    await runCli(baseArgs(), capturingIo());
    const secondRun = await readFile(path.join(outDir, "com/dexcom/tokens/Components.kt"), "utf8");
    expect(secondRun).toBe(firstRun);
  });
});
