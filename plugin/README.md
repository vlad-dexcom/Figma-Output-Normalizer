# @figma-normalizator/plugin

The Figma plugin (TypeScript) that walks the scene graph, extracts the
Figma Normalizator IR, and shows it — plus hygiene warnings — in a panel a
designer can act on directly.

## Status

- **Extraction** (`src/extractor/`): implemented. See its own PR/task
  (`plugin-extractor`) for details on layout/token/instance/list/overlay
  resolution and the node budget.
- **Panel UI** (`src/ui.ts`/`src/ui.html`, `src/code.ts`): implemented in
  the `plugin-validator-ui` task. See "Using the panel" below.
- **Formal versioned export** (clipboard support, byte-identical repeat
  exports keyed by file key + node id + version): implemented in this task
  (`ir-export`). See "Using the panel", "Export versioning: what `version`
  means", and "Determinism guarantee" below.

## Using the panel

1. Select a frame (or any layer) on the canvas.
2. Run the plugin (**Plugins → Development → Figma Normalizator**). The
   panel shows the currently selected layer's name and type at the top.
3. Click **Extract**. This runs the extractor on the current selection and
   shows:
   - A pretty-printed JSON preview of the extracted IR.
   - A **Warnings** list, grouped by reason (see below), each entry showing
     its detail and Figma node id. Click **Select** on any entry to
     re-select and scroll to that node on the canvas. Click
     **Collapse all** (next to the Warnings heading, only shown when there
     are warnings) to hide individual entries while keeping each group's
     title and count visible — useful on a screen with many
     `unmapped-component` entries (e.g. one with few/no design-system
     components), where the full list would otherwise crowd out the IR
     preview. Click **Expand all** to bring the entries back; the toggle
     persists across re-Extracts of the same panel session.
   - If the selection is too large for the extractor's node budget (see
     `src/extractor/budget.ts`), a visible banner explains extraction was
     stopped rather than silently truncated — reselect a smaller region.
4. Click **Export** to download the extracted IR as
   `{fileKey}_{nodeId}_{version}.ir.json` (a plain browser file download —
   see `src/ui/filename.ts`), or click **Copy to clipboard** to copy the
   same content instead. Both serialize through the same canonical
   (key-order-sorted) JSON step — see "Determinism guarantee" below — so
   the file and the clipboard contents are always identical for the same
   extraction, and re-exporting an unchanged selection produces
   byte-identical output either way.

Selecting a different layer on the canvas at any time updates the header
and re-enables **Extract** for the new selection.

## `fileKey`: when it's populated, and what happens when it isn't

`Provenance.fileKey` and the `{fileKey}` segment of the export filename come
from `figma.fileKey`. That Plugin API field is not always readable:

- It requires `enablePrivatePluginApi: true` in `manifest.json` (already set
  here) — without it, the field doesn't exist at all.
- Even with that flag, **Figma only populates it for private/org plugins and
  Figma-owned resources** — a public or dev-mode-only install can still see
  it resolve to `undefined`.

When `figma.fileKey` is unavailable, `code.ts`'s `resolveFileKey` does not
silently degrade `Provenance.fileKey` to an empty string with no trace of
why — it still uses `""` (the schema requires a `string`, and inventing a
fake key would be worse), but also pushes an explicit `missing-file-key`
`UnresolvedEntry` (see "Warning reasons" below) naming the selection's root
node, so the gap is visible in the panel's warnings list rather than only
showing up later as "why do exports from two different files look the
same?". If this plugin is ever distributed outside the org that owns it,
expect `fileKey` to be consistently missing and this warning to always
fire — that's an accurate reflection of what the Plugin API allows for
non-private installs, not a bug to chase.

## Export versioning: what `version` means

`Provenance.version` (and the `{version}` segment of the export filename)
is **not** a Figma file/revision version — the Plugin API exposes no
per-node version/revision counter to read. The options actually available,
and why none of them fit directly:

- `node.id` — stable across edits, but for exactly that reason it does
  **not** change when the node's content changes, so it can't answer "did
  this change since I last exported it?".
- File-level version history (`figma.saveVersionHistoryAsync`, the file's
  version list) — a _file_-scoped concept, not readable synchronously for
  an arbitrary node, and would tie a single exported node's version to
  unrelated edits elsewhere in the same file.

**What we ship instead:** `version` is a deterministic content hash
(FNV-1a, 64-bit, formatted as `c1-<16 hex chars>`) computed from the
extracted IR itself, after canonicalizing it (see "Determinism guarantee"
below) — see `src/extractor/versioning.ts`. In practice:

