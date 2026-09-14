import { describe, expect, it } from "vitest";
import {
  colorToHex,
  resolveFillColor,
  resolveTokenValue,
  resolveTypographyToken,
} from "../tokens.js";
import type { FigmaAPI } from "../types.js";

function mockFigmaAPI(
  variables: Record<
    string,
    { name: string; variableCollectionId: string; valuesByMode: Record<string, unknown> }
  >,
  collections: Record<
    string,
    { modes: { modeId: string; name: string }[]; defaultModeId: string; name?: string }
  >,
): FigmaAPI {
  return {
    variables: {
      getVariableByIdAsync: async (id) => variables[id] ?? null,
      getVariableCollectionByIdAsync: async (id) => collections[id] ?? null,
    },
  };
}

describe("colorToHex", () => {
  it("converts an opaque RGB color to #RRGGBB", () => {
    expect(colorToHex({ r: 1, g: 1, b: 1 })).toBe("#FFFFFF");
    expect(colorToHex({ r: 0, g: 0, b: 0 })).toBe("#000000");
  });

  it("appends alpha for translucent colors", () => {
    expect(colorToHex({ r: 1, g: 0, b: 0, a: 0.5 })).toBe("#FF000080");
  });
});

describe("resolveTokenValue", () => {
  it("resolves a bound variable to its token path and mode values", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "spacing/md",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:light": 16, "mode:dark": 16 },
        },
      },
      {
        "col:1": {
          modes: [
            { modeId: "mode:light", name: "light" },
            { modeId: "mode:dark", name: "dark" },
          ],
          defaultModeId: "mode:light",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { itemSpacing: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "itemSpacing",
      16,
    );

    expect(result.token).toEqual({
      token: "spacing/md",
      collection: "base",
      value: 16,
      modes: { light: 16, dark: 16 },
    });
    expect(result.unresolved).toEqual([]);
  });

  it("includes modes only when there is more than one", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/surface/canvas/primary",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:light": { r: 1, g: 1, b: 1 }, "mode:dark": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:1": {
          modes: [
            { modeId: "mode:light", name: "light" },
            { modeId: "mode:dark", name: "dark" },
          ],
          defaultModeId: "mode:light",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { fills: [{ type: "VARIABLE_ALIAS", id: "var:1" }] },
      "fills",
      "#FFFFFF",
    );
    expect(result.token).toEqual({
      token: "color/surface/canvas/primary",
      collection: "base",
      value: "#FFFFFF",
      modes: { light: "#FFFFFF", dark: "#000000" },
      symbol: "AppTheme.semanticColors.surface.canvas.primary",
      symbolFrom: "base-color",
    });
  });

  it("emits token:null plus an unbound-literal UnresolvedEntry when there is no binding", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveTokenValue(figma, "1:1", undefined, "cornerRadius", 4);
    expect(result.token).toEqual({ token: null, value: 4 });
    expect(result.unresolved).toEqual([
      { nodeId: "1:1", reason: "unbound-literal", detail: expect.stringContaining("cornerRadius") },
    ]);
  });

  it("falls back to unbound-literal when a bound variable id can't be resolved", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveTokenValue(
      figma,
      "1:1",
      { cornerRadius: { type: "VARIABLE_ALIAS", id: "missing" } },
      "cornerRadius",
      4,
    );
    expect(result.token.token).toBeNull();
    expect(result.unresolved[0]?.reason).toBe("unbound-literal");
  });

  it("resolves a single-hop VARIABLE_ALIAS to the aliased variable's literal value, keeping the semantic token's name", async () => {
    const figma = mockFigmaAPI(
      {
        "var:semantic": {
          name: "color/surface/tone/emphasis",
          variableCollectionId: "col:1",
          valuesByMode: {
            "mode:light": { type: "VARIABLE_ALIAS", id: "var:primitive" },
            "mode:dark": { type: "VARIABLE_ALIAS", id: "var:primitive" },
          },
        },
        "var:primitive": {
          name: "color/palette/blue/500",
          variableCollectionId: "col:1",
          valuesByMode: {
            "mode:light": { r: 0, g: 0, b: 1 },
            "mode:dark": { r: 0, g: 0, b: 1 },
          },
        },
      },
      {
        "col:1": {
          modes: [
            { modeId: "mode:light", name: "light" },
            { modeId: "mode:dark", name: "dark" },
          ],
          defaultModeId: "mode:light",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { fills: [{ type: "VARIABLE_ALIAS", id: "var:semantic" }] },
      "fills",
      "#000000",
    );

    expect(result.unresolved).toEqual([]);
    expect(result.token).toEqual({
      token: "color/surface/tone/emphasis",
      collection: "base",
      value: "#0000FF",
      modes: { light: "#0000FF", dark: "#0000FF" },
      symbol: "AppTheme.semanticColors.surface.tone.emphasis",
      symbolFrom: "base-color",
    });
  });

  it("resolves a two-hop VARIABLE_ALIAS chain (A -> B -> C) recursively", async () => {
    const figma = mockFigmaAPI(
      {
        "var:a": {
          name: "spacing/component/gap",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { type: "VARIABLE_ALIAS", id: "var:b" } },
        },
        "var:b": {
          name: "spacing/semantic/md",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { type: "VARIABLE_ALIAS", id: "var:c" } },
        },
        "var:c": {
          name: "spacing/primitive/16",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": 16 },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { itemSpacing: { type: "VARIABLE_ALIAS", id: "var:a" } },
      "itemSpacing",
      16,
    );

    expect(result.unresolved).toEqual([]);
    expect(result.token).toEqual({
      token: "spacing/component/gap",
      collection: "base",
      value: 16,
    });
  });

  it("emits an unresolvable-alias-chain UnresolvedEntry for a circular alias chain (A -> B -> A)", async () => {
    const figma = mockFigmaAPI(
      {
        "var:a": {
          name: "color/a",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { type: "VARIABLE_ALIAS", id: "var:b" } },
        },
        "var:b": {
          name: "color/b",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { type: "VARIABLE_ALIAS", id: "var:a" } },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { fills: [{ type: "VARIABLE_ALIAS", id: "var:a" }] },
      "fills",
      "#000000",
    );

    expect(result.token).toEqual({ token: null, value: "#000000" });
    expect(result.unresolved).toEqual([
      {
        nodeId: "1:1",
        reason: "unresolvable-alias-chain",
        detail: expect.stringContaining("fills"),
      },
    ]);
  });

  it("falls back to the aliased variable's default mode when its collection has no same-named mode (cross-collection alias)", async () => {
    const figma = mockFigmaAPI(
      {
        "var:semantic": {
          name: "color/surface/base",
          variableCollectionId: "col:semantic",
          valuesByMode: {
            "mode:light": { type: "VARIABLE_ALIAS", id: "var:primitive" },
            "mode:dark": { type: "VARIABLE_ALIAS", id: "var:primitive" },
          },
        },
        "var:primitive": {
          name: "color/palette/gray/900",
          variableCollectionId: "col:primitive",
          // This collection only has a single "value" mode, not
          // "light"/"dark" like the semantic collection above.
          valuesByMode: { "mode:value": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:semantic": {
          modes: [
            { modeId: "mode:light", name: "light" },
            { modeId: "mode:dark", name: "dark" },
          ],
          defaultModeId: "mode:light",
          name: "base",
        },
        "col:primitive": {
          modes: [{ modeId: "mode:value", name: "value" }],
          defaultModeId: "mode:value",
          name: "primitives",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { fills: [{ type: "VARIABLE_ALIAS", id: "var:semantic" }] },
      "fills",
      "#000000",
    );

    expect(result.unresolved).toEqual([]);
    expect(result.token).toEqual({
      token: "color/surface/base",
      collection: "base",
      value: "#000000",
      modes: { light: "#000000", dark: "#000000" },
      symbol: "AppTheme.semanticColors.surface.base",
      symbolFrom: "base-color",
    });
  });
});

describe("resolveTokenValue: wiring-rule symbol resolution", () => {
  // These exercise the real, bundled wiring rules
  // (mappings/wiring-rules/wiring-rules.yaml) rather than a mock of them,
  // so a rule change that breaks symbol derivation fails here.
  it("derives TokenValue.symbol from the base-color wiring rule, and records which rule produced it", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/border/accent/default",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { strokes: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "strokes",
      "#000000",
    );

    expect(result.unresolved).toEqual([]);
    expect(result.token).toEqual({
      token: "color/border/accent/default",
      collection: "base",
      value: "#000000",
      symbol: "AppTheme.semanticColors.border.accent.default",
      symbolFrom: "base-color",
    });
  });

  it("camelCases each path segment when deriving the accessor", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/data/sets/4-color/option-3/b",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { strokes: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "strokes",
      "#000000",
    );

    expect(result.token.symbol).toBe("AppTheme.semanticColors.data.sets._4Color.option3.b");
  });

  it("leaves symbol absent (and raises no unresolved entry) for a base branch with no confirmed wiring", async () => {
    // base's non-color branches (radius, opacity, scale, ...) are NOT
    // mechanically derivable from AppTheme — see the base-other-branches
    // rule's `reason`. An absent symbol here is the expected, unremarkable
    // outcome, not a hygiene problem to warn about.
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "radius/md",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": 8 },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { itemSpacing: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "itemSpacing",
      8,
    );

    expect(result.unresolved).toEqual([]);
    expect(result.token).toEqual({ token: "radius/md", collection: "base", value: 8 });
    expect(result.token.symbol).toBeUndefined();
  });

  it("does NOT give a non-base collection base's symbol, even for an identical path", async () => {
    // Regression test for the ambiguity this refactor fixed: the retired
    // token-map bundle was indexed by path alone, and `base` shared 324 of
    // 324 paths with the (since-deleted) `stelo` product collection. A
    // path-only lookup would confidently return base's AppTheme accessor
    // for a different collection's token.
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/border/accent/default",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "some-product-theme",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { strokes: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "strokes",
      "#000000",
    );

    expect(result.token.collection).toBe("some-product-theme");
    expect(result.token.symbol).toBeUndefined();
  });

  it("does NOT fall through into base's rule when the owning collection can't be read", async () => {
    // `getVariableCollectionByIdAsync` returning null means "unknown
    // collection", which must never be treated as a match.
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/border/accent/default",
          variableCollectionId: "col:missing",
          valuesByMode: { "mode:default": { r: 0, g: 0, b: 0 } },
        },
      },
      {},
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { strokes: { type: "VARIABLE_ALIAS", id: "var:1" } },
      "strokes",
      "#000000",
    );

    expect(result.token.collection).toBeNull();
    expect(result.token.symbol).toBeUndefined();
  });

  it("resolves against the outer/semantic variable's path, not an inner primitive it aliases through", async () => {
    const figma = mockFigmaAPI(
      {
        "var:semantic": {
          name: "color/border/accent/default",
          variableCollectionId: "col:1",
          valuesByMode: { "mode:default": { type: "VARIABLE_ALIAS", id: "var:primitive" } },
        },
        "var:primitive": {
          // Deliberately in a collection whose rule derives no symbol, to
          // prove resolution used the semantic variable's own identity
          // above and not this one.
          name: "palette/does-not-exist",
          variableCollectionId: "col:2",
          valuesByMode: { "mode:default": { r: 0, g: 0, b: 0 } },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "base",
        },
        "col:2": {
          modes: [{ modeId: "mode:default", name: "default" }],
          defaultModeId: "mode:default",
          name: "primitives",
        },
      },
    );

    const result = await resolveTokenValue(
      figma,
      "1:1",
      { strokes: { type: "VARIABLE_ALIAS", id: "var:semantic" } },
      "strokes",
      "#000000",
    );

    expect(result.token.symbol).toBe("AppTheme.semanticColors.border.accent.default");
    expect(result.token.collection).toBe("base");
  });
});

