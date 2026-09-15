import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { TokenDocument, UnresolvedToken } from "@figma-normalizator/schema";
import {
  UnresolvedTokensError,
  assertNoUnresolvedFailures,
  triageUnresolved,
  warnAboutUnresolved,
} from "../unresolved.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-88d0431a4019ec4b.tokens.json",
);

function entry(reason: UnresolvedToken["reason"], path_ = "a/b"): UnresolvedToken {
  return { collection: "base", path: path_, reason };
}

describe("triageUnresolved", () => {
  it("applies the plan's default action per reason code", () => {
    const { warnings, failures } = triageUnresolved([
      entry("excluded-by-policy"),
      entry("excluded-collection-alias"),
      entry("missing-alias-target"),
      entry("unresolvable-alias-chain"),
      entry("unsupported-value"),
    ]);
    expect(warnings.map((w) => w.reason)).toEqual(["excluded-collection-alias"]);
    expect(failures.map((f) => f.reason)).toEqual([
      "missing-alias-target",
      "unresolvable-alias-chain",
      "unsupported-value",
    ]);
  });

  it("lets an override change the action for one reason code", () => {
    const { warnings, failures } = triageUnresolved([entry("unsupported-value")], {
      "unsupported-value": "warn",
    });
    expect(failures).toEqual([]);
    expect(warnings).toHaveLength(1);
  });
});

describe("assertNoUnresolvedFailures", () => {
  it("does not throw when nothing triages to fail", () => {
    expect(() =>
      assertNoUnresolvedFailures([entry("excluded-by-policy")], {}, vi.fn()),
    ).not.toThrow();
  });

  it("throws UnresolvedTokensError carrying the failing entries", () => {
    const failing = entry("missing-alias-target");
    try {
      assertNoUnresolvedFailures([failing], {}, vi.fn());
      expect.unreachable();
    } catch (error) {
      expect(error).toBeInstanceOf(UnresolvedTokensError);
      expect((error as UnresolvedTokensError).failures).toEqual([failing]);
    }
  });

  it("still warns for warn-level entries even though nothing fails", () => {
    const warn = vi.fn();
    assertNoUnresolvedFailures([entry("excluded-collection-alias")], {}, warn);
    expect(warn).toHaveBeenCalledTimes(1);
  });
});

describe("warnAboutUnresolved", () => {
  it("calls warn once per entry with reason and path", () => {
    const warn = vi.fn();
    warnAboutUnresolved([entry("excluded-collection-alias", "apple/color/systemBlue")], warn);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]?.[0]).toContain("apple/color/systemBlue");
    expect(warn.mock.calls[0]?.[0]).toContain("excluded-collection-alias");
  });
});

describe("against the real-world fixture", () => {
  it("matches the reason distribution documented in fixtures/src/real-world/README.md", async () => {
    const doc = JSON.parse(await readFile(REAL_WORLD_TOKENS_PATH, "utf8")) as TokenDocument;

    const { warnings, failures } = triageUnresolved(doc.unresolved);

    // README.md: unresolved 190 (unsupported-value 168, excluded-collection-alias 22).
    expect(failures.filter((f) => f.reason === "unsupported-value")).toHaveLength(168);
    expect(warnings.filter((w) => w.reason === "excluded-collection-alias")).toHaveLength(22);
    expect(failures).toHaveLength(168);
    expect(warnings).toHaveLength(22);
  });
});
