import { describe, expect, it, vi } from "vitest";
import { createCachingVariablesAPI } from "../variableCache.js";
import type { FigmaVariable, FigmaVariableCollection, FigmaVariablesAPI } from "../types.js";

function buildInner(): {
  inner: FigmaVariablesAPI;
  getVariableByIdAsync: ReturnType<typeof vi.fn>;
  getVariableCollectionByIdAsync: ReturnType<typeof vi.fn>;
} {
  const variable: FigmaVariable = {
    name: "color/text/primary",
    variableCollectionId: "collection-1",
    valuesByMode: { "mode-1": "#000000" },
  };
  const collection: FigmaVariableCollection = {
    modes: [{ modeId: "mode-1", name: "Light" }],
    defaultModeId: "mode-1",
  };
  const getVariableByIdAsync = vi.fn(async (id: string) => (id === "variable-1" ? variable : null));
  const getVariableCollectionByIdAsync = vi.fn(async (id: string) =>
    id === "collection-1" ? collection : null,
  );
  return {
    inner: { getVariableByIdAsync, getVariableCollectionByIdAsync },
    getVariableByIdAsync,
    getVariableCollectionByIdAsync,
  };
}

describe("createCachingVariablesAPI", () => {
  it("only calls the wrapped API once per variable id across repeated lookups", async () => {
    const { inner, getVariableByIdAsync } = buildInner();
    const cached = createCachingVariablesAPI(inner);

    const [a, b, c] = await Promise.all([
      cached.getVariableByIdAsync("variable-1"),
      cached.getVariableByIdAsync("variable-1"),
      cached.getVariableByIdAsync("variable-1"),
    ]);

    expect(getVariableByIdAsync).toHaveBeenCalledTimes(1);
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it("only calls the wrapped API once per collection id across repeated lookups", async () => {
    const { inner, getVariableCollectionByIdAsync } = buildInner();
    const cached = createCachingVariablesAPI(inner);

    await cached.getVariableCollectionByIdAsync("collection-1");
    await cached.getVariableCollectionByIdAsync("collection-1");

    expect(getVariableCollectionByIdAsync).toHaveBeenCalledTimes(1);
  });

  it("caches distinct ids independently", async () => {
    const { inner, getVariableByIdAsync } = buildInner();
    const cached = createCachingVariablesAPI(inner);

    await cached.getVariableByIdAsync("variable-1");
    await cached.getVariableByIdAsync("variable-missing");
    await cached.getVariableByIdAsync("variable-1");
    await cached.getVariableByIdAsync("variable-missing");

    expect(getVariableByIdAsync).toHaveBeenCalledTimes(2);
  });

  it("does not mutate the wrapped API's behavior for a fresh cache instance", async () => {
    const { inner } = buildInner();
    const cachedA = createCachingVariablesAPI(inner);
    const cachedB = createCachingVariablesAPI(inner);

    await cachedA.getVariableByIdAsync("variable-1");
    await cachedB.getVariableByIdAsync("variable-1");

    // Two independently-created caches (i.e. two separate extractSelection
    // calls) don't share state.
    expect(vi.mocked(inner.getVariableByIdAsync)).toHaveBeenCalledTimes(2);
  });
});
