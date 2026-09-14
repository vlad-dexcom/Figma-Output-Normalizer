// Evaluates the collection/branch exclusion policy
// (`collections-policy.yaml`, pre-generated to JSON at build time) that the
// token export applies before resolving anything.
//
// This mirrors the platform generator's `configs/collections.toml`
// deliberately and precisely — same glob dialect, same case-insensitivity,
// same `<collection>/<branch>` vs bare-branch rule, same
// "patterns-that-match-nothing are reported" contract. Two pipelines
// disagreeing about what is in scope would be worse than either one being
// wrong, so the semantics are copied rather than reinvented.
import collectionsPolicyJson from "./generated/collections-policy.json" with { type: "json" };
import type { CollectionsPolicy, PolicyDecision, PolicyEvaluator } from "./types.js";

/** The parsed collections-policy.yaml, pre-generated to JSON at build time. */
export const collectionsPolicy = collectionsPolicyJson as unknown as CollectionsPolicy;

/**
 * Compiles one shell-style glob (`*`, `?`, `[seq]`) to an anchored, case
 * insensitive RegExp.
 *
 * Everything outside the three glob metacharacters is escaped, so a pattern
 * containing regex syntax (`.`, `+`, `(`) matches literally — a collection
 * genuinely named `base (v2)` must be excludable by writing its name, not by
 * writing a regex.
 */
export function globToRegExp(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i] as string;
    if (char === "*") {
      out += "[^]*";
    } else if (char === "?") {
      out += "[^]";
    } else if (char === "[") {
      const close = pattern.indexOf("]", i + 1);
      if (close === -1) {
        out += "\\[";
      } else {
        const body = pattern.slice(i + 1, close);
        // A leading `!` is the shell's negation syntax; RegExp spells it `^`.
        const negated = body.startsWith("!");
        out += `[${negated ? "^" : ""}${(negated ? body.slice(1) : body).replace(/\\/g, "\\\\")}]`;
        i = close;
      }
    } else {
      out += char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    }
  }
  return new RegExp(`^${out}$`, "i");
}

/** True when `value` matches `pattern` (case-insensitive shell glob). */
export function globMatches(pattern: string, value: string): boolean {
  return globToRegExp(pattern).test(value);
}

/**
 * Builds a stateful evaluator over the policy.
 *
 * It is stateful on purpose: it records which patterns actually matched
 * something, so the caller can report the ones that did not. A pattern that
 * silently matches nothing is the failure mode this design exists to
 * prevent — it looks like a working exclusion and behaves like a typo.
 */
export function createPolicyEvaluator(
  policy: CollectionsPolicy = collectionsPolicy,
): PolicyEvaluator {
  const excludeCollections = policy.exclude ?? [];
  const excludeBranches = policy["exclude-branches"] ?? [];
  const excludeRemote = policy["exclude-remote-collections"] ?? true;
  const used = new Set<string>();

  return {
    excludeRemoteCollections: excludeRemote,

    collection(name: string, remote: boolean): PolicyDecision {
      for (const pattern of excludeCollections) {
        if (globMatches(pattern, name)) {
          used.add(pattern);
          return { excluded: true, by: pattern, reason: `collection matches exclude "${pattern}"` };
        }
      }
      if (remote && excludeRemote) {
        return {
          excluded: true,
          by: "exclude-remote-collections",
          reason:
            "collection is imported from another Figma library and exclude-remote-collections is enabled",
        };
      }
      return { excluded: false };
    },

    /**
     * `path` is the full Figma variable name; only its FIRST segment is the
     * branch. A bare pattern means "this branch in every collection"
     * (`apple` is equivalent to the glob `*` + `/apple`); a pattern
     * containing `/` is matched as `<collection>/<branch>`.
     */
    branch(collection: string, path: string): PolicyDecision {
      const branch = path.split("/")[0] ?? "";
      for (const pattern of excludeBranches) {
        const matched = pattern.includes("/")
          ? globMatches(pattern, `${collection}/${branch}`)
          : globMatches(pattern, branch);
        if (matched) {
          used.add(pattern);
          return {
            excluded: true,
            by: pattern,
            reason: `branch "${branch}" matches exclude-branches "${pattern}"`,
          };
        }
      }
      return { excluded: false };
    },

    unmatchedPatterns(): string[] {
      return [...excludeCollections, ...excludeBranches].filter((p) => !used.has(p));
    },

    report(unmatched: string[]) {
      return {
        excludedCollections: [...excludeCollections],
        excludedBranches: [...excludeBranches],
        excludeRemoteCollections: excludeRemote,
        unmatchedPatterns: unmatched,
      };
    },
  };
}
