import { describe, expect, it, vi } from "vitest";
import { collectionsPolicy } from "@figma-normalizator/mappings";
import type { PolicyReport } from "@figma-normalizator/schema";
import {
  assertPolicyFresh,
  checkPolicyStaleness,
  warnAboutUnmatchedPolicyPatterns,
} from "../policy.js";

function freshPolicy(overrides: Partial<PolicyReport> = {}): PolicyReport {
  return {
    excludedCollections: collectionsPolicy.exclude ?? [],
    excludedBranches: collectionsPolicy["exclude-branches"] ?? [],
    excludeRemoteCollections: collectionsPolicy["exclude-remote-collections"] ?? true,
    unmatchedPatterns: [],
    ...overrides,
  };
}

describe("checkPolicyStaleness", () => {
  it("is not stale when the document's policy matches the current collections policy", () => {
    const result = checkPolicyStaleness(freshPolicy());
    expect(result).toEqual({ stale: false, mismatches: [] });
  });

  it("ignores pattern order — order is not meaningful content here", () => {
    const result = checkPolicyStaleness(
      freshPolicy({ excludedCollections: [...(collectionsPolicy.exclude ?? [])].reverse() }),
    );
    expect(result.stale).toBe(false);
  });

  it("flags a mismatched excludedCollections list as stale", () => {
    const result = checkPolicyStaleness(freshPolicy({ excludedCollections: ["something-else"] }));
    expect(result.stale).toBe(true);
    expect(result.mismatches.some((m) => m.includes("excludedCollections"))).toBe(true);
  });

  it("flags a mismatched excludeRemoteCollections flag as stale", () => {
    const result = checkPolicyStaleness(freshPolicy({ excludeRemoteCollections: false }));
    expect(result.stale).toBe(true);
    expect(result.mismatches.some((m) => m.includes("excludeRemoteCollections"))).toBe(true);
  });

  it("does not consider unmatchedPatterns as staleness — that is a separate warning", () => {
    const result = checkPolicyStaleness(freshPolicy({ unmatchedPatterns: ["typo-*"] }));
    expect(result.stale).toBe(false);
  });
});

describe("assertPolicyFresh", () => {
  it("does not throw for a fresh policy", () => {
    expect(() => assertPolicyFresh(freshPolicy(), "doc.tokens.json")).not.toThrow();
  });

  it("throws with all mismatches listed for a stale policy", () => {
    expect(() =>
      assertPolicyFresh(
        freshPolicy({ excludedCollections: ["something-else"] }),
        "doc.tokens.json",
      ),
    ).toThrow(/stale relative to mappings\/collections-policy\.yaml/);
  });
});

describe("warnAboutUnmatchedPolicyPatterns", () => {
  it("warns when unmatchedPatterns is non-empty", () => {
    const warn = vi.fn();
    warnAboutUnmatchedPolicyPatterns(freshPolicy({ unmatchedPatterns: ["typo-*"] }), warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("typo-*");
  });

  it("does not warn when unmatchedPatterns is empty", () => {
    const warn = vi.fn();
    warnAboutUnmatchedPolicyPatterns(freshPolicy(), warn);
    expect(warn).not.toHaveBeenCalled();
  });
});
