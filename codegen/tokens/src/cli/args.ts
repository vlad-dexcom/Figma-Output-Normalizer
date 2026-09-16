// CLI argument parsing (migration plan, stage 7.1). No Figma keys here at
// all -- unlike the old generator's CLI (--token/--token-file/--file-key),
// this one only ever configures the shape of an already-produced Token IR
// export and where the generated Kotlin goes.
import type { UnresolvedActionOverrides, UnresolvedReason } from "../input/unresolved.js";

export interface CliOptions {
  /** Path to the *.tokens.json export to read. */
  input: string;
  /** Directory generated Kotlin files are written under (or checked against, with --check). */
  output: string;
  /** The Kotlin package every generated file declares. */
  packageName: string;
  /** Prepended to every generated root class name; default none. */
  prefix?: string;
  /** Modes matching this pattern get no factory function (e.g. a Kotlin/Android-only build). */
  excludeMode?: RegExp;
  /** Per-reason overrides for the default unresolved-token triage. */
  onUnresolved: UnresolvedActionOverrides;
  /**
   * "flat" (default): one file per collection, branches nested as inner
   * classes. "legacy": one file per top-level branch in its own
   * subpackage plus a root aggregator file per collection, matching the
   * old (retired) generator's structural shape -- for consumers that
   * still depend on that package layout (see docs/BACKLOG.md G13).
   */
  layout: "flat" | "legacy";
  /** Generate into memory and report what would be written, without touching disk. */
  dryRun: boolean;
  /** Generate into memory and diff against --output; exits non-zero on any difference, writes nothing. */
  check: boolean;
}

const UNRESOLVED_REASONS: readonly UnresolvedReason[] = [
  "excluded-by-policy",
  "excluded-collection-alias",
  "missing-alias-target",
  "unresolvable-alias-chain",
  "unsupported-value",
];

const UNRESOLVED_ACTIONS = new Set(["silent", "warn", "fail"]);

export class CliArgError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CliArgError";
  }
}

function parseOnUnresolved(spec: string): [UnresolvedReason, "silent" | "warn" | "fail"] {
  const eq = spec.indexOf("=");
  if (eq < 0) {
    throw new CliArgError(
      `--on-unresolved expects "<reason>=<silent|warn|fail>", got ${JSON.stringify(spec)}`,
    );
  }
  const reason = spec.slice(0, eq);
  const action = spec.slice(eq + 1);
  if (!UNRESOLVED_REASONS.includes(reason as UnresolvedReason)) {
    throw new CliArgError(
      `--on-unresolved: unknown reason ${JSON.stringify(reason)} (expected one of ` +
        `${UNRESOLVED_REASONS.join(", ")})`,
    );
  }
  if (!UNRESOLVED_ACTIONS.has(action)) {
    throw new CliArgError(
      `--on-unresolved: unknown action ${JSON.stringify(action)} for reason ${JSON.stringify(reason)} ` +
        `(expected one of silent, warn, fail)`,
    );
  }
  return [reason as UnresolvedReason, action as "silent" | "warn" | "fail"];
}

/** Parses `argv` (already stripped of `node`/script-path entries) into {@link CliOptions}. */
export function parseArgs(argv: readonly string[]): CliOptions {
  let input: string | undefined;
  let output: string | undefined;
  let packageName: string | undefined;
  let prefix: string | undefined;
  let excludeMode: RegExp | undefined;
  let dryRun = false;
  let check = false;
  let layout: "flat" | "legacy" = "flat";
  const onUnresolved: UnresolvedActionOverrides = {};

  const next = (flag: string, i: number): string => {
    const value = argv[i + 1];
    if (value === undefined) {
      throw new CliArgError(`${flag} requires a value`);
    }
    return value;
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i] as string;
    switch (arg) {
      case "--input":
        input = next(arg, i++);
        break;
      case "--output":
        output = next(arg, i++);
        break;
      case "--package":
        packageName = next(arg, i++);
        break;
      case "--prefix":
        prefix = next(arg, i++);
        break;
      case "--exclude-mode":
        excludeMode = new RegExp(next(arg, i++));
        break;
      case "--on-unresolved": {
        const [reason, action] = parseOnUnresolved(next(arg, i++));
        onUnresolved[reason] = action;
        break;
      }
      case "--dry-run":
        dryRun = true;
        break;
      case "--check":
        check = true;
        break;
      case "--layout": {
        const value = next(arg, i++);
        if (value !== "flat" && value !== "legacy") {
          throw new CliArgError(`--layout expects "flat" or "legacy", got ${JSON.stringify(value)}`);
        }
        layout = value;
        break;
      }
      case "--help":
      case "-h":
        throw new CliArgError(HELP_TEXT);
      default:
        throw new CliArgError(`unknown argument: ${arg}\n\n${HELP_TEXT}`);
    }
  }

  const missing: string[] = [];
  if (input === undefined) missing.push("--input");
  if (output === undefined) missing.push("--output");
  if (packageName === undefined) missing.push("--package");
  if (missing.length > 0) {
    throw new CliArgError(`missing required argument(s): ${missing.join(", ")}\n\n${HELP_TEXT}`);
  }
  if (dryRun && check) {
    throw new CliArgError("--dry-run and --check are mutually exclusive");
  }

  return {
    input: input as string,
    output: output as string,
    packageName: packageName as string,
    prefix,
    excludeMode,
    onUnresolved,
    layout,
    dryRun,
    check,
  };
}

export const HELP_TEXT = `Usage: codegen-tokens --input <path> --output <dir> --package <name> [options]

Generates Kotlin design-token source files from a schema/tokens/v1 export
(*.tokens.json) produced by the Figma plugin. Never talks to Figma itself.

Required:
  --input <path>       Path to the *.tokens.json export to read.
  --output <dir>        Directory to write generated Kotlin files into.
  --package <name>       Kotlin package declared by every generated file.

Options:
  --prefix <str>          Prepended to every generated root class name.
  --exclude-mode <regex>  Modes matching this pattern get no factory function
                          (e.g. "ios" to skip iOS-only modes in a Kotlin build).
  --on-unresolved <reason>=<silent|warn|fail>
                          Override the default triage action for one
                          unresolved-token reason code. Repeatable.
  --layout <flat|legacy>  "flat" (default): one file per collection.
                          "legacy": one file per top-level branch plus a
                          root aggregator per collection, matching the old
                          (retired) generator's package layout, for
                          consumers still coupled to it.
  --dry-run               Report what would be generated without writing.
  --check                 Generate into memory and diff against --output;
                          exits non-zero on any difference, writes nothing.
  --help, -h              Show this help text.
`;
