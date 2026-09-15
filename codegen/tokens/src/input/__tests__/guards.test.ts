import { describe, expect, it } from "vitest";
import { TokenEnvelopeError, assertTokenEnvelope } from "../guards.js";

describe("assertTokenEnvelope", () => {
  it("accepts a document whose envelope matches tokens/v1", () => {
    expect(() =>
      assertTokenEnvelope({ envelope: { kind: "tokens", schemaVersion: 1 } }, "ok.tokens.json"),
    ).not.toThrow();
  });

  it("rejects a non-object value", () => {
    expect(() => assertTokenEnvelope("nope", "x")).toThrow(TokenEnvelopeError);
    expect(() => assertTokenEnvelope(null, "x")).toThrow(TokenEnvelopeError);
    expect(() => assertTokenEnvelope([1, 2, 3], "x")).toThrow(TokenEnvelopeError);
  });

  it("names the node IR mistake specifically when it sees a top-level nodes[] and no envelope", () => {
    expect(() =>
      assertTokenEnvelope(
        { schemaVersion: 1, nodes: [], unresolved: [], version: "v" },
        "x.ir.json",
      ),
    ).toThrow(/looks like a node IR export/);
  });

  it("rejects a missing envelope that is not IR-shaped with a generic message", () => {
    expect(() => assertTokenEnvelope({ foo: "bar" }, "x")).toThrow(/has no "envelope" field/);
  });

  it('rejects envelope.kind other than "tokens"', () => {
    expect(() => assertTokenEnvelope({ envelope: { kind: "ir", schemaVersion: 1 } }, "x")).toThrow(
      /envelope.kind = "ir"/,
    );
  });

  it("rejects a schemaVersion the package does not implement", () => {
    expect(() =>
      assertTokenEnvelope({ envelope: { kind: "tokens", schemaVersion: 2 } }, "x"),
    ).toThrow(/envelope.schemaVersion = 2/);
  });
});
