// File-scoped design-token extraction: walks every Figma variable collection
// the policy keeps, resolves each variable's value per mode, and emits a
// `TokenDocument` conforming to schema/tokens/v1/schema.json.
//
// This is the token-side counterpart to `./index.ts` (which extracts a
// *selection* of the scene graph). The two are split by cadence, not by
// subject matter: tokens are file-scoped and change rarely, screens are
// selection-scoped and change constantly.
//
// Why this belongs in the plugin at all, rather than in a downstream
// generator reading a raw variables dump:
//
//   - A raw dump cannot resolve its own alias graph. In a real production
//     file, 71% of mode values were aliases and 327 alias targets were
//     dangling — referenced ids that simply were not in the payload. The
//     Plugin API's `getVariableByIdAsync` resolves imported/remote library
//     variables, so that entire failure class disappears here.
//   - Mode *names* and the default mode are only meaningful on this side;
//     downstream they had been reduced to an alphabetically sorted list,
//     losing which mode was primary.
//   - `scopes` (is this FLOAT a radius or a gap?) exists only here.
//
// Three invariants this module holds, all of them reactions to observed
// data loss in the pipeline this replaces:
//
//   1. **No silent drops.** Every input variable is either emitted in
//      `collections` or recorded in `unresolved`. Never neither.
//   2. **Alias edges are facts; resolved literals are a view.** Both are
//      emitted, because a leaf collection with one mode aliasing into a
//      light/dark collection has values that are actively misleading on
//      their own.
//   3. **Figma's declared order is content.** Mode order is never sorted.
import type {
  PolicyReport,
  Token,
  TokenCollection,
  TokenDocument,
  UnresolvedToken,
} from "@figma-normalizator/schema";
import { createPolicyEvaluator, resolveTokenSymbol } from "@figma-normalizator/mappings";
import type {
  FigmaVariable,
  FigmaVariableCollection,
  TokenExportFigmaAPI,
  TokenExportSource,
} from "./types.js";
import { colorToHex } from "./tokens.js";
import { canonicalStringify } from "./canonical.js";
import { computeContentVersion } from "./versioning.js";
import { VariableBudget } from "./budget.js";

/** Matches `resolveModeValue`'s hop limit in ./tokens.ts, for the same reason: a cycle guard, not a real depth. */
const MAX_ALIAS_DEPTH = 10;

export interface TokenExportResult {
  document: TokenDocument;
  /** Variables visited, for the UI's progress/summary line. */
  variableCount: number;
  /** Collections skipped by policy, for the UI warning panel. */
  skippedCollections: { name: string; reason: string }[];
}

function isVariableAlias(raw: unknown): raw is { type: "VARIABLE_ALIAS"; id: string } {
  return (
    typeof raw === "object" &&
    raw !== null &&
    (raw as { type?: unknown }).type === "VARIABLE_ALIAS" &&
    typeof (raw as { id?: unknown }).id === "string"
  );
}

function isRgb(raw: unknown): raw is { r: number; g: number; b: number; a?: number } {
  return typeof raw === "object" && raw !== null && "r" in raw && "g" in raw && "b" in raw;
}

/** A literal `valuesByMode` entry, converted to the schema's value domain. */
function toLiteral(raw: unknown): string | number | boolean | null {
  if (typeof raw === "number" || typeof raw === "string" || typeof raw === "boolean") return raw;
  if (isRgb(raw)) return colorToHex(raw);
  return null;
}

interface ResolutionContext {
  figma: TokenExportFigmaAPI;
  /** Collections by id, populated lazily: alias chains routinely leave the collections we enumerate. */
  collectionCache: Map<string, FigmaVariableCollection | null>;
  variableCache: Map<string, FigmaVariable | null>;
  isExcludedCollection(collection: FigmaVariableCollection | null): boolean;
}

