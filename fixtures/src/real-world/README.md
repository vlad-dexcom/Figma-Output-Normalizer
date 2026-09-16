Golden real-world artifacts for schema-shape regression testing (backlog
S6/`golden-fixture`).

Both files here are **real plugin exports taken from production Figma
files**, not synthetic mocks like the fixtures in `../corpus/`. They exist
to prove the schemas still accept messy real data — deeply nested trees,
hundreds of `unresolved` entries, mixed values, absent optional fields —
that hand-written corpus mocks do not naturally exercise. If a future
schema change breaks validation against one of these, that is a real
backward-compatibility signal worth investigating before loosening or
tightening the schema further.

Neither file can participate in `fixtures:update`/the snapshot test: only
the already-extracted _output_ was captured, never the original Figma
document that produced it, so there is no way to re-run the extractor
against them.

This directory is listed in `.prettierignore`. The plugin serializes
canonically and content-hashes the result into the envelope, so these
files are kept byte-for-byte as the plugin wrote them; reformatting would
make a committed artifact stop being the thing it claims to be.

## `daily_42487-22668_c1-790c0e5841aac834.ir.json` — node IR

A real `*.ir.json` export of a production screen (245 KB, 134 nodes, 361
`unresolved` entries).

Captured **before** this project added `schemaVersion`/`severity` to the
envelope, so it deliberately does **not** validate as a whole
`irDocument` — it has no `schemaVersion` at all. See
`../__tests__/real-world.test.ts`, which validates its
`nodes[]`/`unresolved[]` entries individually against
`irNode`/`unresolvedEntry` instead of the envelope.

Note that this file already carries a trailing newline the plugin did not
write, from before the `.prettierignore` entry above existed. It is
therefore no longer byte-identical to the plugin's output, and must not be
used to test byte-level export determinism.

## `gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json` — token IR

A real `*.tokens.json` export (1.4 MB), captured 2026-09-16 as the
reference input for migrating the token generator off the Figma REST API
and onto Token IR (see `schema/tokens/MIGRATION.md`).

Captured after the envelope stabilized, so unlike the IR fixture it
validates as a whole `tokenDocument` — see
`../__tests__/real-world-tokens.test.ts`.

This supersedes an earlier capture (`..._c1-88d0431a4019ec4b.tokens.json`,
2026-09-15, still recoverable from git history) of the same production
file, re-exported once the plugin picked up the `COMPOSE_COLOR`
alias-typed-opacity fix (BACKLOG G14): the earlier capture's 168
`unsupported-value` entries were all instances of that bug and are gone
from this one.

|                    |                                                              |
| ------------------ | ------------------------------------------------------------ |
| `envelope.version` | `c1-4228e256df698463`                                        |
| Collections        | 5 (`primitives`, `components`, `base`, `typography`, `layout`) |
| Tokens             | 2030                                                         |
| `unresolved`       | 22 (`excluded-collection-alias` 22)                           |

It is the reference input for the new generator specifically because it is
awkward in ways a mock would not be:

- `layout` has **zero** tokens, exercising "empty collection survives as
  empty" rather than silently disappearing.
- `components` is single-mode (`value`) but aliases into `base`
  (light/dark), which is the case that makes reading its flattened literal
  actively wrong — the mode expansion the new generator has to perform.
- 22 alias edges point into the excluded `figma-only` collection and fall
  back to literals, flagged `excluded`.
- `base`/`typography`/`primitives` all declare modes in a non-alphabetical
  order (`light,dark` / `ios,android` / `Value,iOS,Android`) whose first
  element is the default — the signal the previous generator destroyed by
  sorting.

**Not in this file, deliberately:** the `stelo` collection. It was a local
collection of 281 variables in the earlier REST dump, and the previous
generator built a second product flavor from it. It was since deleted from
the Figma file on purpose, so its absence here is correct and not data
loss. It is called out because the export itself gives no way to tell those
two apart — see the collection-level reporting gap noted in
`docs/BACKLOG.md`.
