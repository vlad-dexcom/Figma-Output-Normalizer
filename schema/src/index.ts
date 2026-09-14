// Public entry point for @figma-normalizator/schema.
//
// Consumers should import IR node types from here, and use
// `irSchemaV1` (the raw JSON Schema document) if they need to validate IR
// documents at runtime (e.g. with ajv). Do not hand-edit `generated/ir.ts` —
// it is produced by `npm run generate:types` from `ir/v1/schema.json`.
import irSchemaV1Json from "../ir/v1/schema.json" with { type: "json" };
import tokensSchemaV1Json from "../tokens/v1/schema.json" with { type: "json" };

export * from "./generated/ir.js";
export * from "./generated/tokens.js";

/** IR schema version implemented by this package's generated types. */
export const IR_SCHEMA_VERSION = 1;

/**
 * Token document schema version implemented by this package's generated
 * types. Versioned independently of `IR_SCHEMA_VERSION`: the two documents
 * describe different things on different cadences (a selection of the scene
 * graph vs the file's tokens), so tying them to one number would force a
 * meaningless version bump on one whenever the other changed.
 */
export const TOKENS_SCHEMA_VERSION = 1;

/** The raw IR v1 JSON Schema document, for runtime validation (e.g. ajv). */
export const irSchemaV1 = irSchemaV1Json as Record<string, unknown>;

/** The raw token-document v1 JSON Schema, for runtime validation (e.g. ajv). */
export const tokensSchemaV1 = tokensSchemaV1Json as Record<string, unknown>;