- The same selection, extracted twice with no underlying Figma change,
  gets the same `version` (and therefore the same filename and byte-for-byte
  identical file/clipboard content).
- Any change to a field the extractor actually captures (layout, resolved
  tokens, text, instance props, children, ...) changes the hash.
- A Figma-side edit that does **not** touch anything the IR captures (e.g.
  renaming an unrelated internal layer, or changing geometry/data the
  schema intentionally omits) will **not** change `version` — this is a
  deliberate consequence of "version tracks extracted content, not raw
  Figma state", not a bug, but it is a real limitation worth knowing:
  `version` answers "did the exported IR change", not "did the Figma node
  change at all".
- This is a plain, non-cryptographic hash chosen for determinism and zero
  runtime dependencies (`crypto.subtle` is async and its plugin-sandbox
  availability isn't guaranteed), not for collision-resistance against
  adversarial input. Hash collisions are astronomically unlikely for this
  use case (detecting accidental content drift between two exports, not
  defending against someone deliberately engineering a collision), but they
  are not cryptographically impossible.

Tests may still pass an explicit literal version (`ExtractionSource.version`)
to `extractSelection` when a fixed, human-readable value is more useful for
a fixture/snapshot — see `extractor/types.ts`. Production code (`code.ts`)
never does; it always uses the computed content hash.

**This is a real design decision made under real Plugin API constraints,
not an incidental implementation detail — flagged here explicitly for
review**, since there's no perfect answer available.

## The export envelope: `IRDocument` and `schemaVersion`

The clipboard-copy/file-download payload (`serializeForExport` in `ui.ts`)
is `ExtractionResult` — `{ schemaVersion, nodes, unresolved, version }` —
not a single IR node. `schema/ir/v1/schema.json`'s root `$ref` only
describes one `irNode` (used to validate one entry of `nodes[]`); it now
also defines `$defs/irDocument` for this envelope shape, and
`schemaVersion` (`IR_SCHEMA_VERSION` from `@figma-normalizator/schema`, a
literal `1` matching this schema's `v1` path segment) is threaded all the
way from `extractSelection`'s return value into every exported artifact.
Previously (backlog G6/G7) no exported `*.ir.json` carried its own schema
version at all, and the schema had nothing to validate the envelope
against — only `nodes[i]` individually. A future v2 consumer/migration
tool can now branch on `schemaVersion` instead of guessing from shape, and
`fixtures/src/__tests__/schema-validation.test.ts` validates each fixture's
whole file against `irDocument`, not just its `nodes[]` entries.

## Symbol resolution (wiring rules)

Beyond resolving a variable's raw path and value(s), `resolveVariable`
(`src/extractor/tokens.ts`) resolves the **qualified** token identity
`(collection, path)` against the declarative wiring rules in
`mappings/wiring-rules/wiring-rules.yaml`, populating
`TokenValue.symbol`/`TokenRef.symbol` plus `symbolFrom` (which rule
decided) when a rule confidently derives one.

- **Identity is qualified, always.** `TokenValue.collection` /
  `TokenRef.collection` carry the owning Figma collection name alongside
  the path, and lookup takes both. A bare path is ambiguous: sibling
  collections routinely define the same path with different values. The
  retired `token-map` bundle was indexed by path alone while two
  collections shared 324 of 324 paths — see
  `mappings/wiring-rules/README.md` for the measurements.
- **An unknown collection is never treated as `base`.** If the owning
  collection can't be read, `collection` is `null` and only rules with no
  collection constraint can match. Conservative on purpose: a
  confidently-wrong symbol is worse than an absent one.
- **Rules, not a table.** There is no checked-in token->symbol artifact to
  keep fresh. The rules are evaluated live against whatever the file
  actually contains, so they cannot go stale the way the 2371-row
  `android-*.token-map.json` artifacts did.
- **What ends up populated:** as of this snapshot, only the `base`
  collection's `color` branch. Every other token (`opacity`, `radius`,
  `border-width`, `typography`, `components`, `layout`, `primitives`, ...)
  resolves with `symbol` simply **absent** — the expected, normal state for
  most tokens, not a hygiene problem. No `unresolved[]` entry is raised for
  it, and none should be added without a concrete, documented reason.
- **`codeSyntax` is not a symbol source.** Figma publishes per-platform
  `codeSyntax` for many variables, and the token export carries it under
  `hints.codeSyntax`. It is deliberately excluded from symbol resolution:
  the platform is moving to a Styles API that will supply the real symbols.
  Hints are for humans and coding agents choosing a name, never something
  the pipeline resolves against.
- **Which variable's path gets looked up:** always the outermost/semantic
  variable's own `(collection, name)` — never an inner primitive it aliases
  through. Alias resolution only ever affects `value`/`modes`.

## Token export (file-scoped)

Alongside the selection-scoped IR export, the plugin can export the file's
**design tokens** as a `TokenDocument` (`schema/tokens/v1/schema.json`) via
the panel's "Extract tokens" / "Export tokens" buttons
(`src/extractor/tokenExport.ts`).

The two exports are split by **cadence**, not by subject: tokens are
file-scoped and change rarely; screens are selection-scoped and change
constantly. That is why the token buttons sit on their own toolbar row and
are unaffected by the current selection, and why the token filename
(`{fileKey}_{version}.tokens.json`) carries no node id.

### Why this runs in the plugin

A raw variables dump cannot resolve its own alias graph. Measured on a real
production file: 71% of all mode values were aliases, and 327 alias targets
were dangling — ids referenced by the payload but absent from it, because
they live in imported libraries. `getVariableByIdAsync` resolves those, so
the whole failure class disappears on this side. Mode _names_, the default
mode, and `scopes` are likewise only meaningful here.

### Invariants

1. **No silent drops.** Every in-policy variable is either emitted in
   `collections` or recorded in `unresolved` with a reason code. Never
   neither. (The pipeline this replaces silently lost three variables: two
   aliasing an absent remote library variable, one deleted-but-referenced.)
2. **Alias edges are facts; resolved literals are a view.** Both are
   emitted. A single-mode leaf collection aliasing into a light/dark
   collection has a flattened value that is actively misleading alone.
3. **Figma's declared order is content.** Mode order is never sorted, and
   `defaultMode` is always carried.
4. **Determinism.** The document is serialized through `canonicalStringify`
   and versioned by a content hash of itself, with no timestamp — so
   re-exporting unchanged content is byte-identical, not merely deep-equal.

### Policy

Which collections and branches are in scope is controlled by
`mappings/collections-policy.yaml`, the plugin-side equivalent of the
platform generator's `configs/collections.toml` (same glob dialect, same
case-insensitivity, same `<collection>/<branch>` rule). It is bundled at
build time because the plugin sandbox has no filesystem and no network
access.

