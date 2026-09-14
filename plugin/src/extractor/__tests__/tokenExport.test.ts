// Regression tests for the token export, run against a trimmed slice of a
// REAL Figma variables dump (`fixtures/figma-variables.sample.json`,
// extracted verbatim from a production file — values, ids, modes and all).
//
// The slice was chosen to contain exactly the cases the previous
// dump-then-normalize-downstream pipeline got wrong, so each test below
// pins a specific, observed data-loss bug:
//
//   - `base/color/text/meta/default` — deleted-but-referenced, aliasing a
//     variable that is not in the payload. Silently vanished downstream.
//   - `components/progress-bars/base/size/height` — hidden, aliasing a
//     remote library variable absent from the payload. Also vanished.
//   - `base/apple/color/systemBlue` — aliases into the excluded
//     `figma-only` collection, which must fall back to a literal *and say
//     so*.
//   - `components/banners/type/informative/color/surface` — a single-mode
//     leaf token aliasing into a light/dark collection, whose flattened
//     value is misleading on its own.
//   - `primitives` — modes declared `[Value, iOS, Android]`, which the
//     downstream artifact alphabetized into `[Android, Value, iOS]`,
//     destroying the default-mode signal.
//   - `layout` — a genuinely empty collection.
//   - remote collections — noise, and name-colliding.
import { describe, expect, it } from "vitest";
import rawDump from "./fixtures/figma-variables.sample.json" with { type: "json" };
import { extractTokens, serializeTokenDocument } from "../tokenExport.js";
import { VariableBudgetExceededError } from "../budget.js";
import type { FigmaVariable, FigmaVariableCollection, TokenExportFigmaAPI } from "../types.js";

const collections = rawDump.variableCollections as unknown as Record<
  string,
  FigmaVariableCollection
>;
const variables = rawDump.variables as unknown as Record<string, FigmaVariable>;

function mockFigma(): TokenExportFigmaAPI {
  return {
    variables: {
      getVariableByIdAsync: async (id) => variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id) => collections[id] ?? null,
      getLocalVariableCollectionsAsync: async () => Object.values(collections),
    },
  };
}

async function exportTokens(
  overrides: Parameters<typeof extractTokens>[1] | undefined = undefined,
) {
  return extractTokens(mockFigma(), overrides ?? { fileKey: "gPHx1sqQHIfMs8706VDGM1" });
}

function findToken(
  doc: Awaited<ReturnType<typeof exportTokens>>["document"],
  collection: string,
  path: string,
) {
  return doc.collections.find((c) => c.name === collection)?.tokens.find((t) => t.path === path);
}

describe("token export: policy", () => {
  it("keeps local collections and drops remote ones by default", async () => {
    const { document, skippedCollections } = await exportTokens();
    const names = document.collections.map((c) => c.name);

    expect(names).toContain("base");
    expect(names).toContain("components");
    expect(names).toContain("primitives");
    expect(names).not.toContain("figma-only");

    // The fixture deliberately contains remote collections named `Mode`,
    // `Primitives` and `base` — the last one colliding with a local
    // collection of the same name, which is precisely why name-keyed
    // consumers of the old dump were unsafe.
    expect(document.collections.filter((c) => c.remote)).toEqual([]);
    expect(skippedCollections.some((c) => c.name === "figma-only")).toBe(true);
  });

  it("echoes the applied policy into the document so the export is self-describing", async () => {
    const { document } = await exportTokens();
    expect(document.policy.excludedCollections).toContain("figma-only");
    expect(document.policy.excludeRemoteCollections).toBe(true);
    expect(document.policy.unmatchedPatterns).toEqual([]);
  });

  it("reports a pattern that matched nothing instead of silently ignoring it", async () => {
    const { document } = await exportTokens({
      fileKey: "f",
      policy: { version: 1, exclude: ["figma-only", "typo-that-matches-nothing"] },
    });
    expect(document.policy.unmatchedPatterns).toEqual(["typo-that-matches-nothing"]);
  });

  it("supports branch exclusion, qualified and unqualified", async () => {
    const qualified = await exportTokens({
      fileKey: "f",
      policy: { version: 1, exclude: ["figma-only"], "exclude-branches": ["base/apple"] },
    });
    expect(findToken(qualified.document, "base", "apple/color/systemBlue")).toBeUndefined();
    expect(
      qualified.document.unresolved.some(
        (u) => u.path === "apple/color/systemBlue" && u.reason === "excluded-by-policy",
      ),
    ).toBe(true);

    const bare = await exportTokens({
      fileKey: "f",
      policy: { version: 1, exclude: ["figma-only"], "exclude-branches": ["palette"] },
    });
    expect(bare.document.collections.find((c) => c.name === "primitives")?.branches).not.toContain(
      "palette",
    );
  });
});

