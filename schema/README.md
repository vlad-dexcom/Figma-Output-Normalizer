# @figma-normalizator/schema

Versioned IR (Intermediate Representation) JSON Schema, generated TypeScript
types, and fixtures shared between the Figma plugin (which produces IR) and
any future consumer of that IR (a later stage — e.g. a Compose code-gen
pipeline).

## Layout

```
schema/
  ir/v1/schema.json          # node IR JSON Schema — source of truth
  tokens/v1/schema.json      # token document JSON Schema — source of truth
  src/generated/ir.ts        # TypeScript types generated FROM ir/v1/schema.json
  src/generated/tokens.ts    # TypeScript types generated FROM tokens/v1/schema.json
  src/index.ts               # public entry point (re-exports types + raw schemas)
  scripts/                   # the generator (generate-types.mjs / -lib.mjs)
  fixtures/                  # hand-written example IR documents
```

`ir/v1/schema.json` is the only hand-maintained source of truth for node
shapes. `src/generated/ir.ts` is generated from it — **never hand-edit it**.

## Versioning

The schema is versioned by directory/`$id` path segment: this is
**IR schema v1**, living at `schema/ir/v1/schema.json` with
`$id: https://schemas.figma-normalizator.dev/ir/v1/schema.json`. A
backwards-incompatible change to any node shape must land as a new
`schema/ir/v2/schema.json` (with its own generated types), not a mutation of
v1. Additive, backwards-compatible changes (e.g. a new optional field) may be
made in place within v1. `IR_SCHEMA_VERSION` (exported from `src/index.ts`)
mirrors the current version for consumers that want a runtime check.

## Regenerating types

```bash
cd schema
npm run generate:types
```

This reads `ir/v1/schema.json` and rewrites `src/generated/ir.ts` using
`json-schema-to-typescript`. Run it after every schema change and commit the
diff. `npm test` (via `schema/src/ir-schema.test.ts`) fails CI if the
generated file is stale relative to the schema, so this can't silently drift.

## Node kind contract

Every IR node shares a common envelope:

- `kind`: discriminant — one of `layout | text | instance | asset | overlay | list`.
- `source`: a `Provenance` block — `{ nodeId, fileKey, version, path }`, where
  `path` is the stable ancestor chain of node names/ids. Used to diff IR
  across re-exports of the same Figma file.
- Any children array is always named `children`.