Remote (imported-library) collections are excluded by default: the same
real file carried 41 collections of which only 6 were local, and the remote
ones collided by name (five `Primitives`, six `Mode`, five `base`).

The applied policy is echoed into the exported document's `policy` block,
including `unmatchedPatterns` — a pattern that matches nothing is reported
rather than silently ignored, because it looks like a working exclusion and
behaves like a typo.

## Typography literal fallback

`TokenRef.literal` (see `schema/ir/v1/schema.json`'s `typographyLiteral`
def) is populated only when `TokenRef.token` is `null` — i.e. exactly the
cases `resolveTypographyToken` already reports via an `unbound-literal` (or
`unresolvable-alias-chain`) `UnresolvedEntry`. Before this existed, an
unbound text run lost `fontFamily`/`fontSize`/`fontWeight`/`lineHeight`/
`letterSpacing` entirely — the IR recorded that something was wrong but
gave a codegen consumer nothing to render the text with. `buildTextNode`
now threads the same `getStyledTextSegments` segment used for
`boundVariables` into `resolveTypographyToken`, which reads its raw
`fontName`/`fontSize`/`fontWeight`/`lineHeight`/`letterSpacing` fields
directly (no resolution, no token lookup) into `literal`. Fields Figma
doesn't report for a given segment are simply omitted rather than defaulted
to `0`/`""`; `literal` itself is omitted entirely (not an empty object)
when nothing was readable. This is additive-only: any `TokenRef` with a
non-null `token` is unaffected.

## Sizing dimensions

`Sizing.dimensions` (`{ width?, height? }` px, rounded to whole pixels) is
populated by `resolveSizing` (`layout.ts`) directly from `node.width`/
`node.height`, alongside the existing `width`/`height` sizing **modes**
(`"fixed"`/`"fill"`/`"hug"`). Previously a `"fixed"` mode carried no actual
size — the single most common case in real screens — leaving a codegen
consumer with nothing to size the node with. `dimensions` is populated
regardless of mode (a `"fill"`/`"hug"` node's current rendered size is
still a useful hint, just not the authoritative size — that's computed by
the layout engine, not this fixed snapshot) and omitted entirely (not an
empty object) when neither dimension is readable off the node. This
mirrors `AssetNode.width`/`height`'s existing rounding convention
(`Math.round`) and, like `TokenRef.literal` above, is additive-only.

