// Token resolution: turns a raw Figma value (a fill color, a spacing number,
// a corner radius, a typography style) plus its `boundVariables` entry into
// a schema `TokenValue`/`TokenRef`, or a `token: null` literal + an
// UnresolvedEntry with reason "unbound-literal" when there's no bound
// variable. See concern #3 in the plugin-extractor task description.
import type { TokenValue, TokenRef, UnresolvedEntry } from "@figma-normalizator/schema";
import { resolveTokenSymbol } from "@figma-normalizator/mappings";
import type { FigmaAPI, FigmaPaint, VariableAliasBinding } from "./types.js";
import { isMixed } from "./mixed.js";

export interface TokenResolutionResult<T> {
  token: T;
  unresolved: UnresolvedEntry[];
}

/**
 * Builds the `{ token: null }` + `UnresolvedEntry` shape for a raw Figma
 * value that turned out to be the `figma.mixed` sentinel (see `./mixed.ts`)
 * rather than a scalar — mirroring `resolveTokenValue`'s own `{ token:
 * null, ... }` shape for an unbound literal, but with a distinct
 * `"mixed-value"` reason: this is a value that genuinely has no single
 * representation, not one that merely lacks a bound variable.
 */
export function mixedValueResult<T>(
  nodeId: string,
  detail: string,
): TokenResolutionResult<T | null> {
  return {
    token: null,
    unresolved: [{ nodeId, reason: "mixed-value", detail }],
  };
}

/**
 * Thrown internally by `resolveModeValue` when a `VARIABLE_ALIAS` chain
 * turns out to be circular or exceeds `MAX_ALIAS_DEPTH`. Callers
 * (`resolveTokenValue`/`resolveTypographyToken`) catch this specifically
 * (as opposed to a generic resolution failure) so they can emit the more
 * specific `"unresolvable-alias-chain"` UnresolvedEntry reason instead of
 * the generic `"unbound-literal"`.
 */
export class UnresolvableAliasChainError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UnresolvableAliasChainError";
  }
}

/**
 * Guards against a malformed circular alias chain (or a pathologically
 * long, non-circular one) in the Figma file hanging the plugin sandbox in
 * an infinite loop. 10 hops is far beyond any real design-token alias
 * chain (semantic -> semantic -> primitive is 2), so hitting this is a
 * strong signal of a cycle rather than a legitimate deep chain.
 */
const MAX_ALIAS_DEPTH = 10;

/** Narrows a raw `valuesByMode` entry to the `VARIABLE_ALIAS` shape. */
function isVariableAliasValue(raw: unknown): raw is { type: "VARIABLE_ALIAS"; id: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (raw as { id?: unknown }).id === "string"
  );
}

function toHex(component: number): string {
  const clamped = Math.max(0, Math.min(255, Math.round(component * 255)));
  return clamped.toString(16).padStart(2, "0").toUpperCase();
}

/** Converts a Figma `RGB`/`RGBA` paint color to a `#RRGGBB` (or `#RRGGBBAA`) hex string. */
export function colorToHex(color: { r: number; g: number; b: number; a?: number }): string {
  const hex = `#${toHex(color.r)}${toHex(color.g)}${toHex(color.b)}`;
  if (color.a !== undefined && color.a < 1) {
    return hex + toHex(color.a);
  }
  return hex;
}

/**
 * Resolves a single raw `valuesByMode` entry to a scalar, following
 * `VARIABLE_ALIAS` chains recursively (a semantic token aliasing another
 * semantic token aliasing a primitive, etc — see the "Variable alias
 * resolution" section of `plugin/README.md`).
 *
 * `modeName` is the *name* (not id) of the mode we're resolving for, from
 * the perspective of the variable that owns `raw`. When `raw` is an alias,
 * the aliased variable may belong to a different collection with a
 * different set of mode ids (Figma allows this) — we look up a mode with
 * the *same name* on the aliased variable's own collection, and fall back
 * to the aliased variable's default mode when no same-named mode exists.
 * See `plugin/README.md` for the full rationale.
 *
 * `depth`/`visited` guard against a circular or pathologically deep alias
 * chain: `visited` accumulates every variable id already entered along
 * this chain (starting with the top-level variable being resolved), and
 * `depth` counts alias hops taken so far. Hitting either throws
 * `UnresolvableAliasChainError`, which `resolveTokenValue`/
 * `resolveTypographyToken` catch and turn into an
 * `"unresolvable-alias-chain"` UnresolvedEntry rather than hanging or
 * propagating a raw stack overflow.
 */
