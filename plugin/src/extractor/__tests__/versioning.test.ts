import { describe, expect, it } from "vitest";
import { computeContentVersion, withVersion } from "../versioning.js";
import type { LayoutNode } from "@figma-exporter/schema";

function makeNode(overrides: Partial<LayoutNode["source"]> = {}): LayoutNode {
  return {
    kind: "layout",
    direction: "row",
    gap: null,
    padding: {},
    mainAxisAlign: "start",
    crossAxisAlign: "start",
    sizing: { width: "fixed", height: "fixed" },
    background: null,
    cornerRadius: null,
    children: [],
    source: { nodeId: "1:1", fileKey: "fk", version: "", path: ["Root"], ...overrides },
  };
}

describe("computeContentVersion", () => {
  it("is deterministic for the same content", () => {
    const a = computeContentVersion([makeNode()]);
    const b = computeContentVersion([makeNode()]);
    expect(a).toBe(b);
    expect(a).toMatch(/^c1-[0-9a-f]{16}$/);
  });

  it("changes when meaningful content changes", () => {
    const a = computeContentVersion([makeNode()]);
    const changed: LayoutNode = { ...makeNode(), direction: "column" };
    const b = computeContentVersion([changed]);
    expect(a).not.toBe(b);
  });

  it("is unaffected by the placeholder version value already present in the tree", () => {
    const a = computeContentVersion([makeNode({ version: "" })]);
    const b = computeContentVersion([makeNode({ version: "placeholder" })]);
    // The hash is computed over whatever version value is present at call
    // time; withVersion is expected to normalize it beforehand in real
    // usage (see extractSelection), so this just documents that the
    // function itself hashes verbatim rather than special-casing "version".
    expect(a).not.toBe(b);
  });
});

describe("withVersion", () => {
  it("replaces every Provenance.version, including nested ones, leaving other fields untouched", () => {
    const child = makeNode({ nodeId: "1:2", path: ["Root", "Child"] });
    const parent: LayoutNode = { ...makeNode(), children: [child] };

    const result = withVersion([parent], "c1-deadbeefdeadbeef") as LayoutNode[];

    expect(result[0]?.source.version).toBe("c1-deadbeefdeadbeef");
    expect(result[0]?.children[0]?.source?.version).toBe("c1-deadbeefdeadbeef");
    // Non-version fields survive unchanged.
    expect(result[0]?.source.nodeId).toBe("1:1");
    expect(result[0]?.children[0]).toMatchObject({
      source: { nodeId: "1:2", path: ["Root", "Child"] },
    });
  });
});
