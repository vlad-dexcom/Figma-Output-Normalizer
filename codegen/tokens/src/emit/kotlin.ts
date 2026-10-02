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
import type { Token, TokenCollection } from "@figma-exporter/schema";
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
import { toFolderName } from "./naming.js";
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
  /**
   * Sub-collection name -> parent collection name (see
   * `model/parents.ts`). A sub-collection gets no class of its own: only
   * per-mode factory functions returning its parent's type, built from its
   * own values. Chains (C extends B extends A) resolve to the root's type.
   */
  parentCollections?: ReadonlyMap<string, string>;
}

/**
 * Thrown when a sub-collection's value is missing (null, no alias) where
 * its parent's generated property is non-nullable -- returning the
 * parent's type would otherwise require inventing a value.
 */
export class SubCollectionValueError extends Error {
  constructor(childName: string, parentName: string, tokenPath: string, mode: string) {
    super(
      `token "${tokenPath}" in collection "${childName}" has no value in mode "${mode}", but ` +
        `"${childName}" is generated as "${parentName}"'s type, where that property is ` +
        `non-nullable. Set the value in Figma (or allow a fallback) before regenerating.`,
    );
    this.name = "SubCollectionValueError";
  }
}

interface SubCollectionTarget {
  /** The root parent collection whose generated type this collection's factories return. */
  parent: TokenCollection;
  /** The parent's modes after `excludeModePattern` filtering -- what its nullability was computed over. */
  parentModes: readonly string[];
}