async function getVariable(ctx: ResolutionContext, id: string): Promise<FigmaVariable | null> {
  const cached = ctx.variableCache.get(id);
  if (cached !== undefined) return cached;
  let resolved: FigmaVariable | null = null;
  try {
    resolved = await ctx.figma.variables.getVariableByIdAsync(id);
  } catch {
    // A deleted or inaccessible variable id: treated as "missing", which the
    // caller turns into a `missing-alias-target` entry. Swallowed here (and
    // not rethrown) because one bad id must not abort a whole-file export.
    resolved = null;
  }
  ctx.variableCache.set(id, resolved);
  return resolved;
}

async function getCollection(
  ctx: ResolutionContext,
  id: string,
): Promise<FigmaVariableCollection | null> {
  const cached = ctx.collectionCache.get(id);
  if (cached !== undefined) return cached;
  let resolved: FigmaVariableCollection | null = null;
  try {
    resolved = await ctx.figma.variables.getVariableCollectionByIdAsync(id);
  } catch {
    resolved = null;
  }
  ctx.collectionCache.set(id, resolved);
  return resolved;
}

interface ModeResolution {
  value: string | number | boolean | null;
  /** The first alias hop, i.e. what this token *points at* — not the end of the chain. */
  alias?: { collection: string | null; path: string | null; excluded?: boolean };
  unresolved?: { reason: UnresolvedToken["reason"]; detail: string };
}

/**
 * Resolves one `valuesByMode` entry to a literal, following `VARIABLE_ALIAS`
 * chains.
 *
 * Cross-collection mode matching works exactly as in `./tokens.ts`: prefer a
 * mode with the same *name* on the aliased variable's own collection, and
 * fall back to that collection's default mode when no same-named mode
 * exists. This is the single most important behaviour to get right, because
 * it is what makes a single-mode leaf collection resolve correctly against a
 * light/dark semantic collection.
 *
 * Returns the FIRST hop as `alias` (what the designer actually wrote), not
 * the chain's terminus — the edge is what a consumer needs to re-expand
 * modes; the terminus is already captured as `value`.
 */
async function resolveMode(
  ctx: ResolutionContext,
  raw: unknown,
  modeName: string,
  depth: number,
  visited: readonly string[],
  firstHop?: ModeResolution["alias"],
): Promise<ModeResolution> {
  if (!isVariableAlias(raw)) {
    return { value: toLiteral(raw), ...(firstHop ? { alias: firstHop } : {}) };
  }

  if (depth >= MAX_ALIAS_DEPTH || visited.includes(raw.id)) {
    return {
      value: null,
      ...(firstHop ? { alias: firstHop } : {}),
      unresolved: {
        reason: "unresolvable-alias-chain",
        detail: `Alias chain from ${visited[0] ?? "?"} is circular or exceeds ${MAX_ALIAS_DEPTH} hops (re-entered ${raw.id}).`,
      },
    };
  }

  const target = await getVariable(ctx, raw.id);
  if (!target) {
    return {
      value: null,
      alias: firstHop ?? { collection: null, path: null },
      unresolved: {
        reason: "missing-alias-target",
        detail: `Alias target ${raw.id} could not be resolved in mode "${modeName}".`,
      },
    };
  }

  const targetCollection = await getCollection(ctx, target.variableCollectionId);
  const targetExcluded = ctx.isExcludedCollection(targetCollection);
  const hop = firstHop ?? {
    collection: targetCollection?.name ?? null,
    path: target.name,
    ...(targetExcluded ? { excluded: true } : {}),
  };

  const modeNameById = new Map((targetCollection?.modes ?? []).map((m) => [m.modeId, m.name]));
  let targetModeId: string | undefined;
  for (const [id, name] of modeNameById) {
    if (name === modeName) {
      targetModeId = id;
      break;
    }
  }
  targetModeId ??= targetCollection?.defaultModeId;

  const nextModeName = (targetModeId ? modeNameById.get(targetModeId) : undefined) ?? modeName;
  const nextRaw = targetModeId !== undefined ? target.valuesByMode[targetModeId] : undefined;

  const resolved = await resolveMode(
    ctx,
    nextRaw,
    nextModeName,
    depth + 1,
    [...visited, raw.id],
    hop,
  );

  // An alias into an excluded collection still resolves to a literal (that
  // is the documented fallback), but the fallback is reported rather than
  // silently taken, so nobody later wonders why a token has a literal where
  // a reference was expected.
  if (targetExcluded && resolved.unresolved === undefined) {
    return {
      ...resolved,
      unresolved: {
        reason: "excluded-collection-alias",
        detail: `Mode "${modeName}" aliases "${target.name}" in excluded collection "${targetCollection?.name ?? "?"}"; using the resolved literal value instead.`,
      },
    };
  }
  return resolved;
}