describe("token export: no silent drops", () => {
  it("accounts for every in-policy variable, either as a token or an unresolved entry", async () => {
    const { document } = await exportTokens();

    const emitted = new Set(
      document.collections.flatMap((c) => c.tokens.map((t) => `${c.name}/${t.path}`)),
    );
    const explained = new Set(document.unresolved.map((u) => `${u.collection}/${u.path}`));

    const keptCollectionIds = new Set(document.collections.map((c) => c.id));
    for (const [id, collection] of Object.entries(collections)) {
      if (!keptCollectionIds.has(id)) continue;
      for (const variableId of collection.variableIds ?? []) {
        const variable = variables[variableId];
        if (!variable) continue;
        const key = `${collection.name}/${variable.name}`;
        expect(
          emitted.has(key) || explained.has(key),
          `${key} was silently dropped: it is neither emitted nor explained`,
        ).toBe(true);
      }
    }
  });

  it("emits the deleted-but-referenced token with a dangling alias, flagged and explained", async () => {
    // This exact token silently disappeared from the downstream artifact
    // (base went 334 -> 333 variables with no warning).
    const { document } = await exportTokens();
    const token = findToken(document, "base", "color/text/meta/default");

    expect(token).toBeDefined();
    expect(token?.deleted).toBe(true);
    expect(token?.value).toBeNull();
    expect(token?.modes).toEqual({ light: null, dark: null });

    const entries = document.unresolved.filter((u) => u.path === "color/text/meta/default");
    expect(entries.length).toBeGreaterThan(0);
    expect(entries[0]?.reason).toBe("missing-alias-target");
    expect(entries[0]?.detail).toContain("VariableID:42319:2");
  });

  it("emits the hidden token whose alias target is an absent remote variable", async () => {
    // The other pair of downstream casualties (components 1323 -> 1321).
    const { document } = await exportTokens();
    const token = findToken(document, "components", "progress-bars/base/size/height");

    expect(token).toBeDefined();
    expect(token?.hidden).toBe(true);
    expect(
      document.unresolved.some(
        (u) => u.path === "progress-bars/base/size/height" && u.reason === "missing-alias-target",
      ),
    ).toBe(true);
  });
});

describe("token export: alias edges", () => {
  it("preserves the alias edge per mode, not just the flattened literal", async () => {
    const { document } = await exportTokens();
    const token = findToken(document, "base", "color/surface/action/primary/default");

    expect(token?.modes).toEqual({ light: "#2E2D3E", dark: "#ACA8E3" });
    expect(token?.alias?.byMode).toEqual({
      light: { collection: "primitives", path: "palette/halo/500" },
      dark: { collection: "primitives", path: "palette/lavender/500" },
    });
  });

  it("keeps the cross-collection edge for a single-mode leaf token whose value is mode-collapsed", async () => {
    // The leaf `components` collection has one mode ("value") but aliases
    // into `base`, which has light/dark. The resolved literal is therefore
    // only ever one of the two, and is misleading without the edge — which
    // is exactly why the downstream pipeline needed a whole graph/builders
    // layer to reconstruct what the flattening destroyed.
    const { document } = await exportTokens();
    const token = findToken(document, "components", "banners/type/informative/color/surface");

    expect(Object.keys(token?.modes ?? {})).toEqual(["value"]);
    expect(token?.alias?.byMode.value).toEqual({
      collection: "base",
      path: "color/surface/status/neutral/minimal",
    });
  });

  it("summarises observed cross-collection edges as dependsOn, excluding collections that were never emitted", async () => {
    // base aliases into BOTH primitives and the excluded figma-only
    // collection. Only the former may appear here: a dependency on a
    // collection that was not emitted is a dangling reference.
    const { document } = await exportTokens();
    expect(document.collections.find((c) => c.name === "base")?.dependsOn).toEqual(["primitives"]);
    expect(document.collections.find((c) => c.name === "components")?.dependsOn).toEqual(["base"]);
    expect(document.collections.find((c) => c.name === "primitives")?.dependsOn).toEqual([]);
  });

  it("falls back to a literal for an alias into an excluded collection, and says so", async () => {
    // `base/apple/color/*` aliases into the excluded `figma-only`
    // collection. Falling back to the literal is the documented, intended
    // behaviour (it mirrors the platform's collections.toml); doing it
    // *silently* is what this test prevents.
    const { document } = await exportTokens();
    const token = findToken(document, "base", "apple/color/systemBlue");

    expect(token?.modes).toEqual({ light: "#007AFF", dark: "#0A84FF" });
    expect(token?.alias?.byMode.light?.excluded).toBe(true);
    expect(token?.alias?.byMode.light?.collection).toBe("figma-only");
    expect(
      document.unresolved.some(
        (u) => u.path === "apple/color/systemBlue" && u.reason === "excluded-collection-alias",
      ),
    ).toBe(true);
  });
});