function compareCodePoints(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function modesToEmitFor(collection: TokenCollection, options: KotlinEmitOptions): string[] {
  const filtered = options.excludeModePattern
    ? collection.modes.filter((m) => !options.excludeModePattern?.test(m))
    : collection.modes;
  return [...(filtered.length > 0 ? filtered : collection.modes)].sort(compareCodePoints);
}

function subCollectionTarget(
  model: TokenModel,
  collection: TokenCollection,
  options: KotlinEmitOptions,
): SubCollectionTarget | undefined {
  const parents = options.parentCollections;
  let parentName = parents?.get(collection.name);
  if (parentName === undefined) return undefined;
  const seen = new Set([collection.name]);
  while (parents?.has(parentName) && !seen.has(parentName)) {
    seen.add(parentName);
    parentName = parents.get(parentName)!;
  }
  const parent = model.collections.find((c) => c.name === parentName);
  if (!parent) return undefined;
  return { parent, parentModes: modesToEmitFor(parent, options) };
}

/** Enforces {@link SubCollectionValueError} for every emitted mode of a sub-collection. */
function assertSubCollectionValues(
  collection: TokenCollection,
  target: SubCollectionTarget,
  modes: readonly string[],
): void {
  const parentByPath = new Map(target.parent.tokens.map((t) => [t.path, t]));
  for (const token of collection.tokens) {
    const parentToken = parentByPath.get(token.path);
    if (!parentToken || isNullableLeaf(parentToken, target.parentModes)) continue;
    for (const mode of modes) {
      if (isNullableLeaf(token, [mode])) {
        throw new SubCollectionValueError(collection.name, target.parent.name, token.path, mode);
      }
    }
  }
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

// --- Opacity scale ---
//
// Figma stores an opacity variable the way its own UI shows it -- as a
// percentage, so `opacity/40` is the number 40, not 0.4 (the real export's
// own descriptions say so: "Stored 0-100; divide by 100 for CSS/native
// opacity"). Every Android/Compose alpha channel is 0-1, so emitting that
// number verbatim (`Color.copy(alpha = primitives.opacity._40)`) is ~100x
// too opaque and Compose just clamps it to fully opaque -- the 40%
// pressed/disabled state silently disappears. Rescaling happens exactly
// once, at the leaf that holds the literal, so a `.copy(alpha = ...)`
// property REFERENCE (see `valueExpressionFor`) needs no arithmetic of its
// own and can never disagree with the property it points at.

/** Figma variable scopes that mark a FLOAT as an opacity/alpha value. */
const OPACITY_SCOPES = new Set(["OPACITY", "COLOR_OPACITY"]);

function opacityKey(collectionName: string, tokenPath: string): string {
  return `${collectionName}\u0000${tokenPath}`;
}

interface OpacityPlan {
  /** Every token carrying opacity semantics, keyed by {@link opacityKey}. */
  readonly opacityKeys: ReadonlySet<string>;
  /** Collection name -> the divisor its opacity literals need (100 when percentage-scaled, 1 when already 0-1). */
  readonly scaleByCollection: ReadonlyMap<string, number>;
}

/**
 * Works out, per collection, whether its opacity tokens are stored as
 * percentages. The decision is made per collection rather than per value
 * because a single token can't tell us: `opacity/1` = 1 is both a valid 1%
 * and a valid fully-opaque 1.0. If ANY opacity token in the collection
 * exceeds 1, the whole group is a 0-100 scale -- which is the only reading
 * consistent with the others. A collection whose opacity values all sit in
 * 0-1 is taken at face value and left alone.
 */
function buildOpacityPlan(model: TokenModel): OpacityPlan {
  const opacityKeys = new Set<string>();
  for (const collection of model.collections) {
    for (const token of collection.tokens) {
      if (token.type === "FLOAT" && (token.scopes ?? []).some((s) => OPACITY_SCOPES.has(s))) {
        opacityKeys.add(opacityKey(collection.name, token.path));
      }
      // A composed-color's opacity edge names its target directly. Trust
      // that edge too, so a target variable that happens to carry no
      // OPACITY scope still gets rescaled rather than silently feeding a
      // percentage into `alpha`.
      for (const target of Object.values(token.alias?.byMode ?? {})) {
        const opacity = target?.opacity;
        if (opacity && !opacity.excluded && opacity.collection && opacity.path) {
          opacityKeys.add(opacityKey(opacity.collection, opacity.path));
        }
      }
    }
  }

  const scaleByCollection = new Map<string, number>();
  for (const collection of model.collections) {
    let percentage = scaleByCollection.get(collection.name) === 100;
    for (const token of collection.tokens) {
      if (!opacityKeys.has(opacityKey(collection.name, token.path))) continue;
      for (const value of Object.values(token.modes)) {
        if (typeof value === "number" && value > 1) percentage = true;
      }
    }
    scaleByCollection.set(collection.name, percentage ? 100 : 1);
  }

  return { opacityKeys, scaleByCollection };
}

/** The divisor `token`'s literal needs to become a 0-1 alpha, or 1 when it needs none. */
function opacityDivisor(plan: OpacityPlan, collectionName: string, token: Token): number {
  if (token.type !== "FLOAT") return 1;
  if (!plan.opacityKeys.has(opacityKey(collectionName, token.path))) return 1;
  return plan.scaleByCollection.get(collectionName) ?? 1;
}

function docFor(token: Token, rescaledOpacity: boolean): string | undefined {
  const parts: string[] = [];
  if (token.description) parts.push(token.description);
  if (token.symbol) {
    parts.push(
      token.symbolFrom
        ? `(symbol: \`${token.symbol}\`, via wiring rule \`${token.symbolFrom}\`)`
        : `(symbol: \`${token.symbol}\`)`,
    );
  }
  if (rescaledOpacity) {
    parts.push("Opacity as a 0-1 Compose alpha (Figma stores this value as 0-100).");
  }
  return parts.length > 0 ? parts.join(" ") : undefined;
}

function refOrThrow(
  collection: TokenCollection,
  token: Token,
  targetCollection: string,
  targetPath: string,
  depParamByName: ReadonlyMap<string, string>,
): string {
  const param = depParamByName.get(targetCollection);
  if (!param) throw new MissingDependencyParamError(collection.name, token.path, targetCollection);
  return `${param}.${kotlinPropertyPath(targetPath)}`;
}

const tokensByPathCache = new WeakMap<TokenCollection, ReadonlyMap<string, Token>>();

function tokensByPath(collection: TokenCollection): ReadonlyMap<string, Token> {
  let map = tokensByPathCache.get(collection);
  if (!map) {
    map = new Map(collection.tokens.map((t) => [t.path, t]));
    tokensByPathCache.set(collection, map);
  }
  return map;
}

/**
 * A same-collection edge can't be a property reference: the factory builds
 * the whole data class in one constructor call, so a sibling property isn't
 * addressable yet. The target's own value expression is inlined instead
 * (its cross-collection reference, or its literal), following chains.
 */
function inlineSameCollectionTarget(
  collection: TokenCollection,
  targetPath: string,
  mode: string,
  depParamByName: ReadonlyMap<string, string>,
  opacityPlan: OpacityPlan,
  visiting: ReadonlySet<string>,
): string {
  const target = tokensByPath(collection).get(targetPath);
  if (!target) {
    throw new Error(
      `token alias in collection "${collection.name}" points at "${targetPath}", which is not a token in that collection.`,
    );
  }
  if (visiting.has(targetPath)) {
    throw new Error(
      `alias cycle in collection "${collection.name}" through token "${targetPath}" (mode "${mode}").`,
    );
  }
  return valueExpressionFor(collection, target, mode, depParamByName, opacityPlan, visiting);
}

function valueExpressionFor(
  collection: TokenCollection,
  token: Token,
  mode: string,
  depParamByName: ReadonlyMap<string, string>,
  opacityPlan: OpacityPlan,
  visiting: ReadonlySet<string> = new Set(),
): string {
  const aliasTarget = token.alias?.byMode[mode];
  if (aliasTarget && !aliasTarget.excluded && aliasTarget.collection && aliasTarget.path) {
    const chain = new Set(visiting).add(token.path);
    const resolve = (targetCollection: string, targetPath: string): string =>
      targetCollection === collection.name
        ? inlineSameCollectionTarget(
            collection,
            targetPath,
            mode,
            depParamByName,
            opacityPlan,
            chain,
          )
        : refOrThrow(collection, token, targetCollection, targetPath, depParamByName);
    const base = resolve(aliasTarget.collection, aliasTarget.path);

    // COMPOSE_COLOR: the color is aliased AND the opacity applied to it is
    // itself a named variable (not a bare number baked into the literal).
    // Emit a live `.copy(alpha = ...)` reference instead of a frozen hex, so
    // both source tokens stay wired up in generated code.
    const opacity = aliasTarget.opacity;
    if (opacity && !opacity.excluded && opacity.collection && opacity.path) {
      return `${base}.copy(alpha = ${resolve(opacity.collection, opacity.path)})`;
    }
    return base;
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
  const divisor = opacityDivisor(opacityPlan, collection.name, token);
  if (divisor !== 1 && typeof literal === "number") {
    return formatKotlinLiteral(token.type, literal / divisor);
  }
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
  collectionName: string,
  opacityPlan: OpacityPlan,
): void {
  const pad = "    ".repeat(indent);
  const leaves = leafChildren(node);
  const branches = branchChildren(node);

  lines.push(
    ...kdocBlock(
      leaves.map((l) => {
        const token = l.token as Token;
        return [
          safeKotlinProperty(l.name),
          docFor(token, opacityDivisor(opacityPlan, collectionName, token) !== 1),
        ] as const;
      }),
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
      emitDataClass(
        branch,
        toPascalCase(branch.name),
        indent + 1,
        lines,
        modes,
        collectionName,
        opacityPlan,
      );
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
  opacityPlan: OpacityPlan,
): string {
  const pad = "    ".repeat(indent);
  const childPad = "    ".repeat(indent + 1);
  const leaves = leafChildren(node);
  const branches = branchChildren(node);

  const lines = [`${classPath}(`];
  for (const leaf of leaves) {
    const value = valueExpressionFor(
      collection,
      leaf.token as Token,
      mode,
      depParamByName,
      opacityPlan,
    );
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
      opacityPlan,
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

  const modesToEmit = modesToEmitFor(collection, options);
  const subTarget = subCollectionTarget(model, collection, options);
  const returnClassName = subTarget ? classNameFor(subTarget.parent.name) : rootClassName;

  const lines: string[] = [kotlinGeneratedHeader(), `package ${options.packageName}`, ""];
  const opacityPlan = buildOpacityPlan(model);
  if (subTarget) {
    assertSubCollectionValues(collection, subTarget, modesToEmit);
    lines.push(
      `// "${collection.name}" extends "${subTarget.parent.name}": no class of its own, only ` +
        `${returnClassName} instances built from "${collection.name}"'s values.`,
    );
  } else {
    emitDataClass(tree, rootClassName, 0, lines, modesToEmit, collection.name, opacityPlan);
  }
  lines.push("");

  const params = dependencies
    .map((d) => `${depParamByName.get(d.name)}: ${classNameFor(d.name)}`)
    .join(", ");
  for (const mode of modesToEmit) {
    const fnName = `${toCamelCase(collection.name)}${toPascalCase(mode)}`;
    const expr = emitConstructorExpr(
      collection,
      tree,
      returnClassName,
      1,
      mode,
      depParamByName,
      opacityPlan,
    );
    lines.push(`fun ${fnName}(${params}): ${returnClassName} =`);
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

// --- Legacy (per-branch, per-factory, multi-file) layout ---
//
// A bridge, not the target design (see docs/BACKLOG.md G13): restores the
// old generator's *structural* shape -- a data-class-only file per
// top-level branch, in its own subpackage under the collection's own
// subpackage (e.g. "<pkg>.base.color.Color"), plus a separate factory-only
// file per branch per mode (e.g. "<pkg>.base.color.ColorLight" ->
// `colorLight(...)`), and likewise a data-class-only root file plus one
// factory-only file per collection mode (e.g. "<pkg>.base.BaseLight" ->
// `baseLight(...)`) -- because real downstream consumers (Android_Stelo)
// still hard-reference that package layout (e.g. `typealias
// SemanticColors = <pkg>.base.color.Color`). It deliberately does NOT port
// the old generator's per-branch dependency narrowing
// (`colorLight(palette: Palette)`) or its mode-collapsing-when-constant
// optimization: every factory here takes the same whole-collection
// dependency parameters as `generateCollectionKotlinFile` does
// (`colorLight(primitives: Primitives)`), and every branch gets a factory
// per mode unconditionally. Callers migrating off the old generator need to
// update call sites to the new (still narrower, still collection-wide)
// parameter shape; see the backlog entry for the reasoning.

/** The Kotlin package a collection's own root file/subpackage lives under. */
function collectionPackage(packageName: string, collectionName: string): string {
  return `${packageName}.${toFolderName(collectionName)}`;
}

/** The fully-qualified Kotlin class name for a collection, as referenced from another collection's package. */
function collectionClassFqn(
  packageName: string,
  collectionName: string,
  classNameFor: (name: string) => string,
): string {
  return `${collectionPackage(packageName, collectionName)}.${classNameFor(collectionName)}`;
}

/** Emits a root collection's data class: branch properties reference their own subpackage's class by FQN (no nested body). */
function emitLegacyRootDataClass(
  node: PropertyTreeNode,
  className: string,
  lines: string[],
  modes: readonly string[],
  branchTypeFqn: (branchName: string) => string,
  collectionName: string,
  opacityPlan: OpacityPlan,
): void {
  const leaves = leafChildren(node);
  const branches = branchChildren(node);

  lines.push(
    ...kdocBlock(
      leaves.map((l) => {
        const token = l.token as Token;
        return [
          safeKotlinProperty(l.name),
          docFor(token, opacityDivisor(opacityPlan, collectionName, token) !== 1),
        ] as const;
      }),
      "",
    ),
  );
  lines.push("@androidx.compose.runtime.Immutable");
  lines.push(`data class ${className}(`);
  for (const leaf of leaves) {
    const token = leaf.token as Token;
    const type = kotlinType(token.type, isNullableLeaf(token, modes));
    lines.push(`    val ${safeKotlinProperty(leaf.name)}: ${type},`);
  }
  for (const branch of branches) {
    lines.push(`    val ${safeKotlinProperty(branch.name)}: ${branchTypeFqn(branch.name)},`);
  }
  lines.push(")");
}

/** Wraps `contents` lines with the generated-file boilerplate and normalizes blank runs. */
function renderKotlinFile(packageName: string, bodyLines: readonly string[]): string {
  const lines = [kotlinGeneratedHeader(), `package ${packageName}`, "", ...bodyLines];
  return `${lines
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trimEnd()}\n`;
}

/**
 * Generates the legacy-layout files for one collection, fully matching the
 * old (retired) generator's per-file granularity: a data-class-only file
 * per top-level branch (`Color.kt`), one factory-only file per branch per
 * mode (`ColorLight.kt` -> `colorLight(...)`, `ColorDark.kt` ->
 * `colorDark(...)`), a data-class-only root aggregator file (`Base.kt`),
 * and one factory-only file per collection mode (`BaseLight.kt` ->
 * `baseLight(...)`). A root-mode factory calls its branches' mode factories
 * by fully-qualified name (matching the old generator's call-site FQN
 * approach) rather than importing them, so no additional `import`
 * statements are needed. Returns an empty array for an empty collection.
 */
export function generateCollectionLegacyKotlinFiles(
  model: TokenModel,
  collection: TokenCollection,
  options: KotlinEmitOptions,
): KotlinFile[] {
  if (collection.tokens.length === 0) return [];

  const classNameFor = (name: string) => `${options.classPrefix ?? ""}${toPascalCase(name)}`;
  const rootClassName = classNameFor(collection.name);
  const pkg = collectionPackage(options.packageName, collection.name);
  const tree = buildPropertyTree(collection.tokens, sanitizePath);

  const dependencies = resolveDependsOn(model, collection);
  const depParamByName = new Map(dependencies.map((d) => [d.name, toCamelCase(d.name)]));
  const params = dependencies
    .map(
      (d) =>
        `${depParamByName.get(d.name)}: ${collectionClassFqn(options.packageName, d.name, classNameFor)}`,
    )
    .join(", ");
  const args = dependencies.map((d) => depParamByName.get(d.name)).join(", ");

  const modesToEmit = modesToEmitFor(collection, options);
  // A sub-collection's factories live in its own package but construct and
  // return its parent's classes, referenced by FQN; it emits no classes.
  const subTarget = subCollectionTarget(model, collection, options);
  if (subTarget) assertSubCollectionValues(collection, subTarget, modesToEmit);
  const typePkg = subTarget ? collectionPackage(options.packageName, subTarget.parent.name) : pkg;
  const rootTypeName = subTarget
    ? `${typePkg}.${classNameFor(subTarget.parent.name)}`
    : rootClassName;

  const leaves = leafChildren(tree);
  const branches = branchChildren(tree);
  const files: KotlinFile[] = [];
  const opacityPlan = buildOpacityPlan(model);

  // One data-class-only file per top-level branch, plus one factory-only file per branch mode.
  for (const branch of branches) {
    const branchClassName = classNameFor(branch.name);
    const branchPkg = `${pkg}.${toFolderName(branch.name)}`;
    const branchTypeName = subTarget
      ? `${typePkg}.${toFolderName(branch.name)}.${branchClassName}`
      : branchClassName;

    if (!subTarget) {
      const classLines: string[] = [];
      emitDataClass(
        branch,
        branchClassName,
        0,
        classLines,
        modesToEmit,
        collection.name,
        opacityPlan,
      );
      files.push({
        relativePath: `${branchPkg.split(".").join("/")}/${branchClassName}.kt`,
        contents: renderKotlinFile(branchPkg, classLines),
      });
    }

    for (const mode of modesToEmit) {
      const modePascal = toPascalCase(mode);
      const fnName = `${toCamelCase(branch.name)}${modePascal}`;
      const expr = emitConstructorExpr(
        collection,
        branch,
        branchTypeName,
        1,
        mode,
        depParamByName,
        opacityPlan,
      );
      const factoryLines = [`fun ${fnName}(${params}): ${branchTypeName} =`, `    ${expr}`];
      files.push({
        relativePath: `${branchPkg.split(".").join("/")}/${branchClassName}${modePascal}.kt`,
        contents: renderKotlinFile(branchPkg, factoryLines),
      });
    }
  }

  // The root data-class-only file: branch properties reference each branch's class by FQN.
  if (!subTarget) {
    const rootClassLines: string[] = [];
    emitLegacyRootDataClass(
      tree,
      rootClassName,
      rootClassLines,
      modesToEmit,
      (branchName) => `${pkg}.${toFolderName(branchName)}.${classNameFor(branchName)}`,
      collection.name,
      opacityPlan,
    );
    files.push({
      relativePath: `${pkg.split(".").join("/")}/${rootClassName}.kt`,
      contents: renderKotlinFile(pkg, rootClassLines),
    });
  }

  // One factory-only file per collection mode, calling each branch's mode
  // factory by fully-qualified name (no import needed, matching the old
  // generator's call-site FQN approach).
  for (const mode of modesToEmit) {
    const modePascal = toPascalCase(mode);
    const fnName = `${toCamelCase(collection.name)}${modePascal}`;
    const ctorArgs: string[] = [];
    for (const leaf of leaves) {
      const value = valueExpressionFor(
        collection,
        leaf.token as Token,
        mode,
        depParamByName,
        opacityPlan,
      );
      ctorArgs.push(`${safeKotlinProperty(leaf.name)} = ${value}`);
    }
    for (const branch of branches) {
      const branchPkg = `${pkg}.${toFolderName(branch.name)}`;
      const branchFnFqn = `${branchPkg}.${toCamelCase(branch.name)}${modePascal}`;
      ctorArgs.push(`${safeKotlinProperty(branch.name)} = ${branchFnFqn}(${args})`);
    }
    const factoryLines = [`fun ${fnName}(${params}): ${rootTypeName} = ${rootTypeName}(`];
    for (const arg of ctorArgs) factoryLines.push(`    ${arg},`);
    factoryLines.push(")");
    files.push({
      relativePath: `${pkg.split(".").join("/")}/${rootClassName}${modePascal}.kt`,
      contents: renderKotlinFile(pkg, factoryLines),
    });
  }

  return files;
}

/**
 * Generates the legacy-layout files for every non-empty collection in
 * `model`, in the model's own declared order. See
 * {@link generateCollectionLegacyKotlinFiles}.
 */
export function generateLegacyKotlinFiles(
  model: TokenModel,
  options: KotlinEmitOptions,
): KotlinFile[] {
  const files: KotlinFile[] = [];
  for (const collection of model.collections) {
    files.push(...generateCollectionLegacyKotlinFiles(model, collection, options));
  }
  return files;
}