/**
 * Builds one `Token` from a Figma variable, resolving every mode its owning
 * collection declares (not merely the modes present in `valuesByMode`, which
 * can be sparse).
 */
async function buildToken(
  ctx: ResolutionContext,
  variable: FigmaVariable,
  collection: FigmaVariableCollection,
  collectionName: string,
): Promise<{ token: Token; unresolved: UnresolvedToken[] }> {
  const unresolved: UnresolvedToken[] = [];
  const modes: Record<string, string | number | boolean | null> = {};
  const aliasByMode: Record<
    string,
    { collection: string | null; path: string | null; excluded?: boolean }
  > = {};

  for (const mode of collection.modes) {
    const raw = variable.valuesByMode[mode.modeId];
    const resolved = await resolveMode(ctx, raw, mode.name, 0, [variable.id ?? variable.name]);
    modes[mode.name] = resolved.value;
    if (resolved.alias) aliasByMode[mode.name] = resolved.alias;
    if (resolved.unresolved) {
      unresolved.push({
        collection: collectionName,
        path: variable.name,
        reason: resolved.unresolved.reason,
        detail: resolved.unresolved.detail,
      });
    }
  }

  const defaultModeName =
    collection.modes.find((m) => m.modeId === collection.defaultModeId)?.name ??
    collection.modes[0]?.name;
  const value = defaultModeName !== undefined ? (modes[defaultModeName] ?? null) : null;

  const symbolResolution = resolveTokenSymbol(collectionName, variable.name);
  const codeSyntax = variable.codeSyntax ?? {};

  const token: Token = {
    path: variable.name,
    type: variable.resolvedType ?? "STRING",
    value,
    modes,
    ...(Object.keys(aliasByMode).length > 0 ? { alias: { byMode: aliasByMode } } : {}),
    ...(variable.scopes && variable.scopes.length > 0 ? { scopes: [...variable.scopes] } : {}),
    ...(variable.description ? { description: variable.description } : {}),
    ...(variable.hiddenFromPublishing ? { hidden: true } : {}),
    ...(variable.deletedButReferenced ? { deleted: true } : {}),
    ...(symbolResolution.symbol !== null
      ? {
          symbol: symbolResolution.symbol,
          ...(symbolResolution.from ? { symbolFrom: symbolResolution.from } : {}),
        }
      : {}),
    ...(Object.keys(codeSyntax).length > 0 ? { hints: { codeSyntax: { ...codeSyntax } } } : {}),
  };

  return { token, unresolved };
}

/**
 * Extracts every in-policy variable collection in the current Figma file.
 *
 * `version` is derived from the assembled document itself (content hash),
 * so re-exporting unchanged content produces byte-identical output — the
 * same guarantee, and the same mechanism, as the node IR.
 */
