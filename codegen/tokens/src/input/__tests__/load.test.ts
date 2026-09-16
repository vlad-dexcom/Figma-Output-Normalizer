import path from "node:path";
import { describe, expect, it } from "vitest";
import type { TokenDocument } from "@figma-normalizator/schema";
import { TokenDocumentValidationError, loadTokenDocument, parseTokenDocument } from "../load.js";
import { TokenEnvelopeError } from "../guards.js";

const REAL_WORLD_TOKENS_PATH = path.join(
  import.meta.dirname,
  "../../../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

describe("loadTokenDocument", () => {
  it("reads and validates the real-world fixture", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    expect(doc.envelope.kind).toBe("tokens");
    expect(doc.collections.length).toBe(5);
  });

  it("throws a legible error for a missing file", async () => {
    await expect(loadTokenDocument("/does/not/exist.tokens.json")).rejects.toThrow(
      /cannot read token document/,
    );
  });
});

describe("parseTokenDocument", () => {
  it("throws a legible error for invalid JSON", () => {
    expect(() => parseTokenDocument("{ not json", "bad.tokens.json")).toThrow(/is not valid JSON/);
  });

  it("runs the envelope guard before ajv, so a wrong-kind document fails with TokenEnvelopeError", () => {
    const irLike = JSON.stringify({ schemaVersion: 1, nodes: [], unresolved: [], version: "x" });
    expect(() => parseTokenDocument(irLike, "wrong-kind.ir.json")).toThrow(TokenEnvelopeError);
  });

  it("throws TokenDocumentValidationError for a document with an extra field ajv rejects", async () => {
    const doc = await loadTokenDocument(REAL_WORLD_TOKENS_PATH);
    const tampered: TokenDocument = {
      ...doc,
      collections: doc.collections.map((c) => ({ ...c, unexpectedField: true }) as never),
    };
    expect(() => parseTokenDocument(JSON.stringify(tampered), "tampered.tokens.json")).toThrow(
      TokenDocumentValidationError,
    );
  });
});