## Border, effects, and opacity

`LayoutNode` now carries three more optional fields, previously dropped
entirely with no `UnresolvedEntry` at all (backlog item B5,
docs/BACKLOG.md) — all resolved in `extractor/effects.ts`:

- **`border`** (`Border | undefined`): resolved from `node.strokes` (color,
  via the same SOLID-paint/bound-variable logic as `background`, factored
  into a shared `resolvePaintColor` in `tokens.ts`) + `node.strokeWeight`
  (bound-variable-aware, like `gap`/`cornerRadius`) + `node.strokeAlign`
  (a plain enum: `"inside"`/`"outside"`/`"center"`, not a design token —
  there's nothing to bind a variable to). Omitted entirely (not `null`)
  when the node has no strokes at all.
- **`effects`** (`ShadowEffect[] | undefined`): resolved from `node.effects`.
  Only `DROP_SHADOW`/`INNER_SHADOW` are modeled; `LAYER_BLUR`/
  `BACKGROUND_BLUR` push an `unsupported-effect` UnresolvedEntry instead
  (see the "Warning reasons" table). Effect colors are resolved as literal
  values only — Figma's per-effect variable binding is not attempted here,
  a deliberately scoped-down first pass, not a silent loss (the effect
  itself is still always accounted for, in `effects[]` or `unresolved[]`).
  Omitted entirely when the node has no modeled effects.
- **`opacity`** (`number | undefined`): `node.opacity`, omitted when `1`
  (fully opaque, the default) to avoid noise on the overwhelming majority
  of nodes.

**Still open from B5** (not addressed by this pass): `rotation`,
`blendMode`, `clipsContent`, `textAlignHorizontal`/`textAlignVertical`,
`textAutoResize`, `maxLines`, `letterSpacing`/`lineHeight` at the node
level (the literal-typography fallback above covers these per-segment, not
as a first-class `TextNode`/`LayoutNode` field), `counterAxisSpacing`
(grid/wrap), `layoutWrap`, `constraints`, `minWidth`/`maxWidth`. See
docs/BACKLOG.md B5 for the up-to-date remaining list.

## Non-solid paints (gradients, images, video)

`background`/`border` colors are resolved from the first visible `SOLID`
paint in `node.fills`/`node.strokes` only (`resolvePaintColor` in
`tokens.ts`) — gradients and image/video fills are not converted to a
color. Previously a node with, say, only a `GRADIENT_LINEAR` fill and no
`SOLID` fill got a plain `background: null`, indistinguishable from a node
that's genuinely transparent by design (backlog G1). Now that case pushes
an `unsupported-paint` UnresolvedEntry naming the paint type(s) actually
present, so the loss is visible instead of silent — see the "Warning
reasons" table below. This does not add gradient/image support itself;
that remains open (see docs/BACKLOG.md).

## Deterministic `exportRef` collision handling

`AssetNode.exportRef` starts as a slug of the node's name (`slugify` in
`slug.ts`). Two unrelated graphics with the same name (e.g. two layers
both called "icon" — backlog G2, seen 3x/2x/2x in a real export) used to
slugify to the same `exportRef` and silently collide, so one graphic's
export would overwrite the other's file on disk. `resolveExportRef`
(`asset.ts`) now tracks every assigned base slug in a
`ProvenanceContext.exportRefRegistry` shared for the whole
`extractSelection` call; a second node claiming an already-taken slug gets
its Figma node id appended (`"icon"` -> `"icon_165_3186"`) and a
`duplicate-export-ref` UnresolvedEntry naming both the original slug and
its disambiguated replacement. Disambiguation is keyed by node id, not
processing order, so the same node always gets the same `exportRef`
regardless of selection/traversal order.

## Asset type classification

`inferAssetType` (`asset.ts`) is a deliberately approximate heuristic, not
a reliable classifier — see docs/BACKLOG.md G3. It checks, in order: (1)
the node's name contains "icon" (case-insensitive) -> `"icon"`; (2) the
node is at most 48x48 -> `"icon"` (added for G3: a real export had glyphs
like `misc_lightbulb` 32x32 with no "icon" in the name, previously
misclassified as `"image"`); (3) a top-level node at least 120x120 ->
`"illustration"`; (4) otherwise -> `"image"`. Size thresholds are a
judgment call, not derived from any Figma metadata — a real screen may
still have edge cases (e.g. a non-square icon-ish glyph with one side over
48px) that this doesn't catch; `assetType` should be treated as a hint for
codegen/asset-pipeline tooling, not an authoritative classification.

