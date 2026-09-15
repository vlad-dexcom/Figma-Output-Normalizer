// The generator's own view of a token export.
//
// A TokenModel is a TokenDocument re-indexed for the generator's own use --
// still purely facts about the input. Codegen DECISIONS (a collection's
// role, its package name, build order between collections) are layered on
// top of this in later stages (classify.ts, graph.ts) and deliberately do
// not live here: TokenDocument records what Figma has, TokenModel records
// how this generator looks it up, and the classify/graph layers record what
// this generator decided to do about it. Keeping those three separate is
// what stage 5's classification report can point back at.
import type { TokenCollection, TokenDocumentEnvelope } from "@figma-normalizator/schema";

export interface TokenModel {
  /** Passed through unchanged -- provenance (fileKey, content version). */
  envelope: TokenDocumentEnvelope;
  /** Every collection, in the document's own declared order. */
  collections: readonly TokenCollection[];
  /** O(1) lookup by `collection.id` -- the only key this document guarantees unique. */
  byId: ReadonlyMap<string, TokenCollection>;
  /**
   * `collection.name` -> every collection id sharing that name. A real
   * production file has carried five collections named `Primitives`, six
   * named `Mode`, and five named `base`; a lookup keyed on name alone
   * silently keeps one and drops the rest. Consult this before trusting a
   * name-based lookup, rather than discovering the collision downstream.
   */
  idsByName: ReadonlyMap<string, readonly string[]>;
}

/** True when two or more collections in `model` share `name`. */
export function hasNameCollision(model: TokenModel, name: string): boolean {
  return (model.idsByName.get(name)?.length ?? 0) > 1;
}
