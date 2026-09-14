// Validates a real, previously-captured `*.ir.json` export (not a
// synthetic mock — see `../real-world/README.md`) against the schema, at
// the node/entry level. This is deliberately *not* the same shape check
// as `schema-validation.test.ts` (which validates corpus fixtures'
// whole `irDocument` envelope): this file predates `schemaVersion` being
// added to the envelope, so it can never validate as a whole
// `irDocument` — only its individual `nodes[]`/`unresolved[]` entries are
// checked, which is exactly the granularity that still exercises real,
// messy production data against `irNode`/`unresolvedEntry` without
// requiring the artifact to be re-captured every time the envelope shape
// changes.
import { readFile } from "node:fs/promises";
import path from "node:path";
import Ajv2020 from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { irSchemaV1 } from "@figma-normalizator/schema";

const REAL_WORLD_IR_PATH = path.join(
  import.meta.dirname,
  "../real-world/daily_42487-22668_c1-790c0e5841aac834.ir.json",
);

interface RealWorldIr {
  nodes: unknown[];
  unresolved: unknown[];
  version: string;
}

describe("real-world golden fixture (daily_42487-22668)", () => {
  const ajv = new Ajv2020({ strict: true, allowUnionTypes: true });
  const validateNode = ajv.compile(irSchemaV1);
  // Same duplicate-`$id` workaround as schema-validation.test.ts: a
  // second copy of the schema, `$id` dropped, `$ref`'d at
  // `#/$defs/unresolvedEntry` instead of the default `#/$defs/irNode`.
  const validateUnresolvedEntry = ajv.compile({
    ...irSchemaV1,
    $id: undefined,
    $ref: "#/$defs/unresolvedEntry",
  });

  it("loads as a plausible IR export (has nodes and unresolved arrays)", async () => {
    const raw: unknown = JSON.parse(await readFile(REAL_WORLD_IR_PATH, "utf8"));
    const doc = raw as RealWorldIr;
    expect(Array.isArray(doc.nodes)).toBe(true);
    expect(Array.isArray(doc.unresolved)).toBe(true);
    expect(doc.nodes.length).toBeGreaterThan(0);
    expect(doc.unresolved.length).toBeGreaterThan(0);
  });

  it("does not have schemaVersion (a real artifact captured before that field existed) — a known, documented gap, not a bug in this test", async () => {
    const raw: unknown = JSON.parse(await readFile(REAL_WORLD_IR_PATH, "utf8"));
    expect((raw as Record<string, unknown>).schemaVersion).toBeUndefined();
  });

  it("every root node validates against ir/v1/schema.json's irNode", async () => {
    const doc = JSON.parse(await readFile(REAL_WORLD_IR_PATH, "utf8")) as RealWorldIr;

    for (const [index, node] of doc.nodes.entries()) {
      const valid = validateNode(node);
      if (!valid) {
        throw new Error(
          `nodes[${index}] failed irNode schema validation: ${JSON.stringify(
            validateNode.errors,
            null,
            2,
          )}`,
        );
      }
    }
  });

  it("every unresolved entry validates against ir/v1/schema.json's unresolvedEntry", async () => {
    const doc = JSON.parse(await readFile(REAL_WORLD_IR_PATH, "utf8")) as RealWorldIr;

    for (const [index, entry] of doc.unresolved.entries()) {
      const valid = validateUnresolvedEntry(entry);
      if (!valid) {
        throw new Error(
          `unresolved[${index}] failed unresolvedEntry schema validation: ${JSON.stringify(
            validateUnresolvedEntry.errors,
            null,
            2,
          )}`,
        );
      }
    }
  });
});