## Variable alias resolution

A Figma Variable's value for a given mode is not always a literal
(number/string/color) — it is very commonly a `VARIABLE_ALIAS` pointing at
_another_ variable instead. This is exactly how semantic tokens are built
on top of primitive/palette tokens in most design systems (e.g.
`color/surface/tone/emphasis` aliasing `color/palette/blue/500`), and
`resolveVariable` (`src/extractor/tokens.ts`) must follow that pointer to
produce a real value rather than stringifying the alias object itself.

- **Aliases are followed recursively, not just one hop.** A semantic token
  may alias another semantic token, which aliases a primitive — `resolveVariable`
  keeps following `VARIABLE_ALIAS` values until it lands on a literal.
- **The token path emitted is always the outermost (semantic) variable's
  name**, never the primitive it happens to resolve through. A consumer of
  the exported IR references `color/surface/tone/emphasis`, not
  `color/palette/blue/500` — the alias chain is purely an implementation
  detail of how that value was authored in Figma.
- **Cross-collection mode matching (a real design decision with more than
  one reasonable answer, flagged here for review — see "Export
  versioning" above for how thoroughly we try to document these):** Figma
  allows an alias target to live in a _different_ variable collection with
  a _different_ set of modes than the aliasing variable. When resolving
  variable A's "dark" mode value, which is an alias to variable B, B's own
  collection might not have a mode named "dark" at all (e.g. B's
  collection only has a single "value" mode, or uses different mode
  names). In that case we fall back to **B's own default mode value**
  rather than producing `undefined`/an empty value. We chose this over the
  alternatives (erroring, or picking B's first mode arbitrarily) because
  "the value the design system intends when no more specific mode
  applies" is exactly what a variable's default mode already means within
  its own collection — but a strict Figma Variables API consumer could
  reasonably argue for surfacing this as an explicit warning instead of
  silently falling back. Reviewers: if you disagree with this choice,
  flag it and we can add an `UnresolvedEntry` for the fallback case too.
- **Cycle/depth guard:** a circular alias chain (A aliases B aliases A) or
  a pathologically deep one in a malformed Figma file could otherwise hang
  the plugin sandbox in an infinite loop. `resolveVariable` tracks visited
  variable ids and hop depth, and gives up after 10 hops or on detecting a
  revisited id — 10 is far beyond any real design-token chain (semantic ->
  semantic -> primitive is 2 hops), so hitting it is a strong signal of a
  cycle. When the guard trips, the field resolves to `{ token: null, value:
<raw literal> }` plus an `unresolvable-alias-chain` `UnresolvedEntry`
  (see "Warning reasons" below), the same `unresolved[]`-channel philosophy
  already used for `unbound-literal`/`mixed-value`/etc — never a silently
  dropped or invented value.

## Performance: variable/collection caching and signature memoization

Two hot paths that scale with node/reference count, not with the number of
_distinct_ variables/structures involved, are memoized for the lifetime of
a single `extractSelection` call:

- **Variable/collection lookups (`src/extractor/variableCache.ts`).** A
  real screen routinely re-references the same handful of tokens (e.g.
  `color/text/primary`) from dozens of nodes/fields. `extractSelection`
  wraps `figma.variables` once, at the top of the call, in
  `createCachingVariablesAPI`, which memoizes `getVariableByIdAsync`/
  `getVariableCollectionByIdAsync` by id — including caching the in-flight
  `Promise`, not just its resolved value, so two concurrent lookups for the
  same id (this extractor `Promise.all`s many fields per node) share one
  underlying Plugin API call instead of racing duplicate requests. This
  turns repeated-token cost from O(references) Plugin API round-trips into
  O(distinct variables/collections).
- **List-collapsing structural signatures (`src/extractor/list.ts`).**
  `collapseLists` scans siblings for runs of structurally-identical nodes
  by comparing a deep structural signature of each candidate against its
  predecessor. Previously each comparison recomputed both sides' signatures
  from scratch (including every descendant), so the same node's signature
  could be rebuilt many times over a long run. `collapseLists` now keeps a
  `Map<FigmaNode, string>` cache scoped to one call, so each node's
  signature is computed once and reused for every comparison it takes part
  in.

Both caches are local to a single call (a plain `Map`/closure, not a
module-level singleton), so nothing leaks across separate extractions or
test runs, and re-running `extractSelection` on a changed selection always
sees fresh Plugin API state.

## Determinism guarantee

**Exporting the same, unchanged selection twice MUST produce byte-identical
output** (not just deep-equal — the literal file bytes / clipboard string
must match). Two things make this hold:

1. Every extractor function already builds its result objects with a
   fixed, hand-written property order, so a single code path is already
   deterministic key-order-wise for identical input.
2. As defense-in-depth on top of that (and to make it explicit and tested,
   not incidental), both the file download and the clipboard copy in
   `ui.ts` serialize through `canonicalStringify` (`src/extractor/canonical.ts`),
   which recursively sorts every object's keys (array order is untouched —
   array order is meaningful IR content) before `JSON.stringify`-ing. Two
   structurally-identical IR trees built via different code paths would
   still serialize identically through this step even if their construction
   order differed.

`src/extractor/__tests__/determinism.test.ts` is the primary test for this
guarantee: it builds the same mock Figma tree twice (independently, with a
`resetAutoIds()` reset in between so even node-id allocation is identical)
and asserts `JSON.stringify(result1) === JSON.stringify(result2)` —
byte-for-byte string equality, not `toEqual` — plus the same check through
`canonicalStringify` and matching content-hash `version`s.

## Clipboard export

Figma's plugin UI panel is a same-origin sandboxed iframe. `src/ui/clipboard.ts`
implements `copyToClipboard`, which:

1. Tries `navigator.clipboard.writeText` first (the modern Clipboard API) —
   this generally works from the panel iframe because the copy is
   synchronously triggered by a real user gesture (a click), which is
   exactly the case Clipboard API permission checks are designed to allow.
   It is not, however, guaranteed on every Figma desktop/browser/OS
   combination the plugin might run on (older Chromium/Electron builds, a
   host that hasn't granted the iframe `clipboard-write`, etc).
2. Falls back to the older, far more broadly-supported
   `document.execCommand("copy")` (via a hidden, focused, selected
   `<textarea>`) if the modern API is unavailable or rejects.
3. If both fail, returns a descriptive error — `ui.ts` shows this visibly
   as inline status text next to the button (auto-clearing after a few
   seconds), the same "never fail silently" principle the extraction
   budget-exceeded banner already follows. It never throws or drops the
   failure.

`copyToClipboard` takes its browser dependencies (`writeText`/`fallbackCopy`)
as arguments rather than touching `navigator`/`document` directly, so it's
fully unit-testable without a DOM — see `src/ui/__tests__/clipboard.test.ts`.
`ui.ts` wires the real browser APIs via `buildClipboardDeps()`.

### Warning reasons

Each entry's `severity` (`"error"` / `"warning"` / `"info"`) is assigned
centrally from `reason` by `extractor/severity.ts` — see "Severity and
warning ordering" below.

| Reason                            | Severity | Emitted by                                           | Meaning                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| --------------------------------- | -------- | ---------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `unbound-literal`                 | warning  | extractor (`tokens.ts`)                              | A color/spacing/typography value has no bound Figma variable/style.                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `unresolvable-alias-chain`        | error    | extractor (`tokens.ts`)                              | A bound variable's value is a `VARIABLE_ALIAS` chain that is circular, or exceeds the max alias-hop depth (10), so it could not be followed to a literal value. See "Variable alias resolution" above.                                                                                                                                                                                                                                                                                                                        |
| `unmapped-variant`                | error    | extractor (`instance.ts`)                            | A component's VARIANT property value has no `component-map.yaml` routing.                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `unmapped-component`              | error    | extractor (`instance.ts`)                            | A component set has no `component-map.yaml` entry (or no mapped Compose component) at all. The instance's real children are still recursed into and extracted (see "Instance boundary" below) — this is a hygiene warning, not a truncation.                                                                                                                                                                                                                                                                                  |
| `missing-main-component`          | error    | extractor (`instance.ts`)                            | An INSTANCE node whose main component couldn't be resolved (deleted, or in an unavailable library). See "Detached instances" below.                                                                                                                                                                                                                                                                                                                                                                                           |
| `unreadable-component-properties` | error    | extractor (`instance.ts`, also guarded in `list.ts`) | `node.componentProperties` is a Figma Plugin API getter that threw — the underlying component set has broken/conflicting variant definitions **in the Figma file itself**. This is a data-integrity issue in the design file, not a plugin bug, and can't be fixed by re-exporting or updating the plugin — repair it in Figma (Assets panel → find the component set → fix/republish its conflicting variant definitions). The instance's real children are still recursed into and extracted, same as `unmapped-component`. |
| `mixed-value`                     | warning  | extractor (`tokens.ts`, `index.ts`)                  | A property genuinely varies internally within the node — Figma's real Plugin API returns the `figma.mixed` sentinel (a `Symbol`) instead of a scalar value for it, e.g. a rectangle/frame with independent per-corner radii, or a node with multiple sets of fills. This can't be represented as a single token/value. This is a Figma-file-side authoring choice to potentially reconsider (e.g. use a uniform radius), not a plugin bug, similar in spirit to `unreadable-component-properties` above.                      |
| `absolute-positioning`            | info     | extractor (`overlay.ts`)                             | Children were grouped into an `overlay` node (absolutely positioned inside an Auto Layout parent). Structurally handled either way — this entry exists so it's also visible to designers in the warnings list.                                                                                                                                                                                                                                                                                                                |
| `missing-file-key`                | error    | `code.ts` (not the extractor)                        | `figma.fileKey` was unavailable (missing `enablePrivatePluginApi`, or a non-private/org install) — `Provenance.fileKey`/the export filename's `{fileKey}` segment fell back to `""`. See "`fileKey`: when it's populated, and what happens when it isn't" above.                                                                                                                                                                                                                                                              |
| `unsupported-effect`              | warning  | extractor (`effects.ts`)                             | The node has a `LAYER_BLUR`/`BACKGROUND_BLUR` effect, which isn't modeled in `ShadowEffect` (only `DROP_SHADOW`/`INNER_SHADOW` are) — dropped from `LayoutNode.effects` rather than silently. See "Border, effects, and opacity" below.                                                                                                                                                                                                                                                                                       |
| `unsupported-paint`               | warning  | extractor (`tokens.ts`)                              | A fill/stroke paint array has no visible `SOLID` paint, but does have another visible paint type (`GRADIENT_LINEAR`/`GRADIENT_RADIAL`/`GRADIENT_ANGULAR`/`GRADIENT_DIAMOND`/`IMAGE`/`VIDEO`) — only `SOLID` is resolved to a color, so the color is dropped from `background`/`border` instead of silently.                                                                                                                                                                                                                   |
| `duplicate-export-ref`            | warning  | extractor (`asset.ts`)                               | Two different asset nodes slugified to the same `exportRef`; the second one was disambiguated with a node-id suffix so the two exports don't overwrite the same output file. See "Deterministic `exportRef` collision handling" above.                                                                                                                                                                                                                                                                                        |

Reasons above the line are extractor-emitted (present in `unresolved[]` in
the IR itself); `absolute-positioning` was added in this task as a small,
targeted extractor change (`overlay.ts`) specifically so the UI can surface
it, per the plugin-validator-ui task description.

### Severity and warning ordering

A real screen's `unresolved[]` can run into the hundreds of entries (one
real export analyzed during this project had 361), and the overwhelming
majority are routine `unbound-literal` noise (a spacing value with no
bound variable) rather than actual design-system problems. To keep real
problems from getting lost:

- Every `UnresolvedEntry` now carries an optional `severity`
  (`"error" | "warning" | "info"`), stamped once by `withSeverity`
  (`extractor/severity.ts`) at the very end of `extractSelection`, from a
  fixed table keyed by `reason` (see the table above). Extractors
  themselves never set `severity` at the point they emit an entry — the
  classification lives in exactly one place.
- `"error"`: the exported value is actually missing/wrong for a
  design-system-mapped concept (unmapped component/variant, an
  unresolvable alias chain, a missing main component, ...) — something a
  human needs to fix in Figma or `component-map.yaml`.
- `"warning"`: a literal was used where a token binding was expected.
  Extremely common and often perfectly fine, but worth eventually binding
  a variable.
- `"info"`: expected/structural, surfaced purely for visibility
  (`absolute-positioning`).
- The panel's warnings list (`ui/warnings.ts`'s `groupWarningsByReason`)
  groups by `reason` as before, but now stably sorts the groups by
  severity (error, then warning, then info) before rendering — so, e.g.,
  a handful of `unmapped-component` entries surface above dozens of
  `unbound-literal` entries, without merging, discarding, or hiding any
  individual entry.
