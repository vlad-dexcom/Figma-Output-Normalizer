// List collapsing: detects runs of 3+ consecutive siblings that are
// structurally identical (ignoring text content) and collapses them into a
// single `list` node. See concern #5 in the plugin-extractor task
// description.
import type { IRNode, ListNode } from "@figma-normalizator/schema";
import type { FigmaNode } from "./types.js";
import { buildProvenance, type ProvenanceContext } from "./provenance.js";
import { safeReadComponentProperties } from "./instance.js";

const MIN_RUN_LENGTH = 3;

let unreadableSignatureCounter = 0;

/**
 * A deterministic structural signature for a node, deliberately excluding
 * anything that carries textual/content differences (names, characters,
 * literal fill colors) so that "same structure, different copy" siblings
 * compare equal. For instances, the signature includes the sorted set of
 * component-property *names* (not values) as a proxy for "same instance
 * component" — two instances of the same component set expose the same
 * property names, without needing an async `getMainComponentAsync` lookup
 * just to compare structure.
 *
 * `node.componentProperties` is a getter that can throw (see
 * `safeReadComponentProperties` in `instance.ts`) when its component set
 * has broken/conflicting variant definitions in the Figma file itself. If
 * that happens, this node's `componentPropertyNames` is set to a freshly
 * unique marker instead of the (unreadable) property names — this fails
 * safe to "not structurally identical to any other node, including
 * another node that also failed to read" rather than letting the
 * exception propagate and crash the whole list-collapsing pass for every
 * sibling. A plain incrementing counter (rather than reusing `undefined`
 * or omitting the field) guarantees no accidental match even against
 * another broken sibling with an otherwise-identical shape.
 */
function structuralSignature(node: FigmaNode): unknown {
  const { properties, readError, hadProperty } = safeReadComponentProperties(node);
  unreadableSignatureCounter += 1;
  return {
    type: node.type,
    layoutMode: node.layoutMode,
    // Note: intentionally reads via the already-captured `properties`/
    // `hadProperty` result rather than `node.componentProperties`
    // directly — the latter is the throwing getter, and re-accessing it
    // here (even just to check truthiness) would re-throw for a broken
    // component set.
    componentPropertyNames: readError
      ? `__unreadable-component-properties-${unreadableSignatureCounter}__`
      : hadProperty
        ? Object.keys(properties).sort()
        : undefined,
    children: (node.children ?? []).map(structuralSignature),
  };
}

/**
 * Memoized, stringified `structuralSignature`, keyed by node identity.
 *
 * `collapseLists` compares every sibling against its immediate
 * predecessor while scanning for runs, so each node's signature would
 * otherwise be recomputed once per comparison it takes part in (up to
 * twice: once as "current", once as the next candidate) — and
 * `structuralSignature` itself recurses into every descendant, so for a
 * deep/wide subtree that's a lot of repeated work for the same answer.
 * Caching the (already-JSON-stringified, directly comparable) signature
 * per node turns each node's signature into O(1) after the first
 * comparison it appears in, rather than recomputing it from scratch on
 * every comparison. The cache is a plain `Map` scoped to one
 * `collapseLists` call (see below), not a module-level cache, so nothing
 * survives across separate extractions/tests.
 */
function memoizedSignature(node: FigmaNode, cache: Map<FigmaNode, string>): string {
  let cached = cache.get(node);
  if (cached === undefined) {
    cached = JSON.stringify(structuralSignature(node));
    cache.set(node, cached);
  }
  return cached;
}

function sameStructure(a: FigmaNode, b: FigmaNode, cache: Map<FigmaNode, string>): boolean {
  return memoizedSignature(a, cache) === memoizedSignature(b, cache);
}

export interface OrderedChild {
  node: FigmaNode;
  ir: IRNode;
}

/**
 * Scans `items` (in original sibling order) for runs of `MIN_RUN_LENGTH` or
 * more consecutive, structurally-identical, similarly-flowed (both
 * `ABSOLUTE` or both not) siblings, and replaces each such run with one
 * tuple whose `ir` is a `ListNode` (`itemTemplate` = the first item's
 * already-built IR, `itemCount` = the run length). Non-matching runs are
 * passed through unchanged.
 */
export function collapseLists(
  items: readonly OrderedChild[],
  ctx: ProvenanceContext,
): OrderedChild[] {
  const signatureCache = new Map<FigmaNode, string>();
  const result: OrderedChild[] = [];
  let i = 0;
  while (i < items.length) {
    const current = items[i];
    if (!current) {
      i += 1;
      continue;
    }
    let runEnd = i + 1;
    while (runEnd < items.length) {
      const candidate = items[runEnd];
      if (
        !candidate ||
        candidate.node.layoutPositioning !== current.node.layoutPositioning ||
        !sameStructure(candidate.node, current.node, signatureCache)
      ) {
        break;
      }
      runEnd += 1;
    }
    const runLength = runEnd - i;

    if (runLength >= MIN_RUN_LENGTH) {
      const listNode: ListNode = {
        kind: "list",
        itemTemplate: current.ir,
        itemCount: runLength,
        source: buildProvenance(current.node, ctx),
      };
      result.push({ node: current.node, ir: listNode });
    } else {
      for (let j = i; j < runEnd; j += 1) {
        const item = items[j];
        if (item) result.push(item);
      }
    }

    i = runEnd;
  }
  return result;
}
