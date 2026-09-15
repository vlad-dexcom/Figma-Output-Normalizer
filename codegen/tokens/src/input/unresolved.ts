// Behaviour on `unresolved[]` entries (migration plan, stage 2.5).
//
// `unresolved[]` is not a reference list of oddities to skim — the schema's
// own contract is "a variable must never be silently dropped", so every
// entry here is a variable this generator would otherwise pretend does not
// exist. What to do about one depends entirely on its `reason`: some are
// expected and routine, some are exactly the kind of silent gap this
// project exists to prevent. The table below is the plan's default; a CLI
// flag (`--on-unresolved`, wired in the CLI stage) may override it per
// reason for a specific run.
import type { UnresolvedToken } from "@figma-normalizator/schema";

export type UnresolvedReason = UnresolvedToken["reason"];

export type UnresolvedAction = "silent" | "warn" | "fail";

/**
 * Default action per reason code.
 *
 * - `excluded-by-policy`: the variable itself was excluded — expected, the
 *   policy is doing its job.
 * - `excluded-collection-alias`: resolved, but through a policy-excluded
 *   collection, so it fell back to a literal — a documented, deliberate
 *   fallback, but one worth a human noticing.
 * - `missing-alias-target`, `unresolvable-alias-chain`, `unsupported-value`:
 *   genuine gaps — a variable this generator cannot represent at all. These
 *   fail by default so they cannot pass through unnoticed; a run that
 *   genuinely expects them (e.g. a first pass over a messy file) must opt
 *   in explicitly via `--on-unresolved`.
 */
export const DEFAULT_UNRESOLVED_ACTIONS: Readonly<Record<UnresolvedReason, UnresolvedAction>> = {
  "excluded-by-policy": "silent",
  "excluded-collection-alias": "warn",
  "missing-alias-target": "fail",
  "unresolvable-alias-chain": "fail",
  "unsupported-value": "fail",
};

export type UnresolvedActionOverrides = Partial<Record<UnresolvedReason, UnresolvedAction>>;

export interface UnresolvedTriage {
  warnings: UnresolvedToken[];
  failures: UnresolvedToken[];
}

/** Sorts `unresolved` into warnings and failures per {@link DEFAULT_UNRESOLVED_ACTIONS} (or `overrides`). */
export function triageUnresolved(
  unresolved: readonly UnresolvedToken[],
  overrides: UnresolvedActionOverrides = {},
): UnresolvedTriage {
  const warnings: UnresolvedToken[] = [];
  const failures: UnresolvedToken[] = [];
  for (const entry of unresolved) {
    const action = overrides[entry.reason] ?? DEFAULT_UNRESOLVED_ACTIONS[entry.reason];
    if (action === "fail") {
      failures.push(entry);
    } else if (action === "warn") {
      warnings.push(entry);
    }
    // "silent": intentionally not recorded anywhere, per its whole point.
  }
  return { warnings, failures };
}

function describeEntry(entry: UnresolvedToken): string {
  const location = `[${entry.collection ?? "?"}] ${entry.path}`;
  const detail = entry.detail ? ` — ${entry.detail}` : "";
  return `${location} (${entry.reason})${detail}`;
}

export class UnresolvedTokensError extends Error {
  constructor(public readonly failures: readonly UnresolvedToken[]) {
    super(UnresolvedTokensError.formatMessage(failures));
    this.name = "UnresolvedTokensError";
  }

  private static formatMessage(failures: readonly UnresolvedToken[]): string {
    const counts = new Map<string, number>();
    for (const entry of failures) counts.set(entry.reason, (counts.get(entry.reason) ?? 0) + 1);
    const summary = [...counts.entries()]
      .map(([reason, count]) => `${reason}: ${count}`)
      .join(", ");
    const shown = failures.slice(0, 10).map((e) => `  - ${describeEntry(e)}`);
    const more = failures.length > 10 ? [`  ... and ${failures.length - 10} more`] : [];
    return [
      `${failures.length} unresolved token(s) require action before code can be generated (${summary}):`,
      ...shown,
      ...more,
      "",
      "Use --on-unresolved=<reason>=<silent|warn|fail> to override the default action for a reason " +
        "code if this run genuinely expects it.",
    ].join("\n");
  }
}

/** Logs one line per warning-level entry via `warn` (defaults to `console.warn`). */
export function warnAboutUnresolved(
  warnings: readonly UnresolvedToken[],
  warn: (message: string) => void = console.warn,
): void {
  for (const entry of warnings) {
    warn(`unresolved token ${describeEntry(entry)}`);
  }
}

/**
 * Triages `unresolved`, warns for `warn`-level entries, and throws a single
 * {@link UnresolvedTokensError} if any entry triaged to `fail`.
 */
export function assertNoUnresolvedFailures(
  unresolved: readonly UnresolvedToken[],
  overrides: UnresolvedActionOverrides = {},
  warn: (message: string) => void = console.warn,
): void {
  const { warnings, failures } = triageUnresolved(unresolved, overrides);
  warnAboutUnresolved(warnings, warn);
  if (failures.length > 0) {
    throw new UnresolvedTokensError(failures);
  }
}