async function resolveModeValue(
  figma: FigmaAPI,
  raw: unknown,
  modeName: string,
  depth: number,
  visited: readonly string[],
): Promise<string | number> {
  if (typeof raw === "number") return raw;
  if (typeof raw === "string") return raw;
  if (raw && typeof raw === "object" && "r" in raw) {
    return colorToHex(raw as { r: number; g: number; b: number; a?: number });
  }
  if (isVariableAliasValue(raw)) {
    if (depth >= MAX_ALIAS_DEPTH || visited.includes(raw.id)) {
      throw new UnresolvableAliasChainError(
        `Alias chain starting at variable ${visited[0]} is circular or exceeds the max depth of ${MAX_ALIAS_DEPTH} (hit variable ${raw.id} again, or too many hops).`,
      );
    }

    const aliasedVariable = await figma.variables.getVariableByIdAsync(raw.id);
    if (!aliasedVariable) {
      throw new Error(`Variable ${raw.id} could not be resolved`);
    }
    const aliasedCollection = await figma.variables.getVariableCollectionByIdAsync(
      aliasedVariable.variableCollectionId,
    );
    const aliasedModeNameById = new Map(
      (aliasedCollection?.modes ?? []).map((m) => [m.modeId, m.name]),
    );

    // Prefer a mode with the same *name* on the aliased variable's own
    // collection; if none matches (cross-collection alias with a
    // differently-named/structured mode set), fall back to the aliased
    // variable's own default mode rather than producing `undefined`.
    let targetModeId: string | undefined;
    for (const [id, name] of aliasedModeNameById) {
      if (name === modeName) {
        targetModeId = id;
        break;
      }
    }
    targetModeId ??= aliasedCollection?.defaultModeId;

    const targetModeName =
      (targetModeId ? aliasedModeNameById.get(targetModeId) : undefined) ?? modeName;
    const aliasedRaw =
      targetModeId !== undefined ? aliasedVariable.valuesByMode[targetModeId] : undefined;

    return resolveModeValue(figma, aliasedRaw, targetModeName, depth + 1, [...visited, raw.id]);
  }
  return String(raw);
}

/**
 * Resolves a single bound variable id to a `TokenValue`-shaped
 * `{ token, collection, value, modes?, symbol? }`, reading `variable.name`
 * verbatim as the token path (Figma variable names already use `/` as a
 * path separator) and `valuesByMode` + the owning collection's mode names
 * for `modes`.
 *
 * `collection` is the owning collection's **name**, and it is part of the
 * token's identity, not decoration: sibling collections routinely define
 * the same path with different values, so a bare path is ambiguous. It is
 * also what `symbol` resolution keys on.
 *
 * `symbol` comes from evaluating the declarative wiring rules
 * (`@figma-normalizator/mappings`'s `resolveTokenSymbol`) against this
 * exact `(collection, token)` pair — the outer/semantic variable's own
 * name, never an inner primitive it aliases through, since alias resolution
 * above only ever affects `value`/`modes`. When no rule derives a symbol
 * (most tokens today), `symbol`/`symbolFrom` are simply omitted; that is
 * the expected default, not a hygiene issue, so no `UnresolvedEntry` is
 * raised for it.
 */
export async function resolveVariable(
  figma: FigmaAPI,
  variableId: string,
): Promise<{
  token: string;
  collection: string | null;
  value: string | number;
  modes?: Record<string, string | number>;
  symbol?: string;
  symbolFrom?: string;
}> {
  const variable = await figma.variables.getVariableByIdAsync(variableId);
  if (!variable) {
    // A bound variable id that no longer resolves (deleted/inaccessible
    // variable). Treated the same as "no binding" by the caller.
    throw new Error(`Variable ${variableId} could not be resolved`);
  }

  const collection = await figma.variables.getVariableCollectionByIdAsync(
    variable.variableCollectionId,
  );

  const modeEntries = Object.entries(variable.valuesByMode) as [string, unknown][];
  const modeNameById = new Map((collection?.modes ?? []).map((m) => [m.modeId, m.name]));

  const modes: Record<string, string | number> = {};
  for (const [modeId, raw] of modeEntries) {
    const modeName = modeNameById.get(modeId) ?? modeId;
    modes[modeName] = await resolveModeValue(figma, raw, modeName, 0, [variableId]);
  }

  const modeNames = Object.keys(modes);
  const defaultModeId = collection?.defaultModeId;
  const defaultModeName = defaultModeId
    ? (modeNameById.get(defaultModeId) ?? defaultModeId)
    : undefined;
  const value =
    (defaultModeName && modes[defaultModeName] !== undefined
      ? modes[defaultModeName]
      : undefined) ??
    modes[modeNames[0] ?? ""] ??
    "";

  const collectionName = collection?.name ?? null;
  const symbolResolution = resolveTokenSymbol(collectionName, variable.name);

  return {
    token: variable.name,
    collection: collectionName,
    value,
    modes: modeNames.length > 1 ? modes : undefined,
    symbol: symbolResolution.symbol ?? undefined,
    symbolFrom: symbolResolution.symbol !== null ? (symbolResolution.from ?? undefined) : undefined,
  };
}

/** Extracts the single bound-variable id for `field`, if any (never an array field). */
function singleBinding(
  boundVariables:
    Record<string, VariableAliasBinding | VariableAliasBinding[] | undefined> | undefined,
  field: string,
): string | undefined {
  const binding = boundVariables?.[field];
  if (!binding) return undefined;
  if (Array.isArray(binding)) return binding[0]?.id;
  return binding.id;
}