export async function extractTokens(
  figma: TokenExportFigmaAPI,
  source: TokenExportSource,
): Promise<TokenExportResult> {
  const policy = createPolicyEvaluator(source.policy);
  const budget = new VariableBudget(source.variableBudget);

  const allCollections = (await figma.variables.getLocalVariableCollectionsAsync?.()) ?? [];

  const collectionCache = new Map<string, FigmaVariableCollection | null>();
  for (const collection of allCollections) {
    if (collection.id) collectionCache.set(collection.id, collection);
  }

  const excludedCollectionIds = new Set<string>();
  const skippedCollections: { name: string; reason: string }[] = [];
  const kept: FigmaVariableCollection[] = [];

  for (const collection of allCollections) {
    const name = collection.name ?? "";
    const decision = policy.collection(name, collection.remote ?? false);
    if (decision.excluded) {
      if (collection.id) excludedCollectionIds.add(collection.id);
      skippedCollections.push({ name, reason: decision.reason ?? "excluded by policy" });
    } else {
      kept.push(collection);
    }
  }

  const ctx: ResolutionContext = {
    figma,
    collectionCache,
    variableCache: new Map(),
    isExcludedCollection(collection) {
      if (!collection) return false;
      if (collection.id && excludedCollectionIds.has(collection.id)) return true;
      // An alias can leave the enumerated set entirely (into an imported
      // library). Re-evaluating the policy by name covers that case without
      // needing the collection to have been enumerated first.
      return policy.collection(collection.name ?? "", collection.remote ?? false).excluded;
    },
  };

  const collections: TokenCollection[] = [];
  const unresolved: UnresolvedToken[] = [];
  let variableCount = 0;

  for (const collection of kept) {
    const collectionName = collection.name ?? "";
    const tokens: Token[] = [];
    const branches: string[] = [];
    const dependsOn = new Set<string>();

    for (const variableId of collection.variableIds ?? []) {
      await budget.tick();
      variableCount += 1;

      const variable = await getVariable(ctx, variableId);
      if (!variable) {
        unresolved.push({
          collection: collectionName,
          path: variableId,
          reason: "missing-alias-target",
          detail: `Variable ${variableId} is listed by collection "${collectionName}" but could not be read.`,
        });
        continue;
      }

      const branchDecision = policy.branch(collectionName, variable.name);
      if (branchDecision.excluded) {
        unresolved.push({
          collection: collectionName,
          path: variable.name,
          reason: "excluded-by-policy",
          detail: branchDecision.reason ?? "excluded by policy",
        });
        continue;
      }

      const built = await buildToken(ctx, variable, collection, collectionName);
      tokens.push(built.token);
      unresolved.push(...built.unresolved);

      const branch = variable.name.split("/")[0];
      if (branch && !branches.includes(branch)) branches.push(branch);
      for (const edge of Object.values(built.token.alias?.byMode ?? {})) {
        // An excluded collection is never emitted, so depending on it would
        // be a dangling dependency — the same contract the platform's
        // collections.toml states as "generated code never references a
        // class that was not produced". The edge itself is still recorded on
        // the token (flagged `excluded`), so nothing is lost, but it must
        // not appear in the build-order summary.
        if (edge.collection && edge.collection !== collectionName && !edge.excluded) {
          dependsOn.add(edge.collection);
        }
      }
    }

    collections.push({
      name: collectionName,
      id: collection.id ?? "",
      remote: collection.remote ?? false,
      ...(collection.hiddenFromPublishing !== undefined
        ? { hidden: collection.hiddenFromPublishing }
        : {}),
      defaultMode:
        collection.modes.find((m) => m.modeId === collection.defaultModeId)?.name ?? null,
      // Figma's declared order, deliberately not sorted — see the module header.
      modes: collection.modes.map((m) => m.name),
      branches,
      dependsOn: [...dependsOn].sort(),
      tokens,
    });
  }

  const policyReport: PolicyReport = policy.report(policy.unmatchedPatterns());

  const payload = { policy: policyReport, collections, unresolved };
  const version = source.version ?? computeContentVersion(payload as never);

  return {
    document: {
      envelope: { schemaVersion: 1, kind: "tokens", fileKey: source.fileKey, version },
      ...payload,
    },
    variableCount,
    skippedCollections,
  };
}

/** Serializes a token document exactly as the export path does (canonical key order). */
export function serializeTokenDocument(document: TokenDocument): string {
  return canonicalStringify(document, 2);
}
