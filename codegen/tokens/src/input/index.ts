export { TokenEnvelopeError, assertTokenEnvelope } from "./guards.js";
export { TokenDocumentValidationError, loadTokenDocument, parseTokenDocument } from "./load.js";
export {
  assertPolicyFresh,
  checkPolicyStaleness,
  warnAboutUnmatchedPolicyPatterns,
  type PolicyStalenessResult,
} from "./policy.js";
export {
  applyCollectionFallbacks,
  detectCollectionFallbacks,
  parseFallbackCollectionArg,
  type DetectedFallbacks,
  type FallbackMapping,
  type FallbackResult,
} from "./fallback.js";
export {
  DEFAULT_UNRESOLVED_ACTIONS,
  UnresolvedTokensError,
  assertNoUnresolvedFailures,
  triageUnresolved,
  warnAboutUnresolved,
  type UnresolvedAction,
  type UnresolvedActionOverrides,
  type UnresolvedReason,
  type UnresolvedTriage,
} from "./unresolved.js";
