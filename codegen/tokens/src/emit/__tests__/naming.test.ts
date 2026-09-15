import { describe, expect, it } from "vitest";
import {
  escapeKotlinString,
  formatColorKotlin,
  formatFloatKotlin,
  formatKotlinLiteral,
  kdocBlock,
  kotlinGeneratedHeader,
  kotlinPropertyPath,
  kotlinType,
  normalizeDoc,
  parseHexColor,
  safeKotlinProperty,
  sanitizePath,
  toCamelCase,
  toFolderName,
  toPascalCase,
} from "../naming.js";

describe("toCamelCase / toPascalCase", () => {
  it("lowercases only the first letter for camelCase, keeps the rest as-is per part", () => {
    expect(toCamelCase("color surface")).toBe("colorSurface");
    expect(toPascalCase("color surface")).toBe("ColorSurface");
  });

  it("splits on spaces, underscores, and hyphens uniformly", () => {
    expect(toCamelCase("color_surface-status neutral")).toBe("colorSurfaceStatusNeutral");
  });

  it("prefixes a leading digit ('_' for camelCase, 'N' for PascalCase)", () => {
    expect(toCamelCase("100")).toBe("_100");
    expect(toPascalCase("100")).toBe("N100");
  });

  it("disambiguates two numeric parts from one merged number", () => {
    // "12-5" -> two numeric parts -> "12_5"; "125" -> one part -> "125".
    expect(toCamelCase("12-5")).not.toBe(toCamelCase("125"));
    expect(toCamelCase("12-5")).toBe("_12_5");
    expect(toCamelCase("125")).toBe("_125");
  });

  it("falls back to a placeholder for a name with no representable characters", () => {
    expect(toCamelCase("!!!")).toBe("_empty");
    expect(toPascalCase("!!!")).toBe("Empty");
  });

  it("matches the real fixture's 'UNDEFINED' quirk (only the very first char is case-folded)", () => {
    expect(toCamelCase("UNDEFINED")).toBe("uNDEFINED");
  });
});

describe("toFolderName", () => {
  it("lowercases and strips separators", () => {
    expect(toFolderName("Border Width")).toBe("borderwidth");
    expect(toFolderName("border-width")).toBe("borderwidth");
  });
});

describe("safeKotlinProperty / kotlinPropertyPath", () => {
  it("backtick-escapes a Kotlin keyword", () => {
    expect(safeKotlinProperty("class")).toBe("`class`");
    expect(safeKotlinProperty("surface")).toBe("surface");
  });

  it("joins a raw alias path into a dotted Kotlin property chain", () => {
    expect(kotlinPropertyPath("color/surface/is")).toBe("color.surface.`is`");
  });
});

describe("sanitizePath", () => {
  it("splits on '/' and drops non-ASCII/empty segments", () => {
    expect(sanitizePath("color/surface//primary")).toEqual(["color", "surface", "primary"]);
  });
});

describe("color/float/string/boolean formatting", () => {
  it("parses a 6-digit hex color to full-alpha float channels", () => {
    expect(parseHexColor("#FFFFFF")).toEqual({ r: 1, g: 1, b: 1, a: 1 });
    expect(parseHexColor("#000000")).toEqual({ r: 0, g: 0, b: 0, a: 1 });
  });

  it("parses an 8-digit hex color's alpha channel", () => {
    expect(parseHexColor("#FF000080").a).toBeCloseTo(128 / 255, 5);
  });

  it("rejects a non-hex-color string", () => {
    expect(() => parseHexColor("red")).toThrow(/not a/);
  });

  it("emits a Compose Color(...) constructor call", () => {
    expect(formatColorKotlin("#FFFFFF")).toBe(
      "androidx.compose.ui.graphics.Color(1.0f, 1.0f, 1.0f, 1.0f)",
    );
    expect(formatColorKotlin("#000000")).toBe(
      "androidx.compose.ui.graphics.Color(0.0f, 0.0f, 0.0f, 1.0f)",
    );
  });

  it("emits a Float literal", () => {
    expect(formatFloatKotlin(12)).toBe("12.0f");
    expect(formatFloatKotlin(0.5)).toBe("0.5f");
  });

  it("escapes backslashes, quotes, and newlines in a Kotlin string literal", () => {
    expect(escapeKotlinString('a "b"\\c\nd')).toBe('a \\"b\\"\\\\c\\nd');
  });

  it("dispatches by declared token type", () => {
    expect(formatKotlinLiteral("COLOR", "#FFFFFF")).toContain("Color(1.0f");
    expect(formatKotlinLiteral("FLOAT", 4)).toBe("4.0f");
    expect(formatKotlinLiteral("STRING", "hi")).toBe('"hi"');
    expect(formatKotlinLiteral("BOOLEAN", true)).toBe("true");
  });
});

describe("kdocBlock / normalizeDoc", () => {
  it("collapses whitespace and escapes a literal comment terminator", () => {
    expect(normalizeDoc(" a  b\n c */ d ")).toBe("a b c *\\/ d");
  });

  it("emits nothing for entries with no description", () => {
    expect(kdocBlock([["surface", undefined]])).toEqual([]);
  });

  it("emits an @property line per documented entry, skipping undocumented ones", () => {
    const lines = kdocBlock([
      ["surface", "The surface color."],
      ["text", undefined],
    ]);
    expect(lines).toEqual(["/**", " * @property surface The surface color.", " */"]);
  });
});

describe("kotlinType", () => {
  it("maps every declared token type", () => {
    expect(kotlinType("COLOR")).toBe("androidx.compose.ui.graphics.Color");
    expect(kotlinType("FLOAT")).toBe("Float");
    expect(kotlinType("STRING")).toBe("String");
    expect(kotlinType("BOOLEAN")).toBe("Boolean");
  });
});

describe("kotlinGeneratedHeader", () => {
  it("is a block comment carrying a 'do not modify' notice", () => {
    const header = kotlinGeneratedHeader();
    expect(header).toMatch(/^\/\*/);
    expect(header).toContain("DO NOT MODIFY");
  });
});
