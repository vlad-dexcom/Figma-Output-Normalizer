// Dependency-order and theme-mode derivation (migration plan, stage 5.5).
//
// `computeBuilderChain` ports the old generator's topological sort
// unchanged (the plan calls that logic correct); only its input changed --
// dependencies are read from the factual `collection.dependsOn` (resolved
// through the model's name index) rather than reconstructed from alias
// paths.
//
// `computeThemeModes` is rebuilt, not ported: the old generator picked "the"
// theme collection by scoring its mode names against a hardcoded keyword
// list (`{light, dark, default, inverted, night, day}`) and dropped modes
// by literal substring match ("ios" for Kotlin, "android" for Swift). Here
// the platform filter survives only as a caller-supplied option, and if
// more than one collection could plausibly drive theme variants after that
// filter, this throws instead of guessing -- see `AmbiguousThemeSourceError`.
import type { TokenCollection } from "@figma-normalizator/schema";
import type { ClassificationReport } from "./classify.js";
import type { TokenModel } from "./types.js";

/** Resolves a collection's `dependsOn` (names) to the `TokenCollection`s they refer to. */
export function resolveDependsOn(
  model: TokenModel,
  collection: TokenCollection,
): TokenCollection[] {
  return collection.dependsOn.map((depName) => {
    const ids = model.idsByName.get(depName) ?? [];
    if (ids.length !== 1) {
      throw new Error(
        ids.length === 0
          ? `collection "${collection.name}" depends on "${depName}", which is not present in this document.`
          : `collection "${collection.name}" depends on "${depName}", but ${ids.length} collections ` +
              `share that name in this document (ids: ${ids.join(", ")}) -- dependsOn records a name, ` +
              `not an id, so which one is meant cannot be determined here.`,
      );
    }
    return model.byId.get(ids[0] as string) as TokenCollection;
  });
}

/**
 * The dependency chain a builder for `leafId` needs, in build order
 * (dependencies before dependents, `leafId` itself excluded), computed by
 * transitive closure over `dependsOn` + a topological sort.
 *
 * When `leafId`'s dependency closure includes more than one member of a
 * detected product group, pass `productCollectionId` to select which one
 * to build for -- every reference to one of its siblings collapses onto it
 * (mirrors the old generator's per-product build: a single Kotlin/Swift
 * build targets one product flavor at a time, not all of them at once).
 */
export function computeBuilderChain(
  model: TokenModel,
  classification: ClassificationReport,
  leafId: string,
  productCollectionId?: string,
): TokenCollection[] {
  const leaf = model.byId.get(leafId);
  if (!leaf) {
    throw new Error(`no collection with id "${leafId}" exists in this document`);
  }

  const depsById = new Map<string, Set<string>>();
  for (const collection of model.collections) {
    depsById.set(collection.id, new Set(resolveDependsOn(model, collection).map((d) => d.id)));
  }

  // Every id in the same product group as `productCollectionId` (its base
  // plus all its sibling flavors), if it names one at all.
  let productSiblingIds = new Set<string>();
  if (productCollectionId) {
    const target = classification.byId.get(productCollectionId);
    const baseId =
      target?.baseCollectionId ?? (target?.role === "semantic" ? productCollectionId : undefined);
    if (baseId) {
      productSiblingIds = new Set(
        classification.entries
          .filter((e) => e.id === baseId || e.baseCollectionId === baseId)
          .map((e) => e.id),
      );
    }
  }

  // A dependency on any OTHER member of that group collapses onto the one
  // being built.
  const effectiveDeps = new Map(depsById);
  if (productCollectionId && productSiblingIds.size > 0) {
    for (const [id, deps] of depsById) {
      if (![...deps].some((d) => productSiblingIds.has(d) && d !== productCollectionId)) continue;
      const collapsed = new Set<string>();
      for (const d of deps) {
        collapsed.add(
          productSiblingIds.has(d) && d !== productCollectionId ? productCollectionId : d,
        );
      }
      effectiveDeps.set(id, collapsed);
    }
  }

  // Transitive closure from the leaf, excluding the leaf itself.
  const allDeps = new Set<string>();
  const collect = (id: string): void => {
    if (allDeps.has(id)) return;
    allDeps.add(id);
    for (const dep of effectiveDeps.get(id) ?? []) collect(dep);
  };
  collect(leafId);
  allDeps.delete(leafId);

  // Topological sort: repeatedly take any remaining collection whose
  // dependencies (within `remaining`) are already satisfied; ties broken
  // by id for determinism.
  const remaining = new Set(allDeps);
  const chain: string[] = [];
  while (remaining.size > 0) {
    const candidates = [...remaining].sort();
    const ready = candidates.find(
      (id) => ![...(effectiveDeps.get(id) ?? [])].some((d) => d !== id && remaining.has(d)),
    );
    const next = (ready ?? candidates[0]) as string;
    chain.push(next);
    remaining.delete(next);
  }

  const filtered =
    productCollectionId && productSiblingIds.size > 0
      ? chain.filter((id) => id === productCollectionId || !productSiblingIds.has(id))
      : chain;

  return filtered.map((id) => model.byId.get(id) as TokenCollection);
}

