import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import {
  generateCollectionsPolicyJson,
  generatedFilePath,
} from "../scripts/generate-collections-policy-lib.mjs";
import { collectionsPolicy, createPolicyEvaluator, globMatches } from "./policy.js";

describe("collections-policy.yaml", () => {
  it("generated src/generated/collections-policy.json is not stale relative to the YAML", async () => {
    const expected = await generateCollectionsPolicyJson();
    const actual = await readFile(generatedFilePath, "utf8");
    expect(actual).toBe(expected);
  });

  it("excludes figma-only and remote collections by default", () => {
    expect(collectionsPolicy.exclude).toContain("figma-only");
    expect(collectionsPolicy["exclude-remote-collections"]).toBe(true);
  });
});

describe("globMatches", () => {
  it("matches case-insensitively, like the platform's collections.toml", () => {
    expect(globMatches("figma-only", "FIGMA-ONLY")).toBe(true);
    expect(globMatches("Base", "base")).toBe(true);
  });

  it("supports *, ? and [seq]", () => {
    expect(globMatches("wip-*", "wip-experiment")).toBe(true);
    expect(globMatches("wip-*", "experiment")).toBe(false);
    expect(globMatches("mode?", "mode1")).toBe(true);
    expect(globMatches("mode?", "mode")).toBe(false);
    expect(globMatches("v[12]", "v2")).toBe(true);
    expect(globMatches("v[12]", "v3")).toBe(false);
  });

  it("treats regex metacharacters outside the glob dialect as literals", () => {
    // A collection genuinely named "base (v2)" must be excludable by
    // writing its name, not by accidentally writing a regex group.
    expect(globMatches("base (v2)", "base (v2)")).toBe(true);
    expect(globMatches("base.v2", "baseXv2")).toBe(false);
    expect(globMatches("a+b", "a+b")).toBe(true);
  });

  it("anchors the whole string rather than matching a substring", () => {
    expect(globMatches("base", "base-extended")).toBe(false);
    expect(globMatches("base*", "base-extended")).toBe(true);
  });
});

describe("createPolicyEvaluator", () => {
  it("excludes a collection matching an exclude pattern, and explains why", () => {
    const policy = createPolicyEvaluator({ version: 1, exclude: ["figma-only"] });
    const decision = policy.collection("figma-only", false);
    expect(decision.excluded).toBe(true);
    expect(decision.reason).toContain("figma-only");
    expect(policy.collection("base", false).excluded).toBe(false);
  });

  it("excludes remote collections by default and keeps them when opted out", () => {
    expect(createPolicyEvaluator({ version: 1 }).collection("AOSP", true).excluded).toBe(true);
    expect(
      createPolicyEvaluator({ version: 1, "exclude-remote-collections": false }).collection(
        "AOSP",
        true,
      ).excluded,
    ).toBe(false);
  });

  it("matches a bare branch pattern in every collection", () => {
    const policy = createPolicyEvaluator({ version: 1, "exclude-branches": ["apple"] });
    expect(policy.branch("base", "apple/color/systemBlue").excluded).toBe(true);
    expect(policy.branch("primitives", "apple/anything").excluded).toBe(true);
    expect(policy.branch("base", "color/text/default").excluded).toBe(false);
  });

  it("scopes a slash-qualified branch pattern to its collection", () => {
    const policy = createPolicyEvaluator({ version: 1, "exclude-branches": ["base/apple"] });
    expect(policy.branch("base", "apple/color/systemBlue").excluded).toBe(true);
    expect(policy.branch("primitives", "apple/anything").excluded).toBe(false);
  });

  it("only ever matches the FIRST path segment as the branch", () => {
    const policy = createPolicyEvaluator({ version: 1, "exclude-branches": ["color"] });
    expect(policy.branch("base", "color/text/default").excluded).toBe(true);
    // `color` appears mid-path here, which is not a branch.
    expect(policy.branch("components", "banners/type/informative/color/surface").excluded).toBe(
      false,
    );
  });

  it("reports patterns that matched nothing, so a typo is never a silent no-op", () => {
    const policy = createPolicyEvaluator({
      version: 1,
      exclude: ["figma-only", "does-not-exist"],
      "exclude-branches": ["apple", "never-used"],
    });
    policy.collection("figma-only", false);
    policy.branch("base", "apple/color/systemBlue");

    expect(policy.unmatchedPatterns()).toEqual(["does-not-exist", "never-used"]);
  });

  it("does not count the remote-collection default as a user pattern", () => {
    const policy = createPolicyEvaluator({ version: 1 });
    policy.collection("AOSP", true);
    expect(policy.unmatchedPatterns()).toEqual([]);
  });
});
