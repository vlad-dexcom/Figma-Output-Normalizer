# mappings/wiring-rules

Declarative rules mapping a **qualified** Figma design token —
`(collection, path)`, e.g. `base` + `color/surface/action/primary/default` —
to the Kotlin call-site symbol a coding agent should write, e.g.
`AppTheme.semanticColors.surface.action.primary.default`.

The rules live in [`wiring-rules.yaml`](./wiring-rules.yaml) and are
evaluated by `mappings/src/wiring.ts`'s `resolveTokenSymbol`. Following this
repo's `unmapped`/`reason` convention (see `mappings/README.md`), resolution
**never guesses**: when no rule confidently derives a symbol it returns
`symbol: null` plus a `reason`, and the exported artifacts simply omit the
field.

## Why this replaced the token-map

This directory used to hold `android-stelo.token-map.json` and
`android-avalon.token-map.json`: two checked-in artifacts of **2371 rows
each**, generated from a downstream `tokens.json` snapshot, trimmed to 246
rows and bundled into the plugin.

Three problems, all measured rather than suspected.

### 1. It was a 2371-row materialized view of one rule

Of 2371 rows, **246 had a symbol** — and all 246 came from a _single_
derivation rule (`base` + `color/*`, see below). The other **2125 rows were
`symbol: null` plus a paragraph of English prose** explaining why there was
no rule.

That is a materialized view of a pure function, checked into git. It also
threw away the question while storing the answer: nothing recorded _which_
rule produced a given symbol, so no symbol could be re-derived or validated.
Evaluating the rule instead is always current, cannot go stale, and records
`symbolFrom` so any emitted symbol traces back to the rule — and the
evidence — behind it.

### 2. It silently went stale, and nothing noticed

Audited against a later export of the **same** Figma file
(`gPHx1sqQHIfMs8706VDGM1` on both sides):

| Measurement                                                      | Result                                               |
| ---------------------------------------------------------------- | ---------------------------------------------------- |
| Rows whose token path no longer existed                          | **514** (`base` 82, `primitives` 108, `stelo` 324)   |
| Of the 246 **bundled** symbol rows, paths that no longer existed | **81 (33%)**                                         |
| Live tokens with no row at all                                   | **112** (`base` 91, `primitives` 18, `components` 3) |
| COLOR rows whose values disagreed with the file                  | **111**                                              |
| Of those, exact light/dark inversions                            | **7**                                                |

A third of the plugin's shipped symbol table pointed at tokens that did not
exist. Nothing in CI, the type system, or the test suite noticed, because
nothing was checking. `npm run verify:generated` (wired into CI, see
`scripts/verify-generated.mjs`) is the direct answer to that.

The 324 `stelo` rows illustrate the failure nicely: that collection was
deliberately deleted from Figma. The artifact kept shipping it anyway.

The 7 light/dark inversions (e.g. `apple/color/systemBlack` stored as
`light: #FFFFFF, dark: #000000` where the file says the opposite) are **not
yet root-caused** — they are either a downstream resolver bug or a real
design change, and should be settled before anyone trusts that generator's
colour output. One plausible mechanism: the downstream artifact sorted mode
_names_ alphabetically (`[light, dark]` became `["dark","light"]`) while
values kept their declared order.

### 3. Identity was ambiguous, and provably so

The bundled index was built as:

```ts
new Map(tokenMap.map((entry) => [entry.path, entry.symbol])); // path only!
```

Meanwhile `base` and `stelo` shared **324 of 324 paths** — _every_ one of
the 246 bundled symbol paths was owned by more than one collection. Nothing
broke only because the two collections happened to hold identical values at
that moment, which is precisely what a product-theme collection exists to
stop doing.

Lookup is now `(collection, path)`, and both IRs carry the collection
alongside the path so callers can always supply it. An unknown collection
(`null`) matches only rules with no collection constraint — deliberately
conservative, so a token whose collection could not be read never inherits
`base`'s rule.

## The rules today