describe("resolveFillColor", () => {
  it("returns null with no unresolved entries when there is no visible solid paint", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(figma, "1:1", [], undefined);
    expect(result).toEqual({ token: null, unresolved: [] });
  });

  it("skips invisible paints", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(
      figma,
      "1:1",
      [{ type: "SOLID", visible: false, color: { r: 1, g: 0, b: 0 } }],
      undefined,
    );
    expect(result.token).toBeNull();
  });

  it("emits token:null plus a mixed-value UnresolvedEntry when fills is the figma.mixed sentinel", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(figma, "1:1", Symbol("figma.mixed"), undefined);
    expect(result.token).toBeNull();
    expect(result.unresolved).toEqual([
      { nodeId: "1:1", reason: "mixed-value", detail: expect.stringContaining("fills") },
    ]);
  });

  it("emits token:null plus an unsupported-paint UnresolvedEntry for a visible non-SOLID paint (G1)", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(
      figma,
      "1:1",
      [{ type: "GRADIENT_LINEAR", visible: true }],
      undefined,
    );
    expect(result.token).toBeNull();
    expect(result.unresolved).toEqual([
      {
        nodeId: "1:1",
        reason: "unsupported-paint",
        detail: expect.stringContaining("GRADIENT_LINEAR"),
      },
    ]);
  });

  it("does not emit unsupported-paint for an invisible non-SOLID paint", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(
      figma,
      "1:1",
      [{ type: "GRADIENT_LINEAR", visible: false }],
      undefined,
    );
    expect(result).toEqual({ token: null, unresolved: [] });
  });

  it("folds paint.opacity (the fill's own opacity slider) into the exported alpha channel", async () => {
    // Figma's SOLID paint stores per-channel alpha on `color.a` (normally 1),
    // but the opacity slider users actually drag in the fills panel is a
    // *separate* `paint.opacity` field. A fill set to 50% opacity has
    // `color.a: 1, opacity: 0.5` — losing `opacity` here would silently
    // export it as a fully opaque color.
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(
      figma,
      "1:1",
      [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0 }, opacity: 0.5 }],
      undefined,
    );
    expect(result.token).toEqual({ token: null, value: "#FF000080" });
  });

  it("multiplies color.a and paint.opacity when both are present", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveFillColor(
      figma,
      "1:1",
      [{ type: "SOLID", visible: true, color: { r: 1, g: 0, b: 0, a: 0.5 }, opacity: 0.5 }],
      undefined,
    );
    // 0.5 * 0.5 = 0.25 -> 64/255 rounded -> 0x40
    expect(result.token).toEqual({ token: null, value: "#FF000040" });
  });
});

