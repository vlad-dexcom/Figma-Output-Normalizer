// Collection-level value fallback.
//
// Some Figma collections are deliberately laid out as a 1:1 override of an
// existing one (same paths, same modes) where a designer only sets a value
// for the tokens they actually want to diverge on, leaving the rest
// unbound in Figma entirely (an empty `valuesByMode` entry -- the exporter
// reports this as `unsupported-value` / "sparse mode coverage", not a
// resolvable alias). This is not something the exporter can infer from the
// Figma variable graph itself (there is no alias edge to follow -- the
// value is simply absent).
//
// `detectCollectionFallbacks` finds this pattern automatically, by
// structure (matching mode names + a resolvable path), without ever
// hardcoding a collection name -- the CLI runs it unconditionally, before
// triage/model building ever sees the document. Only an unambiguous single
// match is applied automatically; anything ambiguous is reported and left
// for an explicit `--fallback-collection <child>=<parent>` override.
import type {
  AliasTarget,
  Token,
  TokenCollection,
  TokenDocument,
  UnresolvedToken,
} from "@figma-normalizator/schema";

export type FallbackMapping = ReadonlyMap<string, string>;

export interface FallbackResult {
  document: TokenDocument;
  /** One line per token value actually filled in from its parent collection. */
  applied: string[];
}

function findCollection(
  collections: readonly TokenCollection[],
  name: string,
): TokenCollection | undefined {
  return collections.find((c) => c.name === name);
}

/** A (path, mode) pair with a `null` value and no alias for that mode -- genuinely nothing set explicitly. */
function nullNoAliasEntries(collection: TokenCollection): { path: string; mode: string }[] {
  const entries: { path: string; mode: string }[] = [];
  for (const token of collection.tokens) {
    for (const mode of collection.modes) {
      if (token.modes[mode] === null && token.alias?.byMode[mode] === undefined) {
        entries.push({ path: token.path, mode });
      }
    }
  }
  return entries;
}

function sameModeSet(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const bLower = new Set(b.map((m) => m.toLowerCase()));
  return a.every((m) => bLower.has(m.toLowerCase()));
}

/**
 * Looks up `token.modes[mode]` tolerating a case difference in the mode
 * name -- the same quirk `--exclude-mode` already tolerates (e.g. a real
 * export declares `iOS` on one collection and `ios` on another).
 */
function modeValue(token: Token, mode: string): Token["value"] | undefined {
  const match = Object.entries(token.modes).find(([m]) => m.toLowerCase() === mode.toLowerCase());
  return match?.[1];
}

/** Same case tolerance as {@link modeValue}, but for `token.alias.byMode`. */
function aliasFor(token: Token, mode: string): AliasTarget | undefined {
  if (!token.alias) return undefined;
  const match = Object.entries(token.alias.byMode).find(
    ([m]) => m.toLowerCase() === mode.toLowerCase(),
  );
  return match?.[1];
}

export interface DetectedFallbacks {
  /** `<child>` -> `<parent>` for every child with exactly one qualifying parent. */
  detected: Map<string, string>;
  /** `<child>` -> candidate parent names, for a child with more than one qualifying parent (left unresolved -- ambiguous). */
  ambiguous: Map<string, string[]>;
}

/**
 * Detects, without any name-specific configuration, collections that are
 * structurally a 1:1 override of another one -- same mode names (compared
 * case-insensitively, matching `--exclude-mode`'s own casing tolerance) and
 * at least one shared path where the candidate parent actually has a value
 * the child is missing. A child with more than one such candidate is
 * reported as `ambiguous` rather than guessed at -- picking the wrong one
 * silently would be worse than the sparse-value failure this exists to
 * avoid, so only an unambiguous single match is auto-applied.
 */
export function detectCollectionFallbacks(document: TokenDocument): DetectedFallbacks {
  const detected = new Map<string, string>();
  const ambiguous = new Map<string, string[]>();

  for (const child of document.collections) {
    const sparse = nullNoAliasEntries(child);
    if (sparse.length === 0) continue;

    const candidates: string[] = [];
    for (const parent of document.collections) {
      if (parent.name === child.name) continue;
      if (!sameModeSet(child.modes, parent.modes)) continue;

      const parentByPath = new Map(parent.tokens.map((t) => [t.path, t]));
      const resolvesAny = sparse.some(({ path, mode }) => {
        const parentToken = parentByPath.get(path);
        if (!parentToken) return false;
        const parentValue = modeValue(parentToken, mode);
        return parentValue !== undefined && parentValue !== null;
      });
      if (resolvesAny) candidates.push(parent.name);
    }

    if (candidates.length === 1) detected.set(child.name, candidates[0]!);
    else if (candidates.length > 1) ambiguous.set(child.name, candidates);
  }

  return { detected, ambiguous };
}