### `base-color` — the one confirmed 1:1 wiring

`base` collection, path starting `color/` →
`AppTheme.semanticColors.` + the remaining path segments, camelCased per
segment.

Evidence actually read, not assumed: `themedata/DsThemeColors.kt` declares

```kotlin
typealias SemanticColors = com.dexcom.platform.design.foundation.token.base.color.Color
```

— a direct, un-renamed, un-restructured alias of the generated `Base.Color`
class — and `AppTheme.kt`'s `semanticColors` property returns exactly that
type. The generated `Color.kt`'s nested classes match the Figma path segment
for segment (`Surface` → `Action` → `Primary` → `default` for
`color/surface/action/primary/default`).

Segment camelCasing (`toCamelCaseSegment`) is a port of the platform's own
`to_camel_case` from `codegen/base.py`, so derived symbols are byte
identical to what the retired table contained: `border-width` →
`borderWidth`, `4-color` → `_4Color` (leading digits are not valid Kotlin
identifiers).

### `base-other-branches` — deliberately unmapped

`base`'s other branches (`border-width`, `effect`, `opacity`, `radius`,
`scale`, `apple`) are **not** mechanically derivable. `AppTheme.opacity`
(`AppOpacity`), `AppTheme.shapes` (`AppShapes`) and `AppTheme.dimensions`
(`AppDimensions`) are hand-authored `data class`es in `themedata/` with
their own field names (`AppShapes.radius40`, `AppDimensions.extraSmall`, …)
and hardcoded literal `Dp`/`Float` defaults — not typealiases, not generated
from `Base`, and not a 1:1 rename of any `Base.*` path. Their values are
wired at theme-setup time, not by a mechanical path transform. Guessing here
would very likely be wrong.

### `other-collections` — the catch-all

`components`, `layout`, `primitives`, `typography` and any product
collection are not investigated for Kotlin wiring; color was the explicit
priority.

Note that **every** one of the 1323 `components` variables carries a
Figma-side `codeSyntax.ANDROID` value (e.g.
`bannersTypeInformativeColorSurface`), and 412 carry `WEB`. The Token IR
carries these under `hints.codeSyntax`, but they are deliberately **not** a
symbol source: the platform is moving to a Styles API that will supply the
real symbols, at which point these names could diverge. They are labelled
`hints` precisely so a consumer cannot mistake them for a contract — useful
grounding for a human or a coding agent choosing a name, never something the
pipeline resolves against.

## Path format: no reconciliation needed

A `TokenValue.token` / `TokenRef.token` string (node IR), a Token IR
`token.path`, and a `wiring-rules.yaml` `pathPrefix` are all the **same**
raw, unsanitized Figma variable name. Both extractors read `variable.name`
straight off the Figma API with no transformation, so paths like
`primitives/palette/neutral/black 5%` (literal space, literal `%`) and
`base/apple/color/systemBlue` (already mixed-case) appear verbatim.

Sanitization is real, but happens one level later, inside Kotlin codegen,
and only per _segment_. This directory reimplements that segment-level
function only where it is needed to build a symbol; `path` itself is never
touched.

## Adding a rule

1. Add it to `wiring-rules.yaml`, **above** the catch-all. Rules are
   evaluated in file order and the first match wins.
2. A `status: mapped` rule must carry `evidence` — the source file you
   actually read. A `status: unmapped` rule must carry `reason`.
   `mappings/src/wiring.test.ts` enforces both.
3. Run `npm run generate:wiring-rules` from `mappings/` and commit the
   regenerated `src/generated/wiring-rules.json`. CI's
   `npm run verify:generated` fails if you forget.

## What a human should double-check

- Whether `AppTheme.opacity`/`shapes`/`dimensions` should get hand-authored
  rules (they are not mechanically derivable — see above). That is a
  design-system-owner decision, not something a script should guess at.
- Whether the Styles API work supersedes this layer entirely. If the
  platform publishes symbols itself, `base-color` may become the last rule
  this file ever needs.
