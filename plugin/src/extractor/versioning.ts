// Content-hash "version" derivation for Provenance.version.
//
// Why not a real Figma version number: the Plugin API exposes no per-node
// version/revision counter. `node.id` is stable but does NOT change when a
// node is edited (so it can't signal "this changed"). File-level version
// history (`figma.saveVersionHistoryAsync` / the file's version list) is a
// *file*-level, not *node*-level, concept, is not synchronously readable
// for an arbitrary node's own history, and would tie every exported node's
// version to unrelated edits elsewhere in the file — not what a consumer
// diffing a single re-exported node wants.
//
// What we do instead: after extraction, compute a deterministic content
// hash over the extracted IR itself (via `canonicalStringify`, so key
// order never affects the hash) and use that as `version`. This means:
//   - Same selection, unchanged Figma content -> same hash -> same
//     version, satisfying the "export twice, get identical output"
//     requirement this task is built around.
//   - Any change to a captured IR field (layout, tokens, text, instance
//     props, children, etc.) changes the hash.
//   - A Figma-side edit that does NOT affect any field the extractor
//     actually captures (e.g. renaming an unrelated internal note, or a
//     change to geometry/data the IR intentionally omits) will NOT change
//     the version. This is a deliberate consequence of "version tracks
//     extracted content", not a bug — but it does mean this is not a
//     substitute for a true Figma-side revision id if one ever becomes
//     available via the Plugin API.
//   - This is a plain, non-cryptographic hash (FNV-1a, 64-bit). It is
//     picked for determinism and zero dependencies (no `crypto.subtle`,
//     which is async and not guaranteed present in every environment this
//     code runs in), not for collision-resistance against adversarial
//     input — collisions are astronomically unlikely for this use case
//     (detecting accidental content drift, not defending against a
//     party deliberately crafting a colliding IR tree) but are not
//     cryptographically impossible.
import { canonicalStringify } from "./canonical.js";

/** Version scheme tag, so a future change to the hash algorithm can be distinguished from this one. */
const VERSION_SCHEME = "c1";

const FNV_OFFSET_BASIS = BigInt("0xcbf29ce484222325");
const FNV_PRIME = BigInt("0x100000001b3");
const MASK_64 = BigInt("0xffffffffffffffff");

function fnv1a64(input: string): bigint {
  let hash = FNV_OFFSET_BASIS;
  for (let i = 0; i < input.length; i++) {
    hash ^= BigInt(input.charCodeAt(i));
    hash = (hash * FNV_PRIME) & MASK_64;
  }
  return hash;
}

/**
 * Derives a stable content hash from any already-extracted payload.
 *
 * Used for both `Provenance.version` on the node IR and
 * `TokenDocument.envelope.version`, which is why it is typed on `unknown`
 * rather than `IRNode[]`: the guarantee it provides ("same content in, same
 * version out, independent of key order") is about serialization, not about
 * a particular document shape.
 *
 * For the node IR, callers should extract with a placeholder `version`
 * first (any fixed value is fine — it just needs to be the same on every
 * call so the hash input is otherwise deterministic), then substitute the
 * real hash back in via `withVersion` below.
 */
export function computeContentVersion(payload: unknown): string {
  const canonicalJSON = canonicalStringify(payload);
  const hash = fnv1a64(canonicalJSON);
  return `${VERSION_SCHEME}-${hash.toString(16).padStart(16, "0")}`;
}

function isProvenanceShaped(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    "nodeId" in value &&
    "fileKey" in value &&
    "version" in value &&
    "path" in value
  );
}

/**
 * Walks an arbitrary (IR-shaped) value and returns a copy with every
 * `Provenance.version` field — found structurally, since `Provenance`
 * blocks appear nested at varying depths (`source`, `slots.*.source`,
 * `itemTemplate.source`, `overlay children[].node.source`, ...) — replaced
 * by `version`. Every other field is left untouched.
 */
export function withVersion<T>(value: T, version: string): T {
  if (Array.isArray(value)) {
    return value.map((item) => withVersion(item, version)) as unknown as T;
  }
  if (isProvenanceShaped(value)) {
    return { ...value, version } as unknown as T;
  }
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {};
    for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
      result[key] = withVersion(entry, version);
    }
    return result as unknown as T;
  }
  return value;
}
