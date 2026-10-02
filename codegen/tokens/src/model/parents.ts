// Sub-collection ("theme") -> parent collection resolution.
//
// A Figma extended collection (e.g. `stelo` extending `base`) shares its
// parent's variables and structure and differs only in values. Emitting it
// as its own class duplicates the parent's whole type tree for no reason;
// instead the emitter generates it as extra factory functions returning the
// PARENT's type. This module decides which collections get that treatment.
//
// The source of truth is `collection.extends`, recorded by the exporter
// straight from Figma's own extension link. Exports that predate that field
// fall back to structural detection -- deliberately strict (identical
// path/type set AND identical mode set, and exactly one candidate), because
// a wrong match would silently retype a collection.
import type { Token, TokenCollection, TokenDocument } from "@figma-exporter/schema";

export class CollectionParentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CollectionParentError";
  }
}

export interface CollectionParents {
  /** Sub-collection name -> parent collection name. */
  parents: Map<string, string>;
  /** Human-readable notes (structural detections, skipped links), for stderr. */
  notes: string[];
}

function uniqueByName(
  collections: readonly TokenCollection[],
  name: string,
): TokenCollection | undefined {
  const matches = collections.filter((c) => c.name === name);
  return matches.length === 1 ? matches[0] : undefined;
}

function shapeOf(collection: TokenCollection): Map<string, Token["type"]> {
  return new Map(collection.tokens.map((t) => [t.path, t.type]));
}

/** Paths whose presence or type differs between two collections (empty when identical). */
function shapeDifferences(child: TokenCollection, parent: TokenCollection): string[] {
  const a = shapeOf(child);
  const b = shapeOf(parent);
  const diffs: string[] = [];
  for (const [path, type] of a) {
    if (!b.has(path)) diffs.push(`${path} (only in "${child.name}")`);
    else if (b.get(path) !== type) diffs.push(`${path} (${type} vs ${b.get(path)})`);
  }
  for (const path of b.keys()) {
    if (!a.has(path)) diffs.push(`${path} (only in "${parent.name}")`);
  }
  return diffs;
}

function sameModeSet(a: TokenCollection, b: TokenCollection): boolean {
  const norm = (c: TokenCollection) =>
    [...c.modes]
      .map((m) => m.toLowerCase())
      .sort()
      .join("\u0000");
  return a.modes.length === b.modes.length && norm(a) === norm(b);
}

/**
 * Resolves every sub-collection's parent. Throws when a Figma-recorded
 * `extends` link cannot be honoured structurally (e.g. policy excluded a
 * branch in one collection but not the other) -- emitting the child as
 * the parent's type would then not compile.
 */
export function resolveCollectionParents(document: TokenDocument): CollectionParents {
  const parents = new Map<string, string>();
  const notes: string[] = [];
  const collections = document.collections.filter((c) => c.tokens.length > 0);

  for (const child of collections) {
    if (child.extends === undefined) continue;
    const parent = uniqueByName(collections, child.extends);
    if (!parent) {
      notes.push(
        `[${child.name}] extends "${child.extends}", which is not (uniquely) present in this ` +
          `document -- generating it as a standalone class.`,
      );
      continue;
    }
    const diffs = shapeDifferences(child, parent);
    if (diffs.length > 0) {
      throw new CollectionParentError(
        `collection "${child.name}" extends "${parent.name}" in Figma, but their token sets ` +
          `differ, so "${child.name}" cannot be generated as "${parent.name}"'s type: ` +
          `${diffs.slice(0, 10).join("; ")}${diffs.length > 10 ? `; ... (${diffs.length} total)` : ""}.`,
      );
    }
    parents.set(child.name, parent.name);
  }

  // Structural fallback, only for exports with no recorded `extends` at all:
  // once the exporter records the link, its absence is itself a fact.
  if (!document.collections.some((c) => c.extends !== undefined)) {
    for (const child of collections) {
      const candidates = collections.filter(
        (p) =>
          p !== child &&
          uniqueByName(collections, p.name) === p &&
          uniqueByName(collections, child.name) === child &&
          sameModeSet(child, p) &&
          shapeDifferences(child, p).length === 0,
      );
      if (candidates.length !== 1) continue;
      const parent = candidates[0]!;
      // Two structurally identical collections match each other; keep the
      // one declared first as the parent (Figma lists a parent before any
      // collection extending it) and never create a cycle.
      if (collections.indexOf(parent) > collections.indexOf(child)) continue;
      parents.set(child.name, parent.name);
      notes.push(
        `[${child.name}] detected by structure as a sub-collection of "${parent.name}" (this ` +
          `export has no "extends" field; re-export to use Figma's own link).`,
      );
    }
  }

  return { parents, notes };
}
