# Token IR → generator contract

How the platform's `tools/figma-tokens` pipeline changes when it reads a
Token IR document (`schema/tokens/v1/schema.json`) instead of a raw Figma
variables dump.

This document is the **contract**, not the migration itself: the generator
lives in another repository.

## The shape of the change

Before:

```
Figma ──dump──► figma-raw.json ──Python: resolve + normalize + shape──► tokens.json ──► Kotlin
                (1.9 MB, semantics-free)
```

After:

```
Figma ──plugin: resolve + normalize──► tokens.ir.json ──Python: shape──► Kotlin
        (aliases, modes, scopes, policy)                 (codegen only)
```

The generator stops doing **resolution** and keeps doing **codegen**. It
gets smaller, and the parts it loses are the parts that were losing data.

## What the generator no longer has to do

| Was doing                          | Now provided by                       | Why it moved                                                                                                                                                                                |
| ---------------------------------- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Walking the `VARIABLE_ALIAS` graph | `token.value` / `token.modes`         | The dump could not resolve its own graph: 71% of mode values were aliases and 327 alias targets were dangling. `getVariableByIdAsync` resolves imported library variables; the dump cannot. |
| Mapping mode ids to names          | `collection.modes`                    | Names only exist plugin-side.                                                                                                                                                               |
| Guessing the primary mode          | `collection.defaultMode`              | Was lost entirely, forcing `builders.theme_modes` to hardcode it.                                                                                                                           |
| Filtering collections/branches     | `policy` + pre-filtered `collections` | Same `collections.toml` semantics, applied before resolution.                                                                                                                               |
| Deciding what to skip silently     | `unresolved[]`                        | Three variables vanished with no warning. Now impossible by construction.                                                                                                                   |

## Field mapping

| `tokens.json` (old)                                                            | Token IR                                                      | Notes                                                                                                                                                                                  |
| ------------------------------------------------------------------------------ | ------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `schema_version`                                                               | `envelope.schemaVersion`                                      |                                                                                                                                                                                        |
| `figma_file_key`                                                               | `envelope.fileKey`                                            |                                                                                                                                                                                        |
| —                                                                              | `envelope.version`                                            | New: content hash. Lets the generator detect "nothing changed" and skip work, and lets CI detect drift.                                                                                |
| `collections.<name>` (object, name-keyed)                                      | `collections[]` (array)                                       | An **array**, deliberately: collection _names_ are not unique across imported libraries (one real file had five `Primitives`, six `Mode`, five `base`). Key by `id` if you need a map. |
| `collections.<name>.modes`                                                     | `collection.modes`                                            | Now in Figma's **declared order**, not alphabetized.                                                                                                                                   |
| —                                                                              | `collection.defaultMode`                                      | New.                                                                                                                                                                                   |
| `collections.<name>.branches`                                                  | `collection.branches`                                         | In first-seen order.                                                                                                                                                                   |
| `collections.<name>.tokens[].path`                                             | `token.path`                                                  | Identical string; no reconciliation needed.                                                                                                                                            |
| `tokens[].type`                                                                | `token.type`                                                  |                                                                                                                                                                                        |
| `tokens[].values.<mode>` (`{type,r,g,b,a}`)                                    | `token.modes.<mode>` (hex string)                             | Colors are now `#RRGGBB(AA)`, matching the node IR so both documents agree on one variable's value.                                                                                    |
| —                                                                              | `token.value`                                                 | New: the default-mode literal, so single-value consumers don't have to pick a mode themselves.                                                                                         |
| `tokens[].alias_path`, `alias_by_mode`, `alias_source`, `alias_source_by_mode` | `token.alias.byMode.<mode>` = `{collection, path, excluded?}` | Four parallel, partially-redundant fields collapse into one per-mode edge.                                                                                                             |
| `tokens[].description`                                                         | `token.description`                                           |                                                                                                                                                                                        |
| —                                                                              | `token.scopes`                                                | New. Was discarded: 0 occurrences in `tokens.json`. This is how you know a FLOAT is a radius and not a gap.                                                                            |
| —                                                                              | `token.hidden`, `token.deleted`                               | New. Flagged instead of silently dropped.                                                                                                                                              |
| —                                                                              | `token.symbol`, `token.symbolFrom`                            | New. Derived from wiring rules, with the deciding rule recorded.                                                                                                                       |
| —                                                                              | `token.hints.codeSyntax`                                      | New. **Hint only** — see below.                                                                                                                                                        |
| `collections.<name>.token_tree`                                                | _(dropped)_                                                   | A second serialization of the same `tokens[]` list, strictly less informative. Build it locally if a tree shape is convenient.                                                         |

## What stays in the generator

These are codegen decisions, not Figma facts, and Token IR deliberately does
not model them:

- `root_class`, `package`, `folder`, `shared_factory`, `factory_fn_prefix`
- `graph`, `builders`, `theme_modes`, `dep_edges`, `leaves`,
  `product_groups`, `branch_owners`
- `role` (`semantic` / `leaf` / `primitive`)

Token IR _does_ carry the observed raw material these derive from —
`collection.dependsOn` (observed alias edges), `collection.branches`,
`collection.modes`, `collection.defaultMode` — because those are measured
Figma structure rather than a target-language choice.

Note that `dependsOn` **excludes** collections the policy dropped. A
dependency on a collection that was never emitted would be a dangling
reference, which is the same contract `collections.toml` already states as
"generated code never references a class that was not produced". The alias
edge itself is still present on the token, flagged `excluded: true`.

## Behaviours to preserve

- **Alias into an excluded collection falls back to the literal.** Already
  the documented behaviour; Token IR keeps it _and_ records it, both as
  `alias.byMode.<mode>.excluded` and as an `excluded-collection-alias`
  entry in `unresolved[]`.
- **`figma-only` stays excluded** by default, via
  `mappings/collections-policy.yaml`.
- **Patterns that match nothing are reported**, now in
  `policy.unmatchedPatterns` inside the artifact itself.

## Behaviours to change

- **Stop reading `values` for leaf collections as if they were complete.**
  A `components` token has one mode (`value`) but aliases into `base`
  (light/dark), so its literal is silently one of the two. Expand modes
  through `alias.byMode` instead. This is what `graph`/`builders` were
  reconstructing.
- **Handle `unresolved[]`.** It is not advisory. A token appearing there
  either has a `null` value or resolved through a fallback, and the
  generator should decide deliberately — skip, fail, or emit with a comment
  — rather than inheriting the old silent-drop behaviour.
- **Do not use `hints.codeSyntax` to name anything generated.** It is
  carried for humans and coding agents. The platform is moving to a Styles
  API which will supply real symbols; if codegen started depending on
  `codeSyntax` those two would silently diverge.

## Open item before migrating

The retired `token-map` artifact disagreed with a later export of the same
file on 111 colour values, **7 of them exact light/dark inversions** (e.g.
`apple/color/systemBlack` stored as `light: #FFFFFF, dark: #000000` where
the file says the opposite).

This is not yet root-caused. One plausible mechanism is alphabetically
sorted mode _names_ being zipped against declared-order mode _values_ — the
old artifact did alphabetize modes. If that is real, the current generator
has been silently inverting colours in generated Kotlin, and the bug would
be carried into the migration along with the data. **Settle this before
migrating**, not after.
