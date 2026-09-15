export { DuplicateCollectionIdError, buildTokenModel } from "./build.js";
export { hasNameCollision, type TokenModel } from "./types.js";
export {
  AliasExpansionError,
  expandTokenModes,
  type AliasExpansionErrorReason,
  type ExpandedTokenModes,
  type TokenLiteral,
} from "./modes.js";
export {
  classifyCollections,
  type ClassificationReport,
  type CollectionClassification,
  type CollectionRole,
} from "./classify.js";
export {
  AmbiguousThemeSourceError,
  computeBuilderChain,
  computeThemeModes,
  resolveDependsOn,
  type ThemeModeOptions,
  type ThemeModeVariant,
} from "./graph.js";
