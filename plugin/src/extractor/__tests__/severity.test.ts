import { describe, expect, it } from "vitest";
import { severityForReason, withSeverity } from "../severity.js";
import type { UnresolvedEntry } from "@figma-normalizator/schema";

describe("severityForReason", () => {
  it("classifies design-system-breaking reasons as error", () => {
    expect(severityForReason("unmapped-component")).toBe("error");
    expect(severityForReason("unmapped-variant")).toBe("error");
    expect(severityForReason("unresolvable-alias-chain")).toBe("error");
    expect(severityForReason("missing-main-component")).toBe("error");
    expect(severityForReason("unreadable-component-properties")).toBe("error");
    expect(severityForReason("missing-file-key")).toBe("error");
  });

  it("classifies literal-instead-of-token reasons as warning", () => {
    expect(severityForReason("unbound-literal")).toBe("warning");
    expect(severityForReason("mixed-value")).toBe("warning");
    expect(severityForReason("unsupported-paint")).toBe("warning");
    expect(severityForReason("unsupported-effect")).toBe("warning");
    expect(severityForReason("duplicate-export-ref")).toBe("warning");
  });

  it("classifies purely structural reasons as info", () => {
    expect(severityForReason("absolute-positioning")).toBe("info");
  });

  it("falls back to warning for an unrecognized reason", () => {
    expect(severityForReason("some-future-reason")).toBe("warning");
  });
});

describe("withSeverity", () => {
  it("stamps severity on every entry that doesn't already have one", () => {
    const entries: UnresolvedEntry[] = [
      { nodeId: "1", reason: "unmapped-component" },
      { nodeId: "2", reason: "unbound-literal" },
      { nodeId: "3", reason: "absolute-positioning" },
    ];

    const result = withSeverity(entries);

    expect(result.map((e) => e.severity)).toEqual(["error", "warning", "info"]);
  });

  it("leaves an already-set severity untouched", () => {
    const entries: UnresolvedEntry[] = [
      { nodeId: "1", reason: "unbound-literal", severity: "info" },
    ];

    const result = withSeverity(entries);

    expect(result[0]?.severity).toBe("info");
  });

  it("mutates the passed-in entry objects in place (so aliased/nested arrays see the same stamped severity)", () => {
    const shared: UnresolvedEntry = { nodeId: "1", reason: "unmapped-component" };
    const nested = [shared];
    const flattened = [shared];

    withSeverity(flattened);

    expect(nested[0]?.severity).toBe("error");
  });
});