describe("token export: modes", () => {
  it("preserves Figma's declared mode order and the default mode", async () => {
    const { document } = await exportTokens();
    const primitives = document.collections.find((c) => c.name === "primitives");

    // The downstream artifact alphabetized this to ["Android","Value","iOS"]
    // and carried no defaultMode at all, forcing the build config to
    // hardcode which mode was primary.
    expect(primitives?.modes).toEqual(["Value", "iOS", "Android"]);
    expect(primitives?.defaultMode).toBe("Value");

    const base = document.collections.find((c) => c.name === "base");
    expect(base?.modes).toEqual(["light", "dark"]);
    expect(base?.defaultMode).toBe("light");
  });

  it("reads `value` from the default mode, not the first-listed one", async () => {
    const { document } = await exportTokens();
    const token = findToken(document, "base", "color/surface/action/primary/default");
    expect(token?.value).toBe(token?.modes.light);
  });

  it("resolves a cross-collection alias by matching mode NAME, falling back to the target's default mode", async () => {
    // typography's modes are ios/android; the primitive it aliases has
    // Value/iOS/Android. "ios" matches "iOS" only if names are compared
    // case-sensitively — they are not equal, so this must fall back to the
    // target's default mode rather than producing undefined.
    const { document } = await exportTokens();
    const token = findToken(document, "typography", "large-title/size");
    expect(token?.modes).toEqual({ ios: 34, android: 34 });
  });

  it("keeps an empty collection as empty rather than omitting it", async () => {
    const { document } = await exportTokens();
    const layout = document.collections.find((c) => c.name === "layout");
    expect(layout).toBeDefined();
    expect(layout?.tokens).toEqual([]);
  });
});

describe("token export: carried Figma facts", () => {
  it("carries scopes, description and codeSyntax hints", async () => {
    const { document } = await exportTokens();
    const token = findToken(document, "base", "color/surface/action/primary/default");

    expect(token?.scopes).toEqual(["FRAME_FILL", "SHAPE_FILL"]);
    expect(token?.description).toBeTruthy();

    const banner = findToken(document, "components", "banners/type/informative/color/surface");
    expect(banner?.hints?.codeSyntax?.ANDROID).toBe("bannersTypeInformativeColorSurface");
  });

  it("derives symbols from the wiring rules, and never from a codeSyntax hint", async () => {
    const { document } = await exportTokens();

    const baseColor = findToken(document, "base", "color/surface/action/primary/default");
    expect(baseColor?.symbol).toBe("AppTheme.semanticColors.surface.action.primary.default");
    expect(baseColor?.symbolFrom).toBe("base-color");

    // This token HAS a codeSyntax.ANDROID value. It must still have no
    // symbol: hints are not a resolution source.
    const banner = findToken(document, "components", "banners/type/informative/color/surface");
    expect(banner?.hints?.codeSyntax?.ANDROID).toBeTruthy();
    expect(banner?.symbol).toBeUndefined();
  });

  it("records the collection id once per collection, not per token", async () => {
    const { document } = await exportTokens();
    const base = document.collections.find((c) => c.name === "base");
    expect(base?.id).toMatch(/^VariableCollectionId:/);
    for (const token of base?.tokens ?? []) {
      expect(Object.keys(token)).not.toContain("collection");
    }
  });
});

describe("token export: determinism and budget", () => {
  it("produces byte-identical output when the content is unchanged", async () => {
    const first = await exportTokens();
    const second = await exportTokens();

    expect(serializeTokenDocument(first.document)).toBe(serializeTokenDocument(second.document));
    expect(first.document.envelope.version).toBe(second.document.envelope.version);
  });

  it("derives a content-hash version that changes when content changes", async () => {
    const { document } = await exportTokens();
    const other = await exportTokens({
      fileKey: "gPHx1sqQHIfMs8706VDGM1",
      policy: { version: 1, exclude: ["figma-only", "typography"] },
    });
    expect(document.envelope.version).toMatch(/^c1-[0-9a-f]{16}$/);
    expect(other.document.envelope.version).not.toBe(document.envelope.version);
  });

  it("carries no timestamp, so re-exports stay diffable", async () => {
    const { document } = await exportTokens();
    expect(Object.keys(document.envelope).sort()).toEqual([
      "fileKey",
      "kind",
      "schemaVersion",
      "version",
    ]);
  });

  it("fails loudly rather than truncating when the variable budget is exceeded", async () => {
    await expect(exportTokens({ fileKey: "f", variableBudget: 3 })).rejects.toBeInstanceOf(
      VariableBudgetExceededError,
    );
  });
});