- Because `InstanceNode.unresolved` and the flattened top-level array
  share the same entry objects (see `index.ts`), stamping severity on the
  flattened array covers the nested copies too — no separate tree walk.
- `severity` is optional in the schema for backward compatibility: an
  older exported `*.ir.json` that predates this field is still valid, and
  the UI/`groupWarningsByReason` treat a missing `severity` as
  `"warning"`-ranked for sorting purposes.

### Instance boundary: opaque only when mapped

An INSTANCE node is only treated as opaque (its own `instance` IR node,
zero descended children) when it resolves to a real, mapped design-system
composable — the whole point of that opacity is that the composable call
is strictly better information than reconstructing its Figma-side internals
(rectangles, text nodes, icons), which a consumer must not act on anyway.

An **unmapped** instance (no `component-map.yaml` entry, or an entry that
resolves to `status: unmapped`/no compose component) has no composable to
protect, so there is no upside to stopping recursion there — it falls back
to the same container-handling path a plain FRAME would take (`instance.ts`

- `index.ts`), recursing into its real children (text, nested mapped
  instances, assets, plain layout) instead of discarding them. The
  `unmapped-component`/`missing-main-component` warning is still emitted for
  the node so the hygiene signal isn't lost — only the truncation is fixed.

### Detached instances: a known limitation

