# codegen/tokens

`@figma-normalizator/codegen-tokens` turns a Token IR document
(`schema/tokens/v1/schema.json`, `*.tokens.json`, produced by
`plugin/src/extractor/tokenExport.ts`'s `extractTokens()`) into Kotlin design
tokens for the Android platform.

It has **no Figma access of its own** — no REST client, no plugin sandbox
dependency. Every alias, mode, exclusion policy, and symbol has already been
resolved by the plugin at export time; this package only reads the resulting
document and emits code. See `../../schema/tokens/MIGRATION.md` for the full
contract this package was built against, and `docs/ARCHITECTURE.md` §6 for
how it fits into the rest of the pipeline. This package replaces the retired
Python generator that fetched from the Figma REST API and resolved its own
alias graph (see git history for `codegen/tokens/_legacy-python/`).

## Pipeline

1. **`src/input/`** — loads and validates a token document (ajv against
   `schema/tokens/v1/schema.json`), checks `mappings/collections-policy.json`
   hasn't drifted (`assertPolicyFresh`), warns about policy patterns that
   matched nothing, and triages `unresolved[]` entries by reason
   (`excluded-by-policy` / `excluded-collection-alias` /
   `missing-alias-target` / `unresolvable-alias-chain` / `unsupported-value`)
   into `silent` / `warn` / `fail`. The default triage **fails** the run on
   any genuinely-unresolvable value rather than silently generating a
   partial/wrong file; override per-reason with `--on-unresolved`.
2. **`src/model/`** — builds a `TokenModel`: expands aliases across every
   mode (`modes.ts`), classifies collections and computes the dependency
   graph without hardcoding collection names (`classify.ts`, `graph.ts`),
   and computes a builder chain / theme modes (`graph.ts`'s
   `computeBuilderChain` / `computeThemeModes`) that the CLI does not use yet
   (see "Possible improvements" below).
3. **`src/emit/`** — the Kotlin emitter: nested `@Immutable data class`es per
   collection, one factory function per mode
   (`primitivesValue()`, `baseLight(primitives)`, `baseDark(primitives)`, …).
   `COLOR/FLOAT/STRING/BOOLEAN` map to
   `androidx.compose.ui.graphics.Color` / `Float` / `String` / `Boolean`.
   A token that is `null` with no alias in every emitted mode (legitimate —
   an unresolvable Figma expression, tagged `unsupported-value`) gets a
   nullable Kotlin type instead of failing generation. Property/class names
   are camelCased/PascalCased per path segment and backtick-escaped when
   they collide with a Kotlin keyword. When a token carries `token.symbol`
   (from `mappings/wiring-rules`), it's surfaced as a KDoc provenance
   comment — never used to derive a name. A `COMPOSE_COLOR` alias whose
   opacity argument is itself a named variable (not a bare number) is
   emitted as a live `base.copy(alpha = opacity._40)` reference rather than
   a baked hex literal (see `docs/BACKLOG.md` G14).

   **v1 emits one file per collection only, by default.** No root class
   aggregates every collection into one app-level tree; wiring
   `primitivesValue()` → `baseLight(primitives)` → … in the right order is
   left to hand-written Android code. This was a deliberate scope
   decision, not an oversight. `--layout legacy` (see below) exists as a
   bridge for consumers still coupled to the old generator's per-branch
   package layout — see `docs/BACKLOG.md` G13 for why, and why it's not
   the default.

4. **`src/cli/`** — the `codegen-tokens` CLI: `--input`, `--output`,
   `--package`, `--prefix`, `--exclude-mode <regex>`,
   `--on-unresolved <reason>=<action>` (repeatable), `--layout <flat|legacy>`,
   `--dry-run`, `--check`, `--help`.

## Running the CLI

Sibling workspace packages resolve via `"main": "src/index.ts"` (TypeScript
source), which a plain `node` cannot load directly — only `tsx` (or
`vitest`) can. During development, run the CLI via:

```bash
npm run cli --workspace=@figma-normalizator/codegen-tokens -- \
  --input path/to/export.tokens.json \
  --output path/to/output/dir \
  --package com.example.tokens \
  --exclude-mode "[iI][oO][sS]" \
  --on-unresolved unsupported-value=warn
```

Add `--check` to fail (without writing) if the output directory is stale, or
`--dry-run` to preview which files would be written.

Add `--layout legacy` to restore the old generator's per-branch/subpackage
file layout (e.g. `<package>.base.color.Color`) instead of the default
one-file-per-collection layout — useful only for a consumer whose existing
hand-written code still references that package shape. Matching the old
generator's file granularity, each data class (`Color.kt`) and each of its
per-mode factory functions (`ColorLight.kt` -> `colorLight(...)`,
`ColorDark.kt` -> `colorDark(...)`) live in their own file, and likewise for
the root aggregator (`Base.kt`, `BaseLight.kt`, `BaseDark.kt`). Factory
functions still take the whole upstream collection as their parameter (e.g.
`colorLight(primitives: Primitives)`), not the narrower per-branch
parameters the old generator used, so migrating a consumer onto this layout
still requires updating those call sites. See `docs/BACKLOG.md` G13.

### Building a standalone bundle

For external consumers that don't want to `npm install` or check out the
whole monorepo (e.g. the DexFigmaPlugin IDE plugin), build a single
dependency-free file with esbuild:

```bash
npm run bundle --workspace=@figma-normalizator/codegen-tokens
```

This writes `codegen/tokens/dist/codegen-tokens.cjs`, which bundles the CLI
together with the `schema` and `mappings` workspace sources (and `ajv`) so
it needs nothing beyond a plain Node.js runtime — no `npm install`, no
workspace resolution, no TypeScript loader. Run it exactly like the CLI,
just via `node` instead of `npm run cli --workspace=...`:

```bash
node codegen/tokens/dist/codegen-tokens.cjs \
  --input path/to/export.tokens.json \
  --output path/to/output/dir \
  --package com.example.tokens
```

`dist/` is gitignored (a build artifact, not source); rebuild the bundle
after pulling changes to this package or its workspace dependencies.

## Golden-output tests

`src/golden.config.ts` lists every golden case (currently `minimal`, a small
hand-authored fixture, and `real-world`, the real production export under
`fixtures/src/real-world/`), each paired with the `KotlinEmitOptions` used to
generate it. `src/__tests__/golden.test.ts` regenerates each case and
compares it byte-for-byte against the frozen `testdata/golden/<case>/`
files.

To freeze new output after a deliberate emitter change, review the diff
before committing:

```bash
npm run golden:update --workspace=@figma-normalizator/codegen-tokens
git diff -- codegen/tokens/testdata/golden
```

CI additionally runs the real CLI (not just the emitter function) against
the `real-world` case in `--check` mode, using the same frozen output as its
target — see `.github/workflows/ci.yml`.

## What's out of scope for v1

- **Swift.** The legacy Python tool had a `SwiftGenerator`; this package
  does not port it. Deferred, see `docs/BACKLOG.md`.
- **A root aggregator.** See "v1 emits one file per collection only" above.
