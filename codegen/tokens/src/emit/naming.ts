// Naming and value-formatting utilities for Kotlin (and, later, other
// language) emitters (migration plan, stage 6.1). Ported from the old
// generator's `codegen/base.py` — the transformation rules themselves are
// unchanged; only the input types are new (schema Token literals, not
// Python's ResolvedToken/FigmaColorValue).
export const KOTLIN_KEYWORDS: ReadonlySet<string> = new Set([
  "as",
  "break",
  "class",
  "continue",
  "do",
  "else",
  "false",
  "for",
  "fun",
  "if",
  "in",
  "interface",
  "is",
  "null",
  "object",
  "package",
  "return",
  "super",
  "this",
  "throw",
  "true",
  "try",
  "typealias",
  "typeof",
  "val",
  "var",
  "when",
  "while",
]);

/** Strips a raw Figma path/name segment down to printable ASCII, dropping anything empty. */
function stripToAscii(s: string): string {
  // eslint-disable-next-line no-control-regex -- deliberately matching the full ASCII range, control chars included.
  return s.replace(/[^\x00-\x7f]/g, "").trim();
}

/** `path.split("/")`, each segment stripped to ASCII and trimmed, empties dropped. */
export function sanitizePath(path: string): string[] {
  return path
    .split("/")
    .map(stripToAscii)
    .filter((s) => s.length > 0);
}

function cleanWordChars(name: string): string {
  return name.replace(/[^A-Za-z0-9 _-]/g, "").trim();
}

/**
 * Joins capitalized word parts, inserting `_` between two purely numeric
 * parts so e.g. `["12", "5"]` (from "12-5") doesn't collapse into the same
 * identifier as a single numeric part `["125"]` (from "125").
 */
function joinPartsDisambiguated(
  rawParts: readonly string[],
  titledParts: readonly string[],
): string {
  let result = "";
  let prevNumeric = false;
  for (let i = 0; i < rawParts.length; i++) {
    const raw = rawParts[i] as string;
    const titled = titledParts[i] as string;
    const numeric = /^[0-9]+$/.test(raw);
    if (result.length > 0 && prevNumeric && numeric) result += "_";
    result += titled;
    prevNumeric = numeric;
  }
  return result;
}

/** camelCase identifier from an arbitrary Figma name/path segment. */
export function toCamelCase(name: string): string {
  const clean = cleanWordChars(name);
  if (!clean) return "_empty";
  const parts = clean.split(/[\s_-]+/).filter((p) => p.length > 0);
  const titled = parts.map((part, i) =>
    i === 0
      ? (part[0] as string).toLowerCase() + part.slice(1)
      : (part[0] as string).toUpperCase() + part.slice(1),
  );
  const result = joinPartsDisambiguated(parts, titled);
  return /^[0-9]/.test(result) ? `_${result}` : result;
}

/** PascalCase identifier from an arbitrary Figma name/path segment. */
export function toPascalCase(name: string): string {
  const clean = cleanWordChars(name);
  if (!clean) return "Empty";
  const parts = clean.split(/[\s_-]+/).filter((p) => p.length > 0);
  const titled = parts.map((part) => (part[0] as string).toUpperCase() + part.slice(1));
  const result = joinPartsDisambiguated(parts, titled);
  return /^[0-9]/.test(result) ? `N${result}` : result;
}

/** Lowercase, dash/underscore-free folder name (e.g. for a collection's package sub-folder). */
export function toFolderName(name: string): string {
  const clean = name.replace(/[^A-Za-z0-9 _-]/g, "").trim();
  return clean
    .split(/[\s_-]+/)
    .filter((p) => p.length > 0)
    .map((p) => p.toLowerCase())
    .join("");
}

/** A Kotlin property name for `name`, backtick-escaped if it collides with a keyword. */
export function safeKotlinProperty(name: string): string {
  const camel = toCamelCase(name);
  return KOTLIN_KEYWORDS.has(camel) ? `\`${camel}\`` : camel;
}

/** A `.`-joined Kotlin property access chain for an alias's raw Figma path (e.g. "color/a/b" -> "color.a.b"). */
export function kotlinPropertyPath(path: string): string {
  return sanitizePath(path).map(safeKotlinProperty).join(".");
}

// --- Value formatting ---

