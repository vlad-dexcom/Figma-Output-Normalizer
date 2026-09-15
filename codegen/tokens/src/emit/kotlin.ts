// Kotlin emitter (migration plan, stage 6.2). Ported from the old
// generator's `codegen/kotlin.py`, narrowed per the plan's stage-6 v1 scope:
// one self-contained Kotlin package per build (no `branch_pkg_map` /
// `cross_branch_deps` / `palette_sub_package` / multi-module split config --
// those existed only to serve a specific multi-module Android layout, and
// nothing in this repository's data makes that split decision for us).
//
// The value-emission strategy is a deliberate departure from the old
// generator, not a straight port: schema/tokens/v1's own docs say "the
// alias EDGE is the fact; a resolved literal is only a view of it" -- so a
// token with a live (non-excluded, resolved) alias edge is emitted as a
// Kotlin property REFERENCE into its dependency parameter
// (`base.color.surface.status.neutral.minimal`), not a duplicated literal.
// This sidesteps the stage-4 mode-collapse bug entirely for codegen
// purposes: whichever dependency instance the caller passes in (e.g.
// `baseLight(...)` vs `baseDark(...)`) is what a reference resolves
// against, so there is nothing to "expand" here. A literal is only emitted
// when there is no alias, or the alias's target was excluded by policy.
import type { Token, TokenCollection } from "@figma-normalizator/schema";
import {
  kdocBlock,
  kotlinGeneratedHeader,
  kotlinPropertyPath,
  kotlinType,
  safeKotlinProperty,
  sanitizePath,
  toCamelCase,
  toPascalCase,
  formatKotlinLiteral,
} from "./naming.js";
import { branchChildren, buildPropertyTree, leafChildren, type PropertyTreeNode } from "./tree.js";
import { resolveDependsOn } from "../model/graph.js";
import type { TokenModel } from "../model/types.js";

export interface KotlinEmitOptions {
  /** The Kotlin package every generated file declares and lives under (e.g. "com.dexcom.tokens"). */
  packageName: string;
  /**
   * Modes matching this pattern are not given their own factory function
   * (e.g. `/ios/i` for a Kotlin/Android-only build) -- a caller-supplied
   * option, mirroring `ThemeModeOptions.excludeModePattern`, never a rule
   * this module bakes in. If filtering would remove every one of a
   * collection's modes, all of them are kept instead (an all-excluded
   * collection is a config mistake this module won't silently swallow).
   */
  excludeModePattern?: RegExp;
  /**
   * Prepended to every generated root class name (e.g. "DT" -> "DTBase",
   * "DTPrimitives"), mirroring the old generator's `--prefix`. Applied
   * uniformly, so a dependency's class name as seen from a constructor
   * parameter type gets the same prefix as its own generated file.
   */
  classPrefix?: string;
}

export interface KotlinFile {
  /** Relative to the emitter's output root (package-path segments included). */
  relativePath: string;
  contents: string;
}

/** Thrown when an alias edge names a dependency this collection doesn't declare in `dependsOn`. */
export class MissingDependencyParamError extends Error {
  constructor(collectionName: string, tokenPath: string, targetCollectionName: string) {
    super(
      `token "${tokenPath}" in collection "${collectionName}" aliases into collection ` +
        `"${targetCollectionName}", but "${targetCollectionName}" is not one of "${collectionName}"'s ` +
        `dependsOn entries -- the schema's alias-edge/dependsOn facts disagree, which should not happen.`,
    );
    this.name = "MissingDependencyParamError";
  }
}

/**
 * Thrown when a token's `modes` map is missing the requested mode key
 * entirely. The schema guarantees every token carries a value (possibly
 * `null`) for every mode its collection declares, so this should never
 * happen against real data -- it's a defensive guard, not the case for a
 * token that's genuinely unresolved in a given mode (that's a legitimate
 * `null`, handled by making the property nullable; see `isNullableLeaf`).
 */
