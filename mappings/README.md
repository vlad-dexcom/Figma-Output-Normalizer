# mappings

This package documents the mapping from Figma component sets (in the
**NUI - iOS Components** library, file key `z4Ns3yQoXwMgjky6H9WYtP`) to the
**Android_Avalon** Jetpack Compose design system components
(`com.dexcom.platform.design.component.*`).

The mapping itself lives in [`component-map.yaml`](./component-map.yaml). It
is data, not code: a later Stage-1 task (the plugin-extractor) reads this
file to resolve a Figma node's `component` name and its `props.type` /
`props.size` / etc. fields when building the IR.

## Why this file exists

Figma component variant names and Compose enum names are usually close but
not identical, and sometimes they diverge significantly, or don't exist on
one side at all. Rather than have the extractor guess or silently drop
data, this file is the single source of truth for:

- which Figma component set maps to which Compose component,
- how each Figma **VARIANT-type** property value maps to a Compose enum
  member (or boolean, for state-based components),
- which values have **no** mapping yet, and why.

Only Figma component properties of type `VARIANT` are covered here. Other
property types (`TEXT`, `BOOLEAN`, `INSTANCE_SWAP`) - e.g. button labels,
icon swaps, badge counts - map to composable parameters/slots instead of
enum variants, and resolving those is the extractor's job, not this file's.

## Reading an entry

Each entry under `entries:` describes one Figma component set:

```yaml
- figmaComponentSet: Info Box # Figma component set name
  figmaNodeId: "179:9324" # Figma node id, for traceability
  status: mapped # mapped | unmapped
  compose:
    component: AppInfoBox # target Compose composable name
    package: com.dexcom.platform.design.component.infobox
  variants:
    - figmaProperty: Style # Figma VARIANT property name
      composeProperty: style # Compose parameter name
      composeEnum: AppInfoBoxStyle # Compose enum type
      values:
        - figmaValue: High Emphasis
          composeValue: HighEmphasis
        - figmaValue: Low Emphasis
          composeValue: LowEmphasis
```

Notes on the shape:

- **`status`** is `mapped` or `unmapped` at both the entry level and the
  individual value level. An entry can be `mapped` overall while still
  having individual variant _values_ marked `unmapped` (e.g. Buttons maps
  to `AppButton`, but its `Elevated Action` Style value does not resolve
  to any `AppButtonType` member).
- **`reason`** is required on every `unmapped` value/entry. It is meant to
  be read by a human (or surfaced verbatim to one) - it explains _why_
  there's no mapping, not just that one is missing.
- **`routing`** (only present on the `Buttons` entry) documents a case
  where a single Figma component set produces _different_ target Compose
  components depending on the value of a non-size/style property (here,
  `Type=Icon Only` routes to `AppIconButton` instead of `AppButton`). This
  is a structural fork, not a variant-to-enum lookup.
- **`mappingKind: state-based`** (on `Switch`, `Checkbox`, `Radio Button`)
  marks components where the Compose side isn't enum-driven at all - it's
  a singleton `Style` object keyed off a boolean state (e.g. `checked`).
  These use `stateMapping` instead of `variants`.
- **`notes`** (entry- or variant-level) flags anything a human should
  double check, independent of `mapped`/`unmapped` status - e.g. the
  Banners entry is fully mapped, but its Compose names diverge from Figma
  enough that a design system owner should double-check the semantic
  pairing.

## What else lives in this package

Besides `component-map.yaml`, this package owns two other pieces of data
the plugin bundles at build time (same build-time-parse pattern, same
"regenerate and commit, never hand-edit the JSON" convention):

- **[`wiring-rules/`](./wiring-rules/README.md)** - declarative rules
  mapping a qualified Figma token `(collection, path)` to a Kotlin
  design-system symbol. Replaced the retired 2371-row
  `token-map/android-*.token-map.json` artifacts; that README documents
  what went wrong with them and why rules beat a materialized table.
- **`collections-policy.yaml`** - which Figma variable collections and
  branches are in scope for the token export. The plugin-side equivalent
  of the platform generator's `configs/collections.toml`, with deliberately
  identical semantics.

Both are regenerated with `npm run generate:wiring-rules` /
`npm run generate:collections-policy`, and CI's `npm run verify:generated`
fails if a generated JSON drifts from its YAML source.

## Lookup is by node id, not display name

`lookupComponentMapEntry` keys on `figmaNodeId` first, falling back to
`figmaComponentSet` (the display name) only when no id matches.

This used to be name-only, while `figmaNodeId` sat in the YAML "for
traceability" and was never read - meaning renaming a component set in
Figma silently unmapped every instance of it, degrading those nodes into
the raw geometry trees this whole project exists to avoid. When an entry
_is_ found by id but its recorded name disagrees with Figma's, the lookup
reports `nameDrift` rather than ignoring it, so the map can be corrected.

## The `unmapped` state

`unmapped` does **not** mean "skip this and move on." An extractor
consuming this file should route anything it resolves to an `unmapped`
entry or value into the IR's `unresolved[]` channel, carrying the
`reason` string along with it, rather than:

- silently guessing at a Compose equivalent,
- dropping the node/property from the IR entirely, or
- falling back to some default value.

This keeps the gap visible all the way through to whatever consumes the
IR (e.g. codegen), instead of it disappearing at extraction time.

## Known gaps as of this file's authoring

These are called out in detail inline, but for a quick human-readable
summary, the current known design-system gaps are:

1. **Buttons** - `Style=Elevated Action` and `Size=XLarge` have no
   `AppButtonType`/`AppButtonSize` equivalent.
2. **Badges** - `Type=Default` has no `AppBadgeType` equivalent, and the
   Figma `X-Small` size vs. Compose `Medium` size don't correspond by
   name; unclear if they're the same size renamed or genuinely different.
3. **Banners** - fully mapped, but Compose enum names (`Success`,
   `Warning`) diverge from Figma names (`Successful`, `Attention`);
   verify semantics with the design system owner.
4. **Tags** - major mismatch; only `Error` and `Warning` are confirmed,
   everything else on both sides is unmapped or a guess. Needs a full
   design-system-owner review. `Size` also has no Compose equivalent.
5. **Checkbox / Radio Button** - no standalone Figma component set exists;
   they only appear embedded inside `Cards`/`Lists`.
6. **Accordions** - Figma component and Compose design tokens both exist,
   but no Compose composable has been built yet.
