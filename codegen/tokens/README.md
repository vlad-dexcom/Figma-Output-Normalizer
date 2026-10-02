# codegen/tokens

`@figma-exporter/codegen-tokens` turns a Token IR document
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
   a baked hex literal (see `docs/BACKLOG.md` G14). Opacity variables are
   rescaled on the way out: Figma stores them the way its UI shows them
   (`opacity/40` = the number 40), while every Compose alpha is 0-1, so an
   opacity-scoped `FLOAT` is emitted as `0.4f` — once, at the leaf holding
   the literal, so `.copy(alpha = …)` references need no arithmetic (see
   `docs/BACKLOG.md` G15).

   **Sub-collections (Figma extended collections) reuse their parent's
   type.** A theme like `stelo` extending `base` gets no class of its own:
   `Stelo.kt` holds only `steloLight(primitives): Base`, `steloDark(…)`, …,
   constructing `Base` from stelo's own values. Anything typed `Base`
   (e.g. `componentsValue(base: Base, …)`) therefore accepts a stelo theme
   as-is. The link comes from the exporter's `collection.extends` (Figma's
   own extension link); exports that predate that field fall back to
   structural detection (identical paths, types and modes, exactly one
   candidate), noted on stderr. A recorded link whose token sets differ, or
   a sub-collection value that is missing where the parent's property is
   non-nullable, fails generation instead of producing Kotlin that
   wouldn't compile. `--layout legacy` does the same: stelo's factory
   files live under `<pkg>.stelo…` and return `<pkg>.base…` classes.

   **v1 emits one file per collection only, by default.** No root class
   aggregates every collection into one app-level tree; wiring
   `primitivesValue()` → `baseLight(primitives)` → … in the right order is
   left to hand-written Android code. This was a deliberate scope
   decision, not an oversight. `--layout legacy` (see below) exists as a
   bridge for consumers still coupled to the old generator's per-branch
   package layout — see `docs/BACKLOG.md` G13 for why, and why it's not
   the default.

4. **`src/cli/`** — the `codegen-tokens` CLI: `--input`, `--output`,
   `--package`, `--prefix`, `--exclude-mode <regex>` (repeatable, and
   comma-separated within one occurrence),
   `--on-unresolved <reason>=<action>` (repeatable),
   `--fallback-collection <child>=<parent>` (repeatable),
   `--layout <flat|legacy>`, `--dry-run`, `--check`, `--help`.
   `--exclude-mode` is always matched case-insensitively — a mode name is
   free-form text a designer typed into Figma, and the same semantic mode
   shows up with different casing per collection (the real export declares
   `iOS` on `primitives` and `ios` on `typography`), so `--exclude-mode ios`
   excludes both. Excluding more than one mode needs neither a hand-built
   regex alternation nor a second flag name: `--exclude-mode ios,tvos` and
   `--exclude-mode ios --exclude-mode tvos` both work, and can be mixed --
   every pattern from every occurrence is OR'd into one combined regex.

   `--fallback-collection` handles a collection deliberately laid out as a
   1:1 override of another one (same paths, same modes) where a designer
   only sets the tokens they actually want to diverge on and leaves the
   rest unbound in Figma entirely — not an alias the exporter can resolve,
   since there is no edge to follow, just an empty value. **This is
   detected automatically, by structure, with no flag needed**: a
   collection with a `null`, non-aliased mode value is matched against
   every other collection with the same mode names (compared
   case-insensitively) that actually has a value at the same path/mode. A
   single matching candidate is applied on its own — any `null` values it
   resolves are filled in, and the corresponding `unsupported-value`
   (sparse mode coverage) `unresolved[]` entries are dropped, since those
   values are no longer unresolved. More than one matching candidate is
   reported (on stderr) as ambiguous and left alone rather than guessed at;
   pass `--fallback-collection <child>=<parent>` to disambiguate (it also
   overrides an auto-detected match for that child).

   When the parent's value for a filled mode is itself a live alias (e.g.
   `base`'s color aliasing into `primitives`), the alias edge is copied
   too, not just its resolved literal — the child ends up with the same
   live reference the parent has, instead of a baked hex string that only
   looks that way because of how the gap happened to get filled. The
   child collection's `dependsOn` gains whatever collection(s) those
   copied aliases point into (an alias into a policy-excluded collection
   keeps its literal fallback, same as the parent, and is not added to
   `dependsOn`, since that target isn't in the document at all).

## Running the CLI

Sibling workspace packages resolve via `"main": "src/index.ts"` (TypeScript
source), which a plain `node` cannot load directly — only `tsx` (or
`vitest`) can. During development, run the CLI via:

```bash
npm run cli --workspace=@figma-exporter/codegen-tokens -- \
  --input path/to/export.tokens.json \
  --output path/to/output/dir \
  --package com.example.tokens \
  --exclude-mode "ios" \
  --on-unresolved unsupported-value=warn \
  --fallback-collection stelo=base
```

Add `--check` to fail (without writing) if the output directory is stale, or
`--dry-run` to preview which files would be written.

The output directory is kept in sync, not just written to: a file this
generator previously produced but no longer does — a collection or branch
renamed or deleted in Figma, a mode `--exclude-mode` now filters out, or the
whole previous `--layout` — is deleted, and `--check` fails on it. Only files
carrying the emitter's own "DO NOT MODIFY" banner are ever removed, so
pointing `--output` at a directory that also holds hand-written Kotlin is
safe.

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

For consumers that need file-based generation without workspace resolution
or a TypeScript loader at runtime, build a single
dependency-free file with esbuild:

```bash
npm run bundle --workspace=@figma-exporter/codegen-tokens
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

For live generation from Figma, use [`bridge/`](../../bridge/README.md)
instead. The integrated [Android Studio plugin](../../android_studio_plugin/README.md)
builds `@figma-exporter/bridge` into `bridge/dist/tokens-sync.cjs`, which
includes this generator plus WebSocket and `serve` support. The standalone
codegen bundle above only reads an existing token document; it is not the
bundle used by the IDE's **Build Generator** button.

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
npm run golden:update --workspace=@figma-exporter/codegen-tokens
git diff -- codegen/tokens/testdata/golden
```

CI additionally runs the real CLI (not just the emitter function) against
the `real-world` case in `--check` mode, using the same frozen output as its
target — see `.github/workflows/ci.yml`.

## What's out of scope for v1

- **Swift.** The legacy Python tool had a `SwiftGenerator`; this package
  does not port it. Deferred, see `docs/BACKLOG.md`.
- **A root aggregator.** See "v1 emits one file per collection only" above.
