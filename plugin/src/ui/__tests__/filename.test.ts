import { describe, expect, it } from "vitest";
import { buildExportFilename, buildTokenExportFilename } from "../filename.js";

describe("buildExportFilename", () => {
  it("builds {fileKey}_{nodeId}_{version}.ir.json from the IR source fields", () => {
    expect(buildExportFilename({ fileKey: "abc123", nodeId: "42:7", version: "3" })).toBe(
      "abc123_42-7_3.ir.json",
    );
  });

  it("sanitizes filesystem-unsafe characters (colons, slashes, spaces)", () => {
    expect(
      buildExportFilename({ fileKey: "file/key with spaces", nodeId: "1:2", version: "v1" }),
    ).toBe("file-key-with-spaces_1-2_v1.ir.json");
  });

  it("falls back to placeholder segments when a field is empty", () => {
    expect(buildExportFilename({ fileKey: "", nodeId: "", version: "" })).toBe(
      "unknown-file_unknown-node_unknown-version.ir.json",
    );
  });
});

describe("buildTokenExportFilename", () => {
  it("names a file-scoped token document without a node id", () => {
    expect(buildTokenExportFilename({ fileKey: "abc123", version: "c1-00ff" })).toBe(
      "abc123_c1-00ff.tokens.json",
    );
  });

  it("uses a distinct suffix so the two artifacts never collide in a downloads folder", () => {
    const tokens = buildTokenExportFilename({ fileKey: "abc", version: "v" });
    const ir = buildExportFilename({ fileKey: "abc", nodeId: "1:2", version: "v" });
    expect(tokens.endsWith(".tokens.json")).toBe(true);
    expect(ir.endsWith(".ir.json")).toBe(true);
    expect(tokens).not.toBe(ir);
  });

  it("sanitizes filesystem-unsafe characters and falls back for empty segments", () => {
    expect(buildTokenExportFilename({ fileKey: "a/b:c", version: "" })).toBe(
      "a-b-c_unknown-version.tokens.json",
    );
  });
});
