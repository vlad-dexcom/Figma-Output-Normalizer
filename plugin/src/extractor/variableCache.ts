// Memoizes `figma.variables.getVariableByIdAsync` /
// `getVariableCollectionByIdAsync` for the lifetime of a single
// `extractSelection` call (see backlog item "variable-cache").
//
// A real screen's IR routinely re-resolves the same handful of design
// tokens (e.g. a shared `color/text/primary` variable, or the collection
// backing it) from dozens of different nodes and fields. Each of those
// lookups was previously a fresh round-trip into the Plugin API for a
// value that cannot change mid-extraction (the whole extraction runs
// synchronously against one snapshot of the document). Caching keyed by
// id turns that from O(nodes × fields) API calls into O(distinct
// variables/collections referenced), which is typically far smaller.
//
// In-flight promises are cached too (not just resolved values), so two
// concurrent lookups for the same id started before either resolves (this
// extractor `Promise.all`s many fields per node) still share one
// underlying API call rather than racing duplicate requests.
import type { FigmaVariable, FigmaVariableCollection, FigmaVariablesAPI } from "./types.js";

/**
 * Wraps a `FigmaVariablesAPI` with a per-id memoization cache. Intended to
 * be created once per `extractSelection` call and threaded through via the
 * `figma` parameter every extractor function already receives — see
 * `extractSelection` in `./index.ts`.
 */
export function createCachingVariablesAPI(inner: FigmaVariablesAPI): FigmaVariablesAPI {
  const variableCache = new Map<string, Promise<FigmaVariable | null>>();
  const collectionCache = new Map<string, Promise<FigmaVariableCollection | null>>();

  return {
    getVariableByIdAsync(id: string): Promise<FigmaVariable | null> {
      let cached = variableCache.get(id);
      if (!cached) {
        cached = inner.getVariableByIdAsync(id);
        variableCache.set(id, cached);
      }
      return cached;
    },
    getVariableCollectionByIdAsync(id: string): Promise<FigmaVariableCollection | null> {
      let cached = collectionCache.get(id);
      if (!cached) {
        cached = inner.getVariableCollectionByIdAsync(id);
        collectionCache.set(id, cached);
      }
      return cached;
    },
  };
}