/**
 * Resolves a scalar (color/spacing/radius) value to a `TokenValue`. If
 * `boundVariables[field]` has no binding, emits `{ token: null, value:
 * rawValue }` plus an `unbound-literal` UnresolvedEntry rather than
 * inventing a token path.
 */
export async function resolveTokenValue(
  figma: FigmaAPI,
  nodeId: string,
  boundVariables:
    Record<string, VariableAliasBinding | VariableAliasBinding[] | undefined> | undefined,
  field: string,
  rawValue: string | number,
): Promise<TokenResolutionResult<TokenValue>> {
  const variableId = singleBinding(boundVariables, field);
  if (!variableId) {
    return {
      token: { token: null, value: rawValue },
      unresolved: [
        {
          nodeId,
          reason: "unbound-literal",
          detail: `Field "${field}" has no bound variable; using raw literal value.`,
        },
      ],
    };
  }

  try {
    const resolved = await resolveVariable(figma, variableId);
    return { token: resolved, unresolved: [] };
  } catch (error) {
    if (error instanceof UnresolvableAliasChainError) {
      return {
        token: { token: null, value: rawValue },
        unresolved: [
          {
            nodeId,
            reason: "unresolvable-alias-chain",
            detail: `Field "${field}" is bound to variable ${variableId}, whose alias chain is circular or exceeds the max depth of ${MAX_ALIAS_DEPTH}; using raw literal value.`,
          },
        ],
      };
    }
    return {
      token: { token: null, value: rawValue },
      unresolved: [
        {
          nodeId,
          reason: "unbound-literal",
          detail: `Field "${field}" is bound to variable ${variableId}, but it could not be resolved.`,
        },
      ],
    };
  }
}

/**
 * Resolves a fill/paint array's first visible SOLID paint to a `TokenValue`.
 * Returns `null` (not an unresolved entry) when there is no visible solid
 * paint at all — that's "no color", not "an unresolved color".
 */
export async function resolveFillColor(
  figma: FigmaAPI,
  nodeId: string,
  fills: readonly FigmaPaint[] | symbol | undefined,
  boundVariables:
    Record<string, VariableAliasBinding | VariableAliasBinding[] | undefined> | undefined,
): Promise<TokenResolutionResult<TokenValue | null>> {
  if (isMixed(fills)) {
    // The node has multiple sets of fills (e.g. per-character text fills
    // observed at the node level) — there is no single fill color to
    // resolve, so surface a clear warning rather than passing a `Symbol`
    // into `colorToHex`/onward toward `postMessage`.
    return mixedValueResult(
      nodeId,
      'Field "fills" is mixed (this node has multiple sets of fills) and cannot be represented as a single color; consider using a uniform fill or documenting the intended per-fill values separately.',
    );
  }
  const paint = (fills ?? []).find((f) => f.type === "SOLID" && f.visible !== false);
  if (!paint || !paint.color) {
    return { token: null, unresolved: [] };
  }
  return resolveTokenValue(figma, nodeId, boundVariables, "fills", colorToHex(paint.color));
}

/**
 * Resolves a typography style to a `TokenRef`. `boundVariables` here is
 * expected to come from a single styled text segment (see
 * `getStyledTextSegments`); the segment's `fontName`/`fontSize` bindings
 * (or lack thereof) determine whether this resolves to a named style or a
 * `token: null` unbound literal.
 */
export async function resolveTypographyToken(
  figma: FigmaAPI,
  nodeId: string,
  boundVariables:
    Record<string, VariableAliasBinding | VariableAliasBinding[] | undefined> | undefined,
): Promise<TokenResolutionResult<TokenRef>> {
  const variableId =
    singleBinding(boundVariables, "fontName") ?? singleBinding(boundVariables, "fontSize");
  if (!variableId) {
    return {
      token: { token: null },
      unresolved: [
        {
          nodeId,
          reason: "unbound-literal",
          detail: "Text style has no bound typography variable; using raw literal font.",
        },
      ],
    };
  }
  try {
    const resolved = await resolveVariable(figma, variableId);
    return {
      token: {
        token: resolved.token,
        collection: resolved.collection,
        symbol: resolved.symbol,
        symbolFrom: resolved.symbolFrom,
      },
      unresolved: [],
    };
  } catch (error) {
    if (error instanceof UnresolvableAliasChainError) {
      return {
        token: { token: null },
        unresolved: [
          {
            nodeId,
            reason: "unresolvable-alias-chain",
            detail: `Typography is bound to variable ${variableId}, whose alias chain is circular or exceeds the max depth of ${MAX_ALIAS_DEPTH}.`,
          },
        ],
      };
    }
    return {
      token: { token: null },
      unresolved: [
        {
          nodeId,
          reason: "unbound-literal",
          detail: `Typography is bound to variable ${variableId}, but it could not be resolved.`,
        },
      ],
    };
  }
}
