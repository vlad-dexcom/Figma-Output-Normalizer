// Cheap, specific pre-checks for the token document envelope.
//
// These exist because the realistic failure mode is not "malformed JSON" —
// it is "the right kind of file, wrong version": someone points the CLI at
// a *.ir.json (node IR, a sibling artifact from the same plugin) or at a
// tokens/v1 export from before a schema bump. Both are valid JSON that will
// fail ajv validation with an error buried in `$defs.tokenDocument...`,
// which is technically correct and useless to read. Catching the two named
// mistakes here, before ajv sees the document, turns that into one line
// naming the actual problem.
import { TOKENS_SCHEMA_VERSION } from "@figma-normalizator/schema";

export class TokenEnvelopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TokenEnvelopeError";
  }
}

interface EnvelopeLike {
  kind?: unknown;
  schemaVersion?: unknown;
}

interface DocumentLike {
  envelope?: EnvelopeLike;
  nodes?: unknown;
}

/**
 * Throws a {@link TokenEnvelopeError} unless `value` is shaped like a
 * schema/tokens/v1 document's envelope (`envelope.kind === "tokens"`,
 * `envelope.schemaVersion === 1`). Does not otherwise validate the
 * document — that is ajv's job in `load.ts`, run only after this passes.
 */
export function assertTokenEnvelope(value: unknown, sourceLabel: string): void {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new TokenEnvelopeError(`${sourceLabel} does not contain a JSON object.`);
  }
  const document = value as DocumentLike;

  if (document.envelope === undefined) {
    // The node IR envelope (schema/ir/v1) has no "envelope" wrapper at all —
    // its fields (schemaVersion, nodes, unresolved, version) sit at the top
    // level, and it always carries a top-level "nodes" array. That is the
    // single most likely reason this field is missing.
    if (Array.isArray(document.nodes)) {
      throw new TokenEnvelopeError(
        `${sourceLabel} looks like a node IR export (schema/ir/v1, e.g. a *.ir.json file), ` +
          `not a token export (schema/tokens/v1, *.tokens.json). codegen-tokens reads Token IR ` +
          `only — pass the plugin's token export instead.`,
      );
    }
    throw new TokenEnvelopeError(
      `${sourceLabel} has no "envelope" field — it is not a schema/tokens/v1 document.`,
    );
  }

  const { kind, schemaVersion } = document.envelope;
  if (kind !== "tokens") {
    throw new TokenEnvelopeError(
      `${sourceLabel} has envelope.kind = ${JSON.stringify(kind)}, expected "tokens". ` +
        `codegen-tokens only reads Token IR documents (schema/tokens/v1).`,
    );
  }
  if (schemaVersion !== TOKENS_SCHEMA_VERSION) {
    throw new TokenEnvelopeError(
      `${sourceLabel} has envelope.schemaVersion = ${JSON.stringify(schemaVersion)}, expected ` +
        `${TOKENS_SCHEMA_VERSION}. This generator implements schema/tokens/v1 — re-export the ` +
        `tokens, or upgrade codegen-tokens if a newer schema version is intentional.`,
    );
  }
}
