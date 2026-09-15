// TokenDocument -> TokenModel (migration plan, stage 3).
//
// This replaces roughly 1200 LOC of the old generator's resolution pipeline
// (figma/client.py, pipeline/resolver.py, pipeline/enricher.py,
// pipeline/intermediate.py) -- not by porting them, but by deleting them
// outright. They existed to reconstruct facts (alias targets, real mode
// names, which value came from where) that a Token IR document already
// records directly. Most notably, `enricher.py` guessed alias edges by
// matching color VALUES across collections and picking the "best" match by
// path-segment overlap; that guess is simply gone, because `alias.byMode` is
// now a recorded edge, not a value coincidence.
//
// What is left to do here is much smaller: index the document for this
// generator's own use.
import type { TokenCollection, TokenDocument } from "@figma-normalizator/schema";
import type { TokenModel } from "./types.js";

export class DuplicateCollectionIdError extends Error {
  constructor(
    public readonly id: string,
    public readonly names: readonly string[],
  ) {
    super(
      `token document has two collections sharing id ${JSON.stringify(id)} (names: ` +
        `${names.map((n) => JSON.stringify(n)).join(", ")}). Collection ids are Figma's own ` +
        `variable collection ids and must be unique within one export -- this indicates a ` +
        `corrupted or hand-edited document, not something codegen can route around.`,
    );
    this.name = "DuplicateCollectionIdError";
  }
}

/**
 * Builds this generator's TokenModel from an already-validated TokenDocument.
 *
 * The one thing this function exists to fix relative to the old generator:
 * collections are indexed by `collection.id`, never by `collection.name`.
 * `MIGRATION.md` records a real production file that carried five
 * collections named `Primitives`, six named `Mode`, and five named `base` --
 * the old generator's name-keyed `tokens.json` object silently kept one of
 * each and dropped the rest. `idsByName` makes that collision visible
 * instead of hiding it; `name` remains available for display and for
 * generating class names, which is the only legitimate use for it (with
 * explicit collision handling done there, in a later stage, not here).
 */
export function buildTokenModel(document: TokenDocument): TokenModel {
  const byId = new Map<string, TokenCollection>();
  const idsByName = new Map<string, string[]>();

  for (const collection of document.collections) {
    const existingById = byId.get(collection.id);
    if (existingById) {
      throw new DuplicateCollectionIdError(collection.id, [existingById.name, collection.name]);
    }
    byId.set(collection.id, collection);

    const idsForName = idsByName.get(collection.name);
    if (idsForName) {
      idsForName.push(collection.id);
    } else {
      idsByName.set(collection.name, [collection.id]);
    }
  }

  return {
    envelope: document.envelope,
    collections: document.collections,
    byId,
    idsByName,
  };
}
