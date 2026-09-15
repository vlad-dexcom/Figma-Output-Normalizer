// Mode expansion through alias.byMode (migration plan, stage 4).
//
// This is a BEHAVIOUR CHANGE the migration explicitly calls for, not a
// refactor: `schema/tokens/MIGRATION.md` -> "Stop reading `values` for leaf
// collections as if they were complete." A token in a single-mode
// collection (e.g. `components`, whose only mode is named "value") can
// alias into a multi-mode collection (e.g. `base`, light/dark). The
// plugin resolves that alias by preferring a same-named target mode and
// falling back to the target's *default* mode when no same-named mode
// exists -- so `token.modes.value` silently becomes just one of "light" or
// "dark", and the other is lost unless something re-expands it. The old
// generator's `graph`/`builders` reconstructed this by hand, from alias
// paths, as a side effect of dependency-graph construction. Here it is a
// direct, first-class read of the recorded edge.
import type { AliasTarget, Token, TokenCollection } from "@figma-normalizator/schema";
import type { TokenModel } from "./types.js";

/** The literal value domain a token can carry per mode — same shape as schema `Token.value`/`modes`. */
export type TokenLiteral = Token["value"];

export type AliasExpansionErrorReason =
  "ambiguous-target-collection" | "missing-target-collection" | "missing-target-token";

export class AliasExpansionError extends Error {
  constructor(
    public readonly reason: AliasExpansionErrorReason,
    message: string,
  ) {
    super(message);
    this.name = "AliasExpansionError";
  }
}

export interface ExpandedTokenModes {
  /** Mode name -> resolved literal. Identical to `token.modes` unless `expanded` is true. */
  values: Readonly<Record<string, TokenLiteral>>;
  /** The mode names `values` is keyed by: the token's own collection's modes, or the alias target's when expanded. */
  modes: readonly string[];
  /**
   * True when `values`/`modes` came from expanding a single-mode alias
   * into a multi-mode target collection, rather than from the token's own
   * (collapsed) `token.modes`.
   */
  expanded: boolean;
}

function unexpanded(token: Token, collection: TokenCollection): ExpandedTokenModes {
  return { values: token.modes, modes: collection.modes, expanded: false };
}

/**
 * Resolves the single collection sharing `name`, per the model's `idsByName`
 * index. Throws rather than picking one when the name is ambiguous -- see
 * `model/build.ts` for why a name is not a safe key on its own.
 */
function resolveTargetCollection(
  model: TokenModel,
  edge: AliasTarget,
  token: Token,
  ownCollection: TokenCollection,
): TokenCollection | undefined {
  const targetName = edge.collection;
  if (targetName === null) return undefined;

  const ids = model.idsByName.get(targetName) ?? [];
  if (ids.length === 0) {
    throw new AliasExpansionError(
      "missing-target-collection",
      `token "${token.path}" in collection "${ownCollection.name}" aliases into collection ` +
        `"${targetName}", which is not present in this document. A policy-excluded target ` +
        `should have set alias.byMode.<mode>.excluded — this indicates a document inconsistency.`,
    );
  }
  if (ids.length > 1) {
    throw new AliasExpansionError(
      "ambiguous-target-collection",
      `token "${token.path}" in collection "${ownCollection.name}" aliases into collection ` +
        `"${targetName}", but ${ids.length} collections share that name in this document ` +
        `(ids: ${ids.join(", ")}) — alias.byMode records a name, not an id, so which one is ` +
        `meant cannot be determined here.`,
    );
  }

  return model.byId.get(ids[0] as string);
}

/**
 * Computes the effective per-mode values for one token, expanding through
 * its alias edge when applicable.
 *
 * Expansion applies only when ALL of the following hold (plan 4.1):
 * - `collection` (the token's own collection) has exactly one mode — a
 *   multi-mode collection's own modes are already the meaningful set;
 * - that mode has an alias edge, it is not `excluded` (plan 4.3: an
 *   excluded edge keeps its documented literal fallback, unchanged), and
 *   both `collection`/`path` are known;
 * - the resolved target collection itself declares more than one mode —
 *   expanding into another single-mode collection would not gain anything.
 *
 * When any of those does not hold, this returns the token's own
 * `modes`/`collection.modes` unchanged (`expanded: false`).
 */
export function expandTokenModes(
  model: TokenModel,
  collection: TokenCollection,
  token: Token,
): ExpandedTokenModes {
  if (collection.modes.length !== 1) return unexpanded(token, collection);
  const ownMode = collection.modes[0];
  if (ownMode === undefined) return unexpanded(token, collection);

  const edge = token.alias?.byMode?.[ownMode];
  if (!edge || edge.excluded || edge.collection === null || edge.path === null) {
    return unexpanded(token, collection);
  }

  const targetCollection = resolveTargetCollection(model, edge, token, collection);
  if (!targetCollection || targetCollection.modes.length <= 1) {
    return unexpanded(token, collection);
  }

  const targetToken = targetCollection.tokens.find((t) => t.path === edge.path);
  if (!targetToken) {
    throw new AliasExpansionError(
      "missing-target-token",
      `token "${token.path}" in collection "${collection.name}" aliases "${edge.path}" in ` +
        `collection "${targetCollection.name}", but no token with that path exists there.`,
    );
  }

  return { values: targetToken.modes, modes: targetCollection.modes, expanded: true };
}