export interface ThemeModeVariant {
  /** The variant's name (e.g. "light"/"dark"), or `""` when there is no theme variation at all. */
  name: string;
  /** Which of its own declared modes each given collection should use for this variant. */
  modeByCollectionId: ReadonlyMap<string, string>;
}

export interface ThemeModeOptions {
  /**
   * Modes matching this pattern are dropped before a theme driver is
   * chosen (e.g. `/ios/i` for a Kotlin/Android build, `/android/i` for a
   * Swift build) -- a caller-supplied option, never a rule this module
   * bakes in.
   */
  excludeModePattern?: RegExp;
  /** Skip auto-detection and use this collection's modes as the theme driver directly. */
  themeCollectionId?: string;
}

/** Thrown when more than one collection could drive theme variants and no `themeCollectionId` was given to disambiguate. */
export class AmbiguousThemeSourceError extends Error {
  constructor(
    public readonly candidates: readonly {
      readonly id: string;
      readonly name: string;
      readonly modes: readonly string[];
    }[],
  ) {
    super(
      `${candidates.length} collections could each drive theme variants after mode filtering ` +
        `(${candidates.map((c) => `"${c.name}": ${c.modes.join("/")}`).join(", ")}) -- ` +
        `pass themeCollectionId to pick one explicitly.`,
    );
    this.name = "AmbiguousThemeSourceError";
  }
}

/**
 * Derives the theme variants (e.g. light/dark) a builder chain needs to
 * produce, and for each variant, which declared mode every given
 * collection should read from.
 *
 * With no multi-mode collection left after filtering, this returns a
 * single unnamed (`""`) variant -- there is no theme variation to build.
 */
export function computeThemeModes(
  collections: readonly TokenCollection[],
  options: ThemeModeOptions = {},
): ThemeModeVariant[] {
  const filteredModes = new Map<string, readonly string[]>();
  for (const collection of collections) {
    const filtered = options.excludeModePattern
      ? collection.modes.filter((m) => !options.excludeModePattern?.test(m))
      : collection.modes;
    filteredModes.set(collection.id, filtered.length > 0 ? filtered : collection.modes);
  }

  let driver: TokenCollection | undefined;
  if (options.themeCollectionId) {
    driver = collections.find((c) => c.id === options.themeCollectionId);
    if (!driver) {
      throw new Error(
        `themeCollectionId "${options.themeCollectionId}" does not match any of the given collections`,
      );
    }
  } else {
    const candidates = collections.filter((c) => (filteredModes.get(c.id)?.length ?? 0) > 1);
    if (candidates.length > 1) {
      throw new AmbiguousThemeSourceError(
        candidates.map((c) => ({
          id: c.id,
          name: c.name,
          modes: filteredModes.get(c.id) ?? c.modes,
        })),
      );
    }
    driver = candidates[0];
  }

  const variantNames = driver ? (filteredModes.get(driver.id) ?? driver.modes) : [""];

  return variantNames.map((variantName) => {
    const modeByCollectionId = new Map<string, string>();
    for (const collection of collections) {
      const own = filteredModes.get(collection.id) ?? collection.modes;
      if (driver && collection.id === driver.id) {
        modeByCollectionId.set(collection.id, variantName);
      } else if (own.includes(variantName)) {
        modeByCollectionId.set(collection.id, variantName);
      } else {
        const fallback =
          collection.defaultMode && own.includes(collection.defaultMode)
            ? collection.defaultMode
            : own[0];
        modeByCollectionId.set(collection.id, fallback ?? collection.modes[0] ?? variantName);
      }
    }
    return { name: driver ? variantName : "", modeByCollectionId };
  });
}
