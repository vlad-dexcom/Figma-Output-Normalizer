// A per-collection property tree, grouping tokens by their slash-separated
// path into nested Kotlin data classes (migration plan, stage 6.2). Ported
// from the old generator's `pipeline/tree.py` `TreeNode`/`insert_token`.
import type { Token } from "@figma-normalizator/schema";

export interface PropertyTreeNode {
  /** The raw path segment this node represents (e.g. "color", "surface"). */
  name: string;
  /** Set when a token exists at exactly this path. */
  token?: Token;
  /** Child segments, in first-inserted order. */
  children: Map<string, PropertyTreeNode>;
}

/**
 * Thrown when one token's path is itself a strict prefix of another's (e.g.
 * "apple/glass-effect" is a token AND "apple/glass-effect/dark-mode" is
 * another) — the tree can't represent both a scalar property and a nested
 * class under the same name without an explicit rule (see
 * `PropertyTreeNode.ownValueKey`); this is only thrown if that rule's
 * reserved key ("value") is itself already taken by a sibling segment,
 * which no real export has hit so far.
 */
export class PropertyPathCollisionError extends Error {
  constructor(
    public readonly path: string,
    public readonly reservedKey: string,
  ) {
    super(
      `token path "${path}" is both a leaf value and a branch with children, and its ` +
        `own-value slot ("${reservedKey}") is already taken by one of those children -- ` +
        `this collection's paths can't be represented as a Kotlin property tree as-is.`,
    );
    this.name = "PropertyPathCollisionError";
  }
}

/** The reserved child key used to hold a branch node's own value when it also has children. */
export const OWN_VALUE_KEY = "value";

function newNode(name: string): PropertyTreeNode {
  return { name, children: new Map() };
}

function insertToken(root: PropertyTreeNode, segments: readonly string[], token: Token): void {
  let node = root;
  for (const segment of segments) {
    let child = node.children.get(segment);
    if (!child) {
      child = newNode(segment);
      node.children.set(segment, child);
    }
    node = child;
  }
  node.token = token;
}

/**
 * Builds a property tree from `tokens`' slash-separated paths, using
 * `sanitizePath`-cleaned segments (ASCII-only, non-empty) as tree edges.
 */
export function buildPropertyTree(
  tokens: readonly Token[],
  sanitizePath: (path: string) => string[],
): PropertyTreeNode {
  const root = newNode("root");
  for (const token of tokens) {
    insertToken(root, sanitizePath(token.path), token);
  }
  resolveOwnValueCollisions(root);
  return root;
}

/**
 * A node that has both its own token AND children can't be represented as
 * a single Kotlin property. Move its own token down into a synthetic
 * `value` child instead, so `node`'s own generated class carries both the
 * nested branches and a `value` property for what used to be its own leaf.
 */
function resolveOwnValueCollisions(node: PropertyTreeNode): void {
  if (node.token && node.children.size > 0) {
    if (node.children.has(OWN_VALUE_KEY)) {
      throw new PropertyPathCollisionError(node.token.path, OWN_VALUE_KEY);
    }
    const valueNode = newNode(OWN_VALUE_KEY);
    valueNode.token = node.token;
    node.token = undefined;
    // Insert first so `value` appears before the branch's own other children.
    const rest = new Map(node.children);
    node.children.clear();
    node.children.set(OWN_VALUE_KEY, valueNode);
    for (const [key, child] of rest) node.children.set(key, child);
  }
  for (const child of node.children.values()) resolveOwnValueCollisions(child);
}

/** Direct children that are pure leaves (a token, no further nesting). */
export function leafChildren(node: PropertyTreeNode): PropertyTreeNode[] {
  return [...node.children.values()].filter((c) => c.token && c.children.size === 0);
}

/** Direct children that are branches (have their own children). */
export function branchChildren(node: PropertyTreeNode): PropertyTreeNode[] {
  return [...node.children.values()].filter((c) => c.children.size > 0);
}