The task description asks for a "detached instance" hygiene warning: a
node that used to be a component instance but was disconnected from its
main component (Figma's _Detach Instance_ action). **We do not ship this
detection**, because Figma's plugin API provides no reliable signal for it:
once detached, the node's `type` simply becomes a plain `FRAME`/`GROUP` —
every instance-specific field (`mainComponent`, `componentProperties`,
etc.) is gone along with it, indistinguishable from a `FRAME` that was
never an instance. Any heuristic based on naming conventions or structure
would misfire on ordinary frames and was deliberately not shipped.

The closest thing we _can_ detect with an actual API signal is different:
an **INSTANCE** node whose `getMainComponentAsync()` resolves to `null`
(main component deleted, or from a library the file no longer has access
to) — flagged as `missing-main-component`. This is a real, distinct hygiene
issue worth surfacing, but it is not the same thing as a detached instance,
and designers should not conflate the two.

## Layout

```
manifest.json          # Figma plugin manifest
src/code.ts              # sandboxed plugin-API entry point (no DOM access)
src/ui.ts                 # UI iframe entry point (DOM, no Figma API access)
src/ui.html                 # panel markup; build inlines the bundled ui.ts into it
src/ui/                       # pure, tested UI logic (warning grouping, export filename, clipboard)
src/messages.ts                # shared code.ts <-> ui.ts message protocol
src/extractor/                   # IR extraction (see plugin-extractor task)
src/test/mockFigma.ts              # createMockFigma() helper for headless tests
src/__tests__/                       # vitest specs for code.ts
scripts/build.mjs                      # esbuild build script
dist/                                     # build output (git-ignored), loaded by Figma
```

## Building

```bash
npm run build
```

Bundles `src/code.ts` with esbuild into `dist/code.js`. Separately bundles
`src/ui.ts` and inlines the result into `dist/ui.html` in place of the
`<!-- BUILD:UI_SCRIPT -->` placeholder in `src/ui.html` — Figma's plugin UI
iframe has no external resource loading (and this manifest declares no
network access), so the UI's JS must live inline in the HTML file it ships
in. `manifest.json`'s `main` and `ui` fields point at these built files, not
the TypeScript sources.

## Loading the plugin locally in Figma

1. Run `npm run build` in this package (or from the repo root).
2. In the Figma desktop app: **Plugins → Development → Import plugin from
   manifest…**, then select `plugin/manifest.json` in this repo.
3. Run the plugin from **Plugins → Development → Figma Normalizator**. See
   "Using the panel" above.

Note: `manifest.json`'s `id` is a placeholder. It needs to be replaced with
a real plugin id once/if this plugin is published to a Figma org.

## Running the headless test harness

```bash
npm test        # from this package, or `npm test` from the repo root (vitest runs all workspaces)
```

Plugin code runs inside Figma's sandbox, so tests can't use a real `figma`
global. Instead, `src/test/mockFigma.ts` exports `createMockFigma()`, a
stub of the `figma` API surface `code.ts` touches (selection,
`selectionchange`/`ui.on("message")` listeners, `getNodeByIdAsync`,
`viewport.scrollAndZoomIntoView`, etc.) — see its `MockFigma` type for the
test-only `triggerSelectionChange`/`triggerUIMessage` helpers used to drive
those listeners from a test.

`ui.ts` itself is deliberately kept thin (mostly DOM wiring) rather than
tested with a headless DOM shim: the substantive logic it depends on
(warning grouping in `src/ui/warnings.ts`, export filename generation in
`src/ui/filename.ts`) is extracted into small pure functions and tested
directly under `src/ui/__tests__/`.

## Other scripts

- `npm run typecheck` — `tsc --noEmit`, using `@figma/plugin-typings` for
  the Figma plugin API globals (`figma`, `PluginAPI`, node types, etc.) and
  the DOM lib for `ui.ts`'s browser APIs.
- `npm run lint` (from the repo root) — ESLint across all packages.