/**
 * Returns a copy of `document` with every `<child>` collection in
 * `mapping` having its tokens' `null` mode values filled in from the
 * same-path token in `<parent>`, wherever `<parent>` has a non-null value
 * for that mode. Only touches values that were `null` with no alias for
 * that mode (i.e. genuinely nothing set explicitly) -- a token already
 * resolved, by literal or alias, is left untouched. Matching `unresolved[]`
 * entries (`unsupported-value`, sparse mode coverage) are dropped, since
 * the value is no longer unresolved.
 *
 * When `<parent>`'s own value for that mode is itself a live alias (e.g.
 * into `primitives`), that alias edge is copied too, not just its resolved
 * literal -- otherwise `<child>` would bake a hex literal where `<parent>`
 * emits a live reference, purely as an artifact of how the fallback was
 * filled in rather than anything true about the token. `<child>`'s
 * `dependsOn` gains whatever collection(s) those copied aliases point
 * into, so the emitter's own alias-edge/dependsOn consistency check still
 * holds.
 */
export function applyCollectionFallbacks(
  document: TokenDocument,
  mapping: FallbackMapping,
): FallbackResult {
  if (mapping.size === 0) return { document, applied: [] };

  const applied: string[] = [];
  const filledModesByChildPath = new Map<string, Set<string>>();

  const collections = document.collections.map((collection): TokenCollection => {
    const parentName = mapping.get(collection.name);
    if (parentName === undefined) return collection;

    const parent = findCollection(document.collections, parentName);
    if (!parent) {
      throw new Error(
        `--fallback-collection ${collection.name}=${parentName}: no collection named ` +
          `${JSON.stringify(parentName)} in this document.`,
      );
    }
    const parentByPath = new Map(parent.tokens.map((t) => [t.path, t]));
    const dependsOn = new Set(collection.dependsOn);

    const tokens = collection.tokens.map((token): Token => {
      const parentToken = parentByPath.get(token.path);
      if (!parentToken) return token;

      const hasAlias = (mode: string): boolean => token.alias?.byMode[mode] !== undefined;
      const filledModes = new Set<string>();
      const modes = { ...token.modes };
      const aliasByMode = { ...token.alias?.byMode };
      let aliasChanged = false;

      for (const [mode, value] of Object.entries(modes)) {
        if (value !== null || hasAlias(mode)) continue;
        const parentValue = modeValue(parentToken, mode);
        if (parentValue === undefined || parentValue === null) continue;
        modes[mode] = parentValue;
        filledModes.add(mode);

        const parentAlias = aliasFor(parentToken, mode);
        let sourceDescription: string;
        if (parentAlias && parentAlias.collection !== null && parentAlias.path !== null) {
          aliasByMode[mode] = parentAlias;
          aliasChanged = true;
          // An `excluded` alias's target collection was dropped by policy
          // and is not present in this document at all -- it keeps its
          // documented literal fallback (the emitter checks `excluded`
          // itself), but must never be added to `dependsOn`, which is
          // guaranteed to only ever name collections that actually exist.
          if (!parentAlias.excluded) {
            dependsOn.add(parentAlias.collection);
            if (parentAlias.opacity?.collection && !parentAlias.opacity.excluded) {
              dependsOn.add(parentAlias.opacity.collection);
            }
          }
          sourceDescription = parentAlias.excluded
            ? `literal ${JSON.stringify(parentValue)} (alias into excluded collection "${parentAlias.collection}")`
            : `alias into [${parentAlias.collection}] ${parentAlias.path}`;
        } else {
          sourceDescription = `literal ${JSON.stringify(parentValue)}`;
        }
        applied.push(
          `[${collection.name}] ${token.path} (${mode}) <- [${parentName}] ${parentToken.path} = ${sourceDescription}`,
        );
      }
      if (filledModes.size === 0) return token;

      filledModesByChildPath.set(`${collection.name}\u0000${token.path}`, filledModes);

      const defaultMode = collection.defaultMode;
      const value =
        defaultMode !== null && filledModes.has(defaultMode) ? modes[defaultMode]! : token.value;
      return {
        ...token,
        modes,
        value,
        ...(aliasChanged && Object.keys(aliasByMode).length > 0
          ? { alias: { byMode: aliasByMode } }
          : {}),
      };
    });

    return { ...collection, tokens, dependsOn: [...dependsOn].sort() };
  });

  const unresolved = document.unresolved.filter((entry: UnresolvedToken) => {
    if (entry.collection === null || entry.reason !== "unsupported-value") return true;
    const filled = filledModesByChildPath.get(`${entry.collection}\u0000${entry.path}`);
    if (!filled) return true;
    // The mode name is embedded in `detail` (e.g. `Mode "dark" has no
    // value...`) rather than a structured field -- match it there.
    for (const mode of filled) {
      if (entry.detail?.includes(`Mode "${mode}"`)) return false;
    }
    return true;
  });

  return { document: { ...document, collections, unresolved }, applied };
}

/** Parses a repeatable `--fallback-collection <child>=<parent>` CLI value into the mapping form `applyCollectionFallbacks` expects. */
export function parseFallbackCollectionArg(spec: string): [child: string, parent: string] {
  const eq = spec.indexOf("=");
  if (eq <= 0 || eq === spec.length - 1) {
    throw new Error(
      `--fallback-collection expects "<child>=<parent>", got ${JSON.stringify(spec)}`,
    );
  }
  return [spec.slice(0, eq), spec.slice(eq + 1)];
}
