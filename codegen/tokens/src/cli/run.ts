// CLI orchestration (migration plan, stage 7.1/7.3): wires the input,
// model, and emit layers into the actual `codegen-tokens` command --
// load, validate policy freshness, triage `unresolved[]`, build the model,
// generate Kotlin, then either write it, report it (--dry-run), or diff it
// against the existing output (--check, the same doctrine as
// `scripts/verify-generated.mjs`).
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { loadTokenDocument } from "../input/load.js";
import { assertPolicyFresh, warnAboutUnmatchedPolicyPatterns } from "../input/policy.js";
import { assertNoUnresolvedFailures } from "../input/unresolved.js";
import { buildTokenModel } from "../model/build.js";
import { generateKotlinFiles, type KotlinFile } from "../emit/kotlin.js";
import { CliArgError, HELP_TEXT, parseArgs, type CliOptions } from "./args.js";

export interface CliIo {
  stdout: (message: string) => void;
  stderr: (message: string) => void;
}

const defaultIo: CliIo = {
  stdout: (m) => console.log(m),
  stderr: (m) => console.error(m),
};

/** Runs the CLI end-to-end for already-tokenized `argv`. Returns the process exit code. */
export async function runCli(argv: readonly string[], io: CliIo = defaultIo): Promise<number> {
  let options: CliOptions;
  try {
    options = parseArgs(argv);
  } catch (error) {
    if (error instanceof CliArgError) {
      io.stderr(error.message);
      return error.message === HELP_TEXT ? 0 : 1;
    }
    throw error;
  }

  try {
    const document = await loadTokenDocument(options.input);
    assertPolicyFresh(document.policy, options.input);
    warnAboutUnmatchedPolicyPatterns(document.policy, io.stderr);
    assertNoUnresolvedFailures(document.unresolved, options.onUnresolved, io.stderr);

    const model = buildTokenModel(document);
    const files = generateKotlinFiles(model, {
      packageName: options.packageName,
      excludeModePattern: options.excludeMode,
      classPrefix: options.prefix,
    });

    if (options.check) {
      return await checkAgainstDisk(files, options.output, io);
    }
    if (options.dryRun) {
      for (const file of files)
        io.stdout(`would write ${path.join(options.output, file.relativePath)}`);
      io.stdout(`${files.length} file(s) would be generated (--dry-run, nothing written).`);
      return 0;
    }

    for (const file of files) {
      const dest = path.join(options.output, file.relativePath);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeFile(dest, file.contents, "utf8");
      io.stdout(`wrote ${dest}`);
    }
    io.stdout(`${files.length} file(s) generated.`);
    return 0;
  } catch (error) {
    io.stderr(error instanceof Error ? error.message : String(error));
    return 1;
  }
}

/**
 * Generates into memory and diffs against what's already on disk at
 * `outputDir`, without writing anything -- the same gate doctrine as
 * `scripts/verify-generated.mjs`: a mismatch means the output is stale
 * relative to its input and must be regenerated before landing.
 */
async function checkAgainstDisk(
  files: readonly KotlinFile[],
  outputDir: string,
  io: CliIo,
): Promise<number> {
  let stale = false;
  for (const file of files) {
    const dest = path.join(outputDir, file.relativePath);
    let onDisk: string | undefined;
    try {
      onDisk = await readFile(dest, "utf8");
    } catch {
      onDisk = undefined;
    }
    if (onDisk !== file.contents) {
      stale = true;
      io.stderr(`stale or missing: ${dest}`);
    }
  }
  if (stale) {
    io.stderr("output is stale -- run without --check to regenerate.");
    return 1;
  }
  io.stdout(`${files.length} file(s) are up to date.`);
  return 0;
}
