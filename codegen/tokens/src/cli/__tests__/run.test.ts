import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
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

  it("--exclude-mode ios drops the mixed-case 'iOS' mode too, so one pattern covers every collection", async () => {
    // The real file names the same semantic mode inconsistently: primitives
    // declares "iOS", typography declares "ios". A case-sensitive match
    // would silently keep `primitivesIOS(...)` in an Android-only build.
    const io = capturingIo();
    expect(await runCli(baseArgs(), io)).toBe(0);
    const primitives = await readFile(path.join(outDir, "com/dexcom/tokens/Primitives.kt"), "utf8");
    const typography = await readFile(path.join(outDir, "com/dexcom/tokens/Typography.kt"), "utf8");
    expect(primitives).toContain("fun primitivesAndroid(): Primitives =");
    expect(primitives).not.toMatch(/fun primitivesIOS\(/i);
    expect(typography).toMatch(/fun typographyAndroid\(/);
    expect(typography).not.toMatch(/fun typographyIos\(/i);
  });

  it("deletes previously-generated files that this run no longer produces, but never hand-written ones", async () => {
    // Generating with --layout legacy then re-running flat is the worst
    // case: every one of the legacy layout's files is orphaned at once.
    // Without pruning they stay on disk and keep compiling into the
    // consuming app, so a token deleted in Figma never actually dies.
    expect(await runCli(baseArgs(["--layout", "legacy"]), capturingIo())).toBe(0);
    const legacyFile = path.join(outDir, "com/dexcom/tokens/base/color/Color.kt");
    expect(await readFile(legacyFile, "utf8")).toContain("data class Color");

    const handWritten = path.join(outDir, "com/dexcom/tokens/base/Handwritten.kt");
    await writeFile(handWritten, "// hand-written, not ours to delete\n", "utf8");

    const io = capturingIo();
    expect(await runCli(baseArgs(), io)).toBe(0);
    await expect(readFile(legacyFile, "utf8")).rejects.toThrow();
    expect(await readFile(handWritten, "utf8")).toContain("hand-written");
    expect(await readFile(path.join(outDir, "com/dexcom/tokens/Base.kt"), "utf8")).toContain(
      "data class Base",
    );
    expect(io.out.some((m) => m.includes("stale file(s) deleted"))).toBe(true);
    // The hand-written file keeps its directory alive; the purely-generated
    // ones below it are gone.
    await expect(readdir(path.join(outDir, "com/dexcom/tokens/base/color"))).rejects.toThrow();
  });

  it("--check fails on a previously-generated file this run no longer produces", async () => {
    expect(await runCli(baseArgs(), capturingIo())).toBe(0);
    expect(await runCli(baseArgs(["--check"]), capturingIo())).toBe(0);

    const orphan = path.join(outDir, "com/dexcom/tokens/Deleted.kt");
    await writeFile(
      orphan,
      await readFile(path.join(outDir, "com/dexcom/tokens/Base.kt"), "utf8"),
      "utf8",
    );

    const io = capturingIo();
    expect(await runCli(baseArgs(["--check"]), io)).toBe(1);
    expect(io.err.some((m) => m.includes("stale (no longer generated)"))).toBe(true);
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
