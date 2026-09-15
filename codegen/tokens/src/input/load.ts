// Reads and validates a *.tokens.json file into a typed `TokenDocument`.
//
// This is the only place the generator touches the filesystem to obtain its
// input. Deliberately thin: parse JSON, run the envelope guard for a legible
// error on the two common mistakes (wrong artifact, wrong schema version),
// then validate the whole document against schema/tokens/v1/schema.json —
// the same approach already proven in
// fixtures/src/__tests__/token-schema-validation.test.ts, reused rather than
// reinvented so the two checks can never quietly drift apart.
import { readFile } from "node:fs/promises";
import Ajv2020 from "ajv/dist/2020.js";
import type { ErrorObject, ValidateFunction } from "ajv";
import { tokensSchemaV1, type TokenDocument } from "@figma-normalizator/schema";
import { assertTokenEnvelope } from "./guards.js";

export class TokenDocumentValidationError extends Error {
  constructor(
    public readonly sourceLabel: string,
    public readonly errors: ErrorObject[],
  ) {
    super(
      `${sourceLabel} does not validate against schema/tokens/v1/schema.json:\n` +
        errors
          .slice(0, 10)
          .map((e) => `  - ${e.instancePath || "/"}: ${e.message}`)
          .join("\n") +
        (errors.length > 10 ? `\n  ... and ${errors.length - 10} more` : ""),
    );
    this.name = "TokenDocumentValidationError";
  }
}

let validator: ValidateFunction | undefined;

/** Lazily compiled, memoized: ajv compilation is not free and this schema never changes at runtime. */
function getValidator(): ValidateFunction {
  validator ??= new Ajv2020({ strict: true, allowUnionTypes: true }).compile(tokensSchemaV1);
  return validator;
}

/**
 * Parses and validates a JSON value already in memory (e.g. read by a
 * caller that needs to control the I/O itself, such as a test). Prefer
 * {@link loadTokenDocument} when reading from a file path.
 */
export function parseTokenDocument(raw: string, sourceLabel: string): TokenDocument {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (cause) {
    throw new Error(`${sourceLabel} is not valid JSON: ${(cause as Error).message}`);
  }

  assertTokenEnvelope(parsed, sourceLabel);

  const validate = getValidator();
  if (!validate(parsed)) {
    throw new TokenDocumentValidationError(sourceLabel, validate.errors ?? []);
  }
  return parsed as TokenDocument;
}

/** Reads `filePath` and returns a validated, typed `TokenDocument`. */
export async function loadTokenDocument(filePath: string): Promise<TokenDocument> {
  let raw: string;
  try {
    raw = await readFile(filePath, "utf8");
  } catch (cause) {
    throw new Error(`cannot read token document at ${filePath}: ${(cause as Error).message}`);
  }
  return parseTokenDocument(raw, filePath);
}