describe("resolveTypographyToken", () => {
  it("emits token:null plus unbound-literal when there is no bound typography variable", async () => {
    const figma = mockFigmaAPI({}, {});
    const result = await resolveTypographyToken(figma, "1:1", undefined);
    expect(result.token).toEqual({ token: null });
    expect(result.unresolved[0]?.reason).toBe("unbound-literal");
  });

  it("resolves a bound typography variable to its token path", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "typography/body/large",
          variableCollectionId: "col:1",
          valuesByMode: { m: "x" },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "m", name: "default" }],
          defaultModeId: "m",
          name: "typography",
        },
      },
    );
    const result = await resolveTypographyToken(figma, "1:1", {
      fontName: { type: "VARIABLE_ALIAS", id: "var:1" },
    });
    expect(result.token).toEqual({ token: "typography/body/large", collection: "typography" });
    expect(result.unresolved).toEqual([]);
  });

  it("populates TokenRef.symbol/symbolFrom from the wiring rules, qualified by collection", async () => {
    const figma = mockFigmaAPI(
      {
        "var:1": {
          name: "color/border/accent/default",
          variableCollectionId: "col:1",
          valuesByMode: { m: "x" },
        },
      },
      {
        "col:1": {
          modes: [{ modeId: "m", name: "default" }],
          defaultModeId: "m",
          name: "base",
        },
      },
    );
    const result = await resolveTypographyToken(figma, "1:1", {
      fontName: { type: "VARIABLE_ALIAS", id: "var:1" },
    });
    expect(result.token).toEqual({
      token: "color/border/accent/default",
      collection: "base",
      symbol: "AppTheme.semanticColors.border.accent.default",
      symbolFrom: "base-color",
    });
    expect(result.unresolved).toEqual([]);
  });
});
