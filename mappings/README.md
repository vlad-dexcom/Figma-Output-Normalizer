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

## Component set name lookup

`findComponentMapEntry` (`src/index.ts`) matches a Figma component set name
against `entries[].figmaComponentSet` exactly first. If that fails, it
retries with both sides normalized (trimmed, whitespace-collapsed,
lowercased, and a single trailing "s" stripped for naive singular/plural
folding) — this only tolerates case/whitespace/plural drift between the
Figma file and this YAML (both typed independently by humans and prone to
drift, e.g. `Badge` vs. `Badges`), never fuzzy/substring matching. A
genuinely absent component set (e.g. `Section Header`, `Container` — real
components used on real screens with no entry here at all) still resolves
to `null` either way; adding those requires a human with access to the
target design system to author the `compose`/`variants`/`routing` blocks,
not something this lookup can paper over.

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
7. **Missing entries entirely** - real screens use component sets this
   file has no entry for at all (confirmed on a real export: `Section
Header`, `Container`, `Segmented Controls`, `Slider`, `Tab Bars`,
   `Insights Card`, `🔒 Assets / *`). This isn't a lookup bug (see
   "Component set name lookup" above) — these component sets need their
   own entries authored by someone with access to the target design
   system, same as any other gap in this list.
