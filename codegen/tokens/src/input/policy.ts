// The policy staleness gate (migration plan, stage 2.4).
//
// The generator no longer decides what is in scope — the plugin already
// applied `mappings/collections-policy.yaml` before producing the export,
// and echoed the result into `document.policy`. All this module does is
// check that echo against the *current* policy in the repository: if they
// disagree, the export was taken before the policy last changed, and
// generating code from it would silently regenerate stale output. This is
// the same doctrine `scripts/verify-generated.mjs` enforces for the other
// generated artifacts, applied to the one generated artifact that lives
// outside the repo (the Figma export itself).
//
// `policy.unmatchedPatterns` is a different kind of signal — not staleness,
// but a pattern that plausibly typo'd — so it is surfaced as a warning
// rather than folded into the fatal mismatch list.
import { collectionsPolicy } from "@figma-normalizator/mappings";
import type { PolicyReport } from "@figma-normalizator/schema";

export interface PolicyStalenessResult {
  stale: boolean;
  /** Human-readable descriptions of each field that disagreed, empty when `stale` is false. */
  mismatches: string[];
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((value, index) => value === sortedB[index]);
}

/**
 * Compares an export's echoed `policy` against the repository's current
 * `mappings/collections-policy.yaml`. Order-insensitive: the document lists
 * patterns as it applied them, the policy file lists them as authored, and
 * neither order is meaningful content the way e.g. `collection.modes` is.
 */
export function checkPolicyStaleness(policy: PolicyReport): PolicyStalenessResult {
  const expectedExcludedCollections = collectionsPolicy.exclude ?? [];
  const expectedExcludedBranches = collectionsPolicy["exclude-branches"] ?? [];
  const expectedExcludeRemoteCollections = collectionsPolicy["exclude-remote-collections"] ?? true;

  const mismatches: string[] = [];
  if (!sameSet(policy.excludedCollections, expectedExcludedCollections)) {
    mismatches.push(
      `policy.excludedCollections ${JSON.stringify(policy.excludedCollections)} does not match ` +
        `the repository's current "exclude" ${JSON.stringify(expectedExcludedCollections)} ` +
        `(mappings/collections-policy.yaml)`,
    );
  }
  if (!sameSet(policy.excludedBranches, expectedExcludedBranches)) {
    mismatches.push(
      `policy.excludedBranches ${JSON.stringify(policy.excludedBranches)} does not match the ` +
        `repository's current "exclude-branches" ${JSON.stringify(expectedExcludedBranches)} ` +
        `(mappings/collections-policy.yaml)`,
    );
  }
  const actualExcludeRemoteCollections = policy.excludeRemoteCollections ?? true;
  if (actualExcludeRemoteCollections !== expectedExcludeRemoteCollections) {
    mismatches.push(
      `policy.excludeRemoteCollections (${actualExcludeRemoteCollections}) does not match the ` +
        `repository's current "exclude-remote-collections" (${expectedExcludeRemoteCollections}) ` +
        `(mappings/collections-policy.yaml)`,
    );
  }

  return { stale: mismatches.length > 0, mismatches };
}

/** Throws when `policy` is stale relative to the repository's current policy. */
export function assertPolicyFresh(policy: PolicyReport, sourceLabel: string): void {
  const result = checkPolicyStaleness(policy);
  if (result.stale) {
    throw new Error(
      `${sourceLabel}'s policy is stale relative to mappings/collections-policy.yaml:\n` +
        result.mismatches.map((m) => `  - ${m}`).join("\n") +
        `\n\nRe-export the tokens from the Figma plugin (or, if the policy file just changed and ` +
        `the export has not been retaken yet, that is exactly the case this check exists to catch).`,
    );
  }
}

/**
 * Reports patterns that matched nothing when the export was produced —
 * plausibly a typo, but not necessarily wrong, so this warns rather than
 * throwing. `warn` is injectable for tests; defaults to `console.warn`.
 */
export function warnAboutUnmatchedPolicyPatterns(
  policy: PolicyReport,
  warn: (message: string) => void = console.warn,
): void {
  if (policy.unmatchedPatterns.length > 0) {
    warn(
      `${policy.unmatchedPatterns.length} collections-policy pattern(s) matched nothing in this ` +
        `export: ${JSON.stringify(policy.unmatchedPatterns)} — check for a typo in ` +
        `mappings/collections-policy.yaml.`,
    );
  }
}