function roundFloat(v: number): string {
  if (v === 0) return "0.0";
  if (v === 1) return "1.0";
  // Match the old generator's `f"{v:.8g}"` rounding (8 significant digits),
  // then guarantee a decimal point so Kotlin parses it as a Float literal.
  const rounded = Number(v.toPrecision(8));
  let s = String(rounded);
  if (!s.includes(".") && !s.includes("e")) s += ".0";
  return s;
}

/** Parses a `#RRGGBB`/`#RRGGBBAA` hex color into 0..1 float channels. */
export function parseHexColor(hex: string): { r: number; g: number; b: number; a: number } {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(hex);
  if (!match) {
    throw new Error(`not a "#RRGGBB"/"#RRGGBBAA" hex color: "${hex}"`);
  }
  const [, rgb, aa] = match;
  const r = parseInt((rgb as string).slice(0, 2), 16) / 255;
  const g = parseInt((rgb as string).slice(2, 4), 16) / 255;
  const b = parseInt((rgb as string).slice(4, 6), 16) / 255;
  const a = aa ? parseInt(aa, 16) / 255 : 1;
  return { r, g, b, a };
}

/** A Compose `androidx.compose.ui.graphics.Color(...)` constructor call for a resolved hex color literal. */
export function formatColorKotlin(hex: string): string {
  const { r, g, b, a } = parseHexColor(hex);
  return `androidx.compose.ui.graphics.Color(${roundFloat(r)}f, ${roundFloat(g)}f, ${roundFloat(b)}f, ${roundFloat(a)}f)`;
}

/** A Kotlin `Float` literal for a resolved numeric value. */
export function formatFloatKotlin(value: number): string {
  return `${roundFloat(value)}f`;
}

/** Escapes a string for embedding in a Kotlin string literal (between the quotes). */
export function escapeKotlinString(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n");
}

/** A Kotlin literal expression for a resolved token value of the given `type`. */
export function formatKotlinLiteral(
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN",
  value: string | number | boolean,
): string {
  switch (type) {
    case "COLOR":
      return formatColorKotlin(value as string);
    case "FLOAT":
      return formatFloatKotlin(Number(value));
    case "STRING":
      return `"${escapeKotlinString(String(value))}"`;
    case "BOOLEAN":
      return String(value).toLowerCase();
  }
}

/**
 * The Kotlin/Compose type for a token's declared `type`. `nullable` marks a
 * leaf whose value is genuinely `null` (with no alias) in at least one of
 * the modes being emitted -- a real, schema-documented case (see
 * `docFor`/`UnrepresentableTokenValueError` in `kotlin.ts`), not an error.
 */
export function kotlinType(
  type: "COLOR" | "FLOAT" | "STRING" | "BOOLEAN",
  nullable = false,
): string {
  const suffix = nullable ? "?" : "";
  switch (type) {
    case "COLOR":
      return `androidx.compose.ui.graphics.Color${suffix}`;
    case "FLOAT":
      return `Float${suffix}`;
    case "STRING":
      return `String${suffix}`;
    case "BOOLEAN":
      return `Boolean${suffix}`;
  }
}

// --- Documentation comments ---

/** Collapses a Figma description into a single-line, KDoc-comment-safe string. */
export function normalizeDoc(description: string | undefined): string {
  if (!description) return "";
  const text = description.split(/\s+/).filter(Boolean).join(" ");
  return text.replace(/\*\//g, "*\\/");
}

/**
 * Builds a KDoc block documenting constructor properties. `entries` are
 * (propertyName, description) pairs; entries without a description are
 * skipped, and an empty block yields no lines.
 */
export function kdocBlock(
  entries: readonly (readonly [string, string | undefined])[],
  pad = "",
): string[] {
  const documented = entries
    .map(([name, desc]) => [name, normalizeDoc(desc)] as const)
    .filter(([, desc]) => desc.length > 0);
  if (documented.length === 0) return [];
  const lines = [`${pad}/**`];
  for (const [name, desc] of documented) {
    lines.push(`${pad} * @property ${name} ${desc}`);
  }
  lines.push(`${pad} */`);
  return lines;
}

/** The "generated file, do not edit" banner for a Kotlin file. */
export const KOTLIN_GENERATED_NOTICE = [
  "This file is generated by @figma-normalizator/codegen-tokens.",
  "DO NOT MODIFY -- any manual changes will be overwritten the next time",
  "tokens are regenerated from Figma.",
].map((line) => ` * ${line}`);

export function kotlinGeneratedHeader(): string {
  return `/*\n${KOTLIN_GENERATED_NOTICE.join("\n")}\n */\n`;
}
