// Structural collection classification (migration plan, stage 5.1-5.4, 5.6).
//
// Ported from the old generator's `classify_collections`, on a narrower
// input: `collection.dependsOn` is now a recorded fact
// (schema/tokens/v1/schema.json), not something reconstructed by walking
// alias paths and guessing which collection "owns" a branch -- the old
// `_build_dep_edges`'s three-pass branch-owner lookup and its priority
// ladder are gone, not ported. `collection.defaultMode` similarly replaces
// guessing the primary mode, and `collection.branches` is already in
// first-seen order (never `sorted(set(...))`, which is what destroyed
// default-mode information in the old generator).
//
// The "zero hardcoded names" doctrine carries over unchanged: nothing here
// looks at a collection's or branch's name to decide its role. Product-group
// detection is still structural (branch-set equality, then normalized token
// path overlap), because a collection's Figma NAME is not a semantic
// signal this generator is allowed to depend on.
import type { TokenCollection } from "@figma-normalizator/schema";
import type { TokenModel } from "./types.js";

export type CollectionRole = "primitive" | "semantic" | "product" | "leaf";

export interface CollectionClassification {
  id: string;
  name: string;
  role: CollectionRole;
  /** Set only when `role === "product"`: the id of this group's base (`role === "semantic"`) collection. */
  baseCollectionId?: string;
  /**
   * Why this role was assigned (plan 5.6's classification report). The old
   * generator made this decision invisibly, behind a ">=90% path overlap"
   * threshold and a ">=2 upstream dependencies" rule nobody could see
   * applied to their file.
   */
  reason: string;
}

export interface ClassificationReport {
  /** In the model's own declared collection order. */
  entries: readonly CollectionClassification[];
  byId: ReadonlyMap<string, CollectionClassification>;
}

/** The distinct first path segments in `collection`, each token path with that segment stripped. */
function normalizedPaths(collection: TokenCollection): Set<string> {
  const result = new Set<string>();
  for (const token of collection.tokens) {
    const slash = token.path.indexOf("/");
    result.add(slash === -1 ? token.path : token.path.slice(slash + 1));
  }
  return result;
}

/** A stable key for a collection's branch SET (order-independent -- two collections with the same branches in a different order are the same shape). */
function branchSetKey(collection: TokenCollection): string {
  return [...collection.branches].sort().join("\u0000");
}

/**
 * Greedily groups `candidates` by structural compatibility: two collections
 * are compatible when their normalized path sets overlap >=90% (relative to
 * the smaller set). Mirrors the old generator's `_group_by_structure`
 * exactly -- this heuristic itself is not being changed, only its inputs.
 */
function groupByStructure(candidates: readonly TokenCollection[]): TokenCollection[][] {
  const groups: TokenCollection[][] = [];
  let remaining = [...candidates];

  while (remaining.length > 0) {
    const [leader, ...rest] = remaining;
    const leaderPaths = normalizedPaths(leader as TokenCollection);
    const group: TokenCollection[] = [leader as TokenCollection];
    const stillRemaining: TokenCollection[] = [];

    for (const candidate of rest) {
      const candidatePaths = normalizedPaths(candidate);
      const smaller = Math.min(leaderPaths.size, candidatePaths.size);
      const overlap = [...leaderPaths].filter((p) => candidatePaths.has(p)).length;
      if (smaller > 0 && overlap / smaller >= 0.9) {
        group.push(candidate);
      } else {
        stillRemaining.push(candidate);
      }
    }
    groups.push(group);
    remaining = stillRemaining;
  }

  return groups;
}

/**
 * Classifies every collection in `model` structurally: `primitive` (single
 * declared mode, no collection dependencies), `semantic`/`product` (a
 * detected product group's base vs. its flavors), or `leaf` (>=2 collection
 * dependencies, i.e. a composition point rather than a pass-through) --
 * `semantic` is the default when none of the above apply.
 */
export function classifyCollections(model: TokenModel): ClassificationReport {
  const roles = new Map<string, CollectionRole>();
  const reasons = new Map<string, string>();
  const baseCollectionIds = new Map<string, string>();
  const productGroupBaseIds = new Set<string>();

  // Step 1: primitives -- single mode, no external dependencies.
  for (const collection of model.collections) {
    if (collection.modes.length <= 1 && collection.dependsOn.length === 0) {
      roles.set(collection.id, "primitive");
      reasons.set(collection.id, "single declared mode and no collection dependencies");
    }
  }

  // Step 2: product-group detection among the rest.
  const undecided = model.collections.filter((c) => !roles.has(c.id));
  const byBranchSet = new Map<string, TokenCollection[]>();
  for (const collection of undecided) {
    const key = branchSetKey(collection);
    const bucket = byBranchSet.get(key);
    if (bucket) bucket.push(collection);
    else byBranchSet.set(key, [collection]);
  }
  for (const bucket of byBranchSet.values()) {
    if (bucket.length < 2) continue;
    for (const group of groupByStructure(bucket)) {
      if (group.length < 2) continue;
      const base = group.reduce((best, c) => (c.tokens.length > best.tokens.length ? c : best));
      roles.set(base.id, "semantic");
      reasons.set(
        base.id,
        `product-group base: most tokens (${base.tokens.length}) among ${group.length} ` +
          `structurally identical collections (>=90% normalized-path overlap)`,
      );
      productGroupBaseIds.add(base.id);
      for (const member of group) {
        if (member.id === base.id) continue;
        roles.set(member.id, "product");
        baseCollectionIds.set(member.id, base.id);
        reasons.set(
          member.id,
          `product-group member: >=90% normalized-path overlap with base "${base.name}"`,
        );
      }
    }
  }

  // Step 3: everything still undecided defaults to semantic.
  for (const collection of model.collections) {
    if (!roles.has(collection.id)) {
      roles.set(collection.id, "semantic");
      reasons.set(
        collection.id,
        "default: not a primitive and not part of a detected product group",
      );
    }
  }

  // Step 4: leaf reclassification. A product member/base's role is more
  // specific and must not be overridden by its dependency count (mirrors
  // the old generator's `detect_leaves` priority).
  for (const collection of model.collections) {
    if (roles.get(collection.id) === "product" || productGroupBaseIds.has(collection.id)) continue;
    if (collection.dependsOn.length >= 2) {
      roles.set(collection.id, "leaf");
      reasons.set(
        collection.id,
        `${collection.dependsOn.length} collection dependencies ` +
          `(${collection.dependsOn.join(", ")}) -- at least 2 makes this a composition point, ` +
          `not a simple pass-through`,
      );
    }
  }

  const entries: CollectionClassification[] = model.collections.map((collection) => ({
    id: collection.id,
    name: collection.name,
    role: roles.get(collection.id) as CollectionRole,
    reason: reasons.get(collection.id) as string,
    ...(baseCollectionIds.has(collection.id)
      ? { baseCollectionId: baseCollectionIds.get(collection.id) }
      : {}),
  }));

  return { entries, byId: new Map(entries.map((e) => [e.id, e])) };
}