| kind       | summary                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `layout`   | An Auto Layout container resolved to **intent**, not raw Figma enums: `direction` (`row \| column \| stack`), `gap`/`padding`/`background`/`cornerRadius` as `TokenValue`s, `mainAxisAlign`/`crossAxisAlign`, and `sizing` (`fixed \| fill \| hug` per axis). Contains `children: IRNode[]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `text`     | A text layer. `text` is a plain `string`, or a `StyledSegment[]` when Figma's `getStyledTextSegments` reports mixed-style runs within one text node. `typography` (`TokenRef \| null`) and `color` (`TokenValue \| null`).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `instance` | A component instance resolved to a real, mapped design-system component. **Opaque past this boundary** — its internal children are never included, since the mapped `component` name is strictly better information than reconstructing its Figma-side internals. Carries `component` (the mapped Compose component name), `props` (resolved TEXT/BOOLEAN/VARIANT component properties), `slots` (named slot content, e.g. `leadingIcon`/`trailingIcon`, for INSTANCE_SWAP or boolean-gated children), a partial `layout` for call-site-only sizing/spacing, and `unresolved` for anything that couldn't be mapped. An **unmapped** instance (no `component-map.yaml` entry, or `status: unmapped`) has no composable to protect and is never emitted as an `instance` node — the extractor instead recurses into its real children as if it were a plain container, while still emitting an `unmapped-component` `UnresolvedEntry` for the node. |
| `asset`    | A vector or image, represented as an `exportRef` (a deterministic suggested filename/drawable name) plus logical `width`/`height` — **never** inline path/geometry data.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `overlay`  | Absolutely positioned `children` inside an otherwise auto-layout parent. Each child carries its own `align` (`horizontal`/`vertical`) and optional pixel `offset`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `list`     | N identical/near-identical siblings collapsed to a single `itemTemplate: IRNode`, with `itemCount` recorded for information only (not a rendering directive).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

### Shared value types

- **`TokenValue`**: `{ token, value, modes?, symbol? }` — a resolved Figma
  variable/style, its concrete value, and (only when the value is
  theme-dependent) a `modes` map (e.g. `{ light: "#FFF", dark: "#000" }`).
- **`TokenRef`**: `{ token, symbol? }` — the `TokenValue` shape without a
  resolved `value`, used for typography tokens.
- **`UnresolvedEntry`**: `{ nodeId, reason, detail? }` — see below.

## The `unresolved[]` convention

Whenever the plugin cannot resolve a value — a missing variable binding, an
unmapped component variant from the component-map, etc. — it must **never**
silently substitute a literal or omit the field. Instead it emits an
`UnresolvedEntry { nodeId, reason, detail? }` into the nearest `unresolved[]`
array (currently only present on `instance` nodes, since that's where
variant/property mapping happens). This keeps IR generation total: every
input node produces _some_ IR, and anything uncertain is flagged rather than
guessed at.

## Determinism requirement

**IR produced from the same input Figma node MUST always be byte-identical.**
No timestamps, no random ids, no non-deterministic key/array ordering. This
is why there is deliberately no top-level `generatedAt` (or similar) field
anywhere in the schema — adding one would make this guarantee impossible to
satisfy. This is enforced by the plugin's own fixture/snapshot and
byte-identical-repeat-export tests (see `plugin/src/extractor/__tests__/
determinism.test.ts` and the "Determinism guarantee" section of
`plugin/README.md`); the schema itself is designed so nothing in it could
violate the guarantee.

## Forward-compat plan: adding `symbol` later

A later stage will map each `TokenValue`/`TokenRef.token` (a raw Figma
variable/style path, e.g. `"color/text/base/default"`) to a generated
design-system symbol name (e.g. `"AppTheme.semanticColors.text.base.default"`).
To make that additive rather than breaking:

- Both `TokenValue` and `TokenRef` already declare an **optional** `symbol`
  field in v1, even though nothing populates it yet.
- Because it's optional, no existing IR document needs to change shape when
  a producer starts populating it, and no consumer that ignores unknown
  optional fields needs to change either.
- This means the token-to-symbol mapping stage does not require a v2 schema
  bump — only new logic in the plugin (and typed consumption on the reader
  side, since the generated `TokenValue`/`TokenRef` TypeScript types already
  include `symbol?: string`).

**Update: this "later stage" has now happened, partially.** The plugin
extractor (`plugin/src/extractor/tokens.ts`'s `resolveVariable`) resolves
each token's **qualified** identity — `(collection, path)`, since a bare
path is ambiguous across collections — against the declarative wiring rules
in `mappings/wiring-rules/wiring-rules.yaml`, and populates
`TokenValue.symbol`/`TokenRef.symbol` plus `symbolFrom` (the id of the rule
that decided) when a rule confidently derives one. As of this snapshot that
is only the `base` collection's `color` branch; every other token still
resolves with `symbol` absent, which is the expected state and not a bug
(see `mappings/wiring-rules/README.md`). See `plugin/README.md`'s "Symbol
resolution (wiring rules)" section for the full mechanics.

`collection` and `symbolFrom` were added to `tokenValue`/`tokenRef` as
**optional** fields, which is an additive, backwards-compatible change
within v1 per the versioning policy above: a v1 document produced before
they existed still validates.

## Token document schema (tokens/v1)

`tokens/v1/schema.json` is a second, independently versioned document
describing a Figma file's **design-token variables**, produced by the same
plugin (`plugin/src/extractor/tokenExport.ts`) and typed by
`src/generated/tokens.ts` / `TOKENS_SCHEMA_VERSION`.

It is versioned separately from the node IR on purpose: the two describe
different things on different cadences — a _selection_ of the scene graph
that changes constantly, versus the _file's_ tokens which change rarely —
so tying them to one number would force meaningless version bumps.

Shape, briefly:

```
TokenDocument
  envelope     { schemaVersion, kind: "tokens", fileKey, version }
  policy       the exclusion policy actually applied, incl. unmatchedPatterns
  collections  [{ name, id, remote, defaultMode, modes, branches, dependsOn, tokens }]
  unresolved   [{ collection, path, reason, detail }]
```

Design decisions worth knowing:

- **The envelope carries `fileKey`/`version` once**, not per token. (The
  node IR still repeats them per node via `Provenance`; hoisting those out
  would be a v2 break and is deliberately not bundled into this change.)
- **No timestamp anywhere**, so re-exporting unchanged content is
  byte-identical.
- **Alias edges are preserved per mode** alongside resolved literals,
  because a leaf collection with one mode aliasing into a light/dark
  collection has a flattened value that is misleading on its own.
- **Mode order is Figma's declared order, never sorted**, and
  `defaultMode` is always carried.
- **Kotlin/codegen concerns are out of scope**: package names, class
  shapes, factory functions and build order stay in the generator. The
  document carries the observed raw material (`branches`, `dependsOn`,
  `modes`, `defaultMode`) those are derived from, because that is measured
  Figma structure rather than a codegen decision.
- **Nothing is ever silently dropped**: a variable that cannot be
  represented appears in `unresolved` with a stable reason code
  (`missing-alias-target`, `unresolvable-alias-chain`,
  `excluded-collection-alias`, `excluded-by-policy`, `unsupported-value`).

## Fixtures

`schema/fixtures/*.json` are hand-written, schema-valid example IR
documents used both as living documentation and as the input to the
"every fixture validates" test:

- `button-instance.json` — an `instance` node (`AppButton`) with TEXT and
  VARIANT props and empty slots.
- `container-with-text.json` — a `layout` node with themed
  background/spacing tokens containing a single `text` child with
  light/dark mode color.
