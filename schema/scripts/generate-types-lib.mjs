// Shared logic for generating the schema/src/generated/ir.ts TypeScript
// types from schema/ir/v1/schema.json. Used by both the `generate:types`
// CLI script and the "generated types are not stale" vitest check, so the
// two can never drift apart from each other.
import { compile } from "json-schema-to-typescript";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));
export const schemaPath = path.join(here, "..", "ir", "v1", "schema.json");
export const generatedFilePath = path.join(here, "..", "src", "generated", "ir.ts");

export const tokensSchemaPath = path.join(here, "..", "tokens", "v1", "schema.json");
export const tokensGeneratedFilePath = path.join(here, "..", "src", "generated", "tokens.ts");

export const banner = `/**
 * This file was automatically generated from schema/ir/v1/schema.json.
 * DO NOT EDIT MANUALLY — run \`npm run generate:types\` in schema/ to
 * regenerate it, then commit the result.
 */

`;

/**
 * Renders the `IRDocument` interface from `schema.$defs.irDocument` as a
 * plain string, rather than a second `compile()` pass. A second full
 * `compile()` call for `irDocument` would transitively re-expand and
 * duplicate every interface `irNode` already produced above (`irDocument`
 * `$ref`s `irNode`/`unresolvedEntry`), and `unreachableDefinitions: true`
 * on the single existing pass doesn't reach it either (the library's
 * unreachable-defs pickup only fires for `type: object` root schemas;
 * `irNode`'s root is a bare `oneOf`). `irDocument`'s shape is small and
 * stable (four properties), so this hand-rolled renderer — driven
 * entirely by the schema's own property list/required/const/description,
 * not hardcoded field values — is simpler and more robust than fighting
 * the compiler's reachability model. `IRNode`/`UnresolvedEntry` are
 * referenced by name, relying on the invariant that the primary `compile()`
 * call above always emits both under those exact names.
 */
function renderIRDocumentInterface(schema) {
  const doc = schema.$defs.irDocument;
  const required = new Set(doc.required ?? []);
  const typeFor = {
    schemaVersion: String(doc.properties.schemaVersion.const),
    nodes: "IRNode[]",
    unresolved: "UnresolvedEntry[]",
    version: "string",
  };

  const fields = Object.keys(doc.properties)
    .map((key) => {
      const prop = doc.properties[key];
      const optional = required.has(key) ? "" : "?";
      const comment = prop.description ? `  /**\n   * ${prop.description}\n   */\n` : "";
      return `${comment}  ${key}${optional}: ${typeFor[key]};`;
    })
    .join("\n");

  return `/**\n * ${doc.description}\n */\n` + `export interface IRDocument {\n${fields}\n}\n`;
}

export const tokensBanner = `/**
 * This file was automatically generated from schema/tokens/v1/schema.json.
 * DO NOT EDIT MANUALLY — run \`npm run generate:types\` in schema/ to
 * regenerate it, then commit the result.
 */

`;

/**
 * Compiles tokens/v1/schema.json into the full generated file contents.
 *
 * Unlike the node IR, the token document is not recursive, so its root
 * `$ref` can be dereferenced by compiling the `tokenDocument` subschema
 * directly (same approach as `generateIrTypesFile` below, for the same
 * "don't emit a duplicate root type" reason).
 */
export async function generateTokenTypesFile() {
  const schema = JSON.parse(await readFile(tokensSchemaPath, "utf8"));
  const root = schema.$defs.tokenDocument;
  root.$defs = schema.$defs;

  const ts = await compile(root, "TokenDocument", {
    bannerComment: "",
    additionalProperties: false,
    style: { singleQuote: false },
    unreachableDefinitions: false,
    cwd: path.dirname(tokensSchemaPath),
  });
  return tokensBanner + ts;
}

/** Compiles ir/v1/schema.json into the full generated file contents (banner + TS). */
export async function generateIrTypesFile() {
  const schema = JSON.parse(await readFile(schemaPath, "utf8"));

  // json-schema-to-typescript can't compile a root schema that is itself a
  // bare `$ref` into a recursive `$defs` entry (the union IRNode is
  // recursive: layout/overlay/list nodes contain IRNode children). Instead,
  // compile the `$defs.irNode` subschema directly as the root — same object
  // identity as what `children`/`slots`/etc already `$ref` to, so the tool
  // produces a single `IRNode` type instead of a duplicate `IRNode`/`IrNode`
  // pair.
  const root = schema.$defs.irNode;
  root.$defs = schema.$defs;

  const ts = await compile(root, "IRNode", {
    bannerComment: "",
    additionalProperties: false,
    style: { singleQuote: false },
    unreachableDefinitions: false,
    cwd: path.dirname(schemaPath),
  });

  const documentTs = renderIRDocumentInterface(schema);

  return banner + ts + "\n" + documentTs;
}