export class UnrepresentableTokenValueError extends Error {
  constructor(tokenPath: string, mode: string) {
    super(
      `token "${tokenPath}" has no entry at all for mode "${mode}" -- every token must carry a ` +
        `(possibly null) value for every mode its collection declares; this indicates a schema ` +
        `invariant violation, not an expected data gap.`,
    );
    this.name = "UnrepresentableTokenValueError";
  }
}

/** Thrown when two collections would generate the same top-level Kotlin class name in one package. */
export class DuplicateClassNameError extends Error {
  constructor(className: string, collectionNames: readonly string[]) {
    super(
      `collections ${collectionNames.map((n) => `"${n}"`).join(", ")} would all generate the Kotlin ` +
        `class "${className}" in the same package -- pick distinct names, or split them into ` +
        `separate packages (not supported by this emitter yet).`,
    );
    this.name = "DuplicateClassNameError";
  }
}

function docFor(token: Token): string | undefined {
  const parts: string[] = [];
  if (token.description) parts.push(token.description);
  if (token.symbol) {
    parts.push(
      token.symbolFrom
        ? `(symbol: \`${token.symbol}\`, via wiring rule \`${token.symbolFrom}\`)`
        : `(symbol: \`${token.symbol}\`)`,
    );
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function valueExpressionFor(
  collection: TokenCollection,
  token: Token,
  mode: string,
  depParamByName: ReadonlyMap<string, string>,
): string {
  const aliasTarget = token.alias?.byMode[mode];
  if (aliasTarget && !aliasTarget.excluded && aliasTarget.collection && aliasTarget.path) {
    const depParam = depParamByName.get(aliasTarget.collection);
    if (!depParam) {
      throw new MissingDependencyParamError(collection.name, token.path, aliasTarget.collection);
    }
    return `${depParam}.${kotlinPropertyPath(aliasTarget.path)}`;
  }
  if (!(mode in token.modes)) {
    throw new UnrepresentableTokenValueError(token.path, mode);
  }
  const literal = token.modes[mode];
  // A token can be genuinely unresolvable in a given mode (schema:
  // "null means unresolvable in the default mode"), e.g. an unsupported
  // Figma expression shape -- that's real, valid input, not an error; the
  // property's Kotlin type is made nullable for exactly this reason (see
  // `isNullableLeaf`), so a bare `null` literal is the correct value here.
  if (literal === null) return "null";
  if (literal === undefined) throw new UnrepresentableTokenValueError(token.path, mode);
  return formatKotlinLiteral(token.type, literal);
}

/**
 * True if `token` has no usable value (no alias, and a `null` literal) for
 * at least one of `modes` -- i.e. its Kotlin property must be nullable to
 * be representable across every mode this build emits a factory for.
 */
function isNullableLeaf(token: Token, modes: readonly string[]): boolean {
  return modes.some((mode) => {
    const aliasTarget = token.alias?.byMode[mode];
    const hasAlias =
      aliasTarget && !aliasTarget.excluded && aliasTarget.collection && aliasTarget.path;
    return !hasAlias && token.modes[mode] === null;
  });
}

function emitDataClass(
  node: PropertyTreeNode,
  className: string,
  indent: number,
  lines: string[],
  modes: readonly string[],
): void {
  const pad = "    ".repeat(indent);
  const leaves = leafChildren(node);
  const branches = branchChildren(node);

  lines.push(
    ...kdocBlock(
      leaves.map((l) => [safeKotlinProperty(l.name), docFor(l.token as Token)] as const),
      pad,
    ),
  );
  lines.push(`${pad}@androidx.compose.runtime.Immutable`);
  lines.push(`${pad}data class ${className}(`);
  for (const leaf of leaves) {
    const token = leaf.token as Token;
    const type = kotlinType(token.type, isNullableLeaf(token, modes));
    lines.push(`${pad}    val ${safeKotlinProperty(leaf.name)}: ${type},`);
  }
  for (const branch of branches) {
    lines.push(`${pad}    val ${safeKotlinProperty(branch.name)}: ${toPascalCase(branch.name)},`);
  }
  if (branches.length > 0) {
    lines.push(`${pad}) {`);
    for (const branch of branches) {
      emitDataClass(branch, toPascalCase(branch.name), indent + 1, lines, modes);
    }
    lines.push(`${pad}}`);
  } else {
    lines.push(`${pad})`);
  }
}

function emitConstructorExpr(
  collection: TokenCollection,
  node: PropertyTreeNode,
  classPath: string,
  indent: number,
  mode: string,
  depParamByName: ReadonlyMap<string, string>,
): string {
  const pad = "    ".repeat(indent);
  const childPad = "    ".repeat(indent + 1);
  const leaves = leafChildren(node);
  const branches = branchChildren(node);

  const lines = [`${classPath}(`];
  for (const leaf of leaves) {
    const value = valueExpressionFor(collection, leaf.token as Token, mode, depParamByName);
    lines.push(`${childPad}${safeKotlinProperty(leaf.name)} = ${value},`);
  }
  for (const branch of branches) {
    const childPath = `${classPath}.${toPascalCase(branch.name)}`;
    const inner = emitConstructorExpr(
      collection,
      branch,
      childPath,
      indent + 1,
      mode,
      depParamByName,
    );
    lines.push(`${childPad}${safeKotlinProperty(branch.name)} = ${inner},`);
  }
  lines.push(`${pad})`);
  return lines.join("\n");
}

/**
 * Generates one Kotlin file for `collection`: its nested data-class tree,
 * plus one factory function per own declared mode (after
 * `options.excludeModePattern` filtering). Returns `undefined` for an empty
 * collection (no tokens = no output, matching the old generator).
 */
export function generateCollectionKotlinFile(
  model: TokenModel,
  collection: TokenCollection,
  options: KotlinEmitOptions,
): KotlinFile | undefined {
  if (collection.tokens.length === 0) return undefined;

  const classNameFor = (name: string) => `${options.classPrefix ?? ""}${toPascalCase(name)}`;
  const rootClassName = classNameFor(collection.name);
  const tree = buildPropertyTree(collection.tokens, sanitizePath);

  const dependencies = resolveDependsOn(model, collection);
  const depParamByName = new Map(dependencies.map((d) => [d.name, toCamelCase(d.name)]));

  const filteredModes = options.excludeModePattern
    ? collection.modes.filter((m) => !options.excludeModePattern?.test(m))
    : collection.modes;
  const modesToEmit = filteredModes.length > 0 ? filteredModes : collection.modes;

  const lines: string[] = [kotlinGeneratedHeader(), `package ${options.packageName}`, ""];
  emitDataClass(tree, rootClassName, 0, lines, modesToEmit);
  lines.push("");

  const params = dependencies
    .map((d) => `${depParamByName.get(d.name)}: ${classNameFor(d.name)}`)
    .join(", ");
  for (const mode of modesToEmit) {
    const fnName = `${toCamelCase(collection.name)}${toPascalCase(mode)}`;
    const expr = emitConstructorExpr(collection, tree, rootClassName, 1, mode, depParamByName);
    lines.push(`fun ${fnName}(${params}): ${rootClassName} =`);
    lines.push(`    ${expr}`);
    lines.push("");
  }

  return {
    relativePath: `${options.packageName.split(".").join("/")}/${rootClassName}.kt`,
    contents: `${lines
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trimEnd()}\n`,
  };
}

/**
 * Generates one Kotlin file per non-empty collection in `model`, in the
 * model's own declared order.
 */
export function generateKotlinFiles(model: TokenModel, options: KotlinEmitOptions): KotlinFile[] {
  const files: KotlinFile[] = [];
  const collectionsByClassName = new Map<string, string[]>();

  for (const collection of model.collections) {
    const file = generateCollectionKotlinFile(model, collection, options);
    if (!file) continue;
    files.push(file);
    const className = toPascalCase(collection.name);
    const bucket = collectionsByClassName.get(className);
    if (bucket) bucket.push(collection.name);
    else collectionsByClassName.set(className, [collection.name]);
  }

  for (const [className, names] of collectionsByClassName) {
    if (names.length > 1) {
      throw new DuplicateClassNameError(className, names);
    }
  }

  return files;
}
