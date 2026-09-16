# Figma-Normalizator

A Figma plugin + intermediate representation (IR) schema that extracts a
**semantic, platform-neutral** description of a Figma design, for use in
design-to-code pipelines.

## Why this exists

Figma's REST API returns a geometry-first, semantics-free document:

- Absolute coordinates, vector geometry, and low-level Auto Layout enums are
  dumped instead of the layout _intent_ they encode.
- Component instances are inlined as full rendered subtrees (every rectangle,
  text run, and override) instead of something like
  `AppButton, type=Primary`.
- Colors and spacing arrive as literal values with opaque variable ids,
  instead of resolved token names.
- There is no theme/mode information (light/dark, density, etc.).

The Figma **Plugin API**, running inside Figma itself, can see what the REST
API cannot: resolved component properties, styled text segments, and
variable modes. This project resolves all of the above on the Figma side —
where the information actually lives — and emits a clean, versioned IR that a
separate code-generation stage can consume without needing to understand
Figma's internal document model at all.

## Layout

```
docs/       # architecture walkthrough + known-gaps backlog
schema/     # versioned JSON Schemas, generated TS types, fixtures
            #   ir/v1      - the node IR (a selection of the scene graph)
            #   tokens/v1  - the token document (the file's design tokens)
plugin/     # the Figma plugin (TypeScript) that walks the scene graph and
            # the variable collections, and emits both documents
mappings/   # Figma component set -> design system component map,
            # token -> Kotlin symbol wiring rules, and the token export's
            # collection/branch exclusion policy
fixtures/   # captured real-screen node data + expected IR snapshots, used
            # in tests
codegen/tokens/  # TypeScript generator that turns a *.tokens.json document
            # into Kotlin data classes + factory functions (CLI: codegen-tokens)
scripts/    # repo-wide checks (verify-generated.mjs)
```

## How to use

End-to-end, from a Figma file to generated Kotlin:

1. **Build and install the plugin.**
   ```bash
   npm install
   npm run build --workspace=plugin
   ```
   In Figma desktop: **Plugins → Development → Import plugin from manifest…**,
   pick `plugin/manifest.json`. See `plugin/README.md` for details.

2. **Export the file's design tokens.** Open the plugin
   (**Plugins → Development → Figma Normalizator**) and use the token row's
   **Extract tokens** / **Export tokens** buttons (unrelated to the current
   canvas selection — tokens are file-scoped, not selection-scoped). This
   downloads `{fileKey}_{version}.tokens.json`. See "Token export
   (file-scoped)" in `plugin/README.md` for what's in scope and why it runs
   in the plugin rather than downstream.

3. **Generate Kotlin from the exported document.**
   ```bash
   npm run cli --workspace=@figma-normalizator/codegen-tokens -- \
     --input path/to/{fileKey}_{version}.tokens.json \
     --output path/to/output/dir \
     --package com.example.tokens
   ```
   This writes one `.kt` file per collection (`Primitives.kt`, `Base.kt`,
   …), each with a nested data class and one factory function per mode. Add
   `--layout legacy` if the consuming app still expects the old
   per-branch/subpackage layout (see `codegen/tokens/README.md`), or
   `--dry-run`/`--check` to preview or validate without writing. Run
   `npm run cli --workspace=@figma-normalizator/codegen-tokens -- --help`
   for the full flag list.

   External consumers that don't want to `npm install`/check out the whole
   monorepo (e.g. an IDE plugin) can instead build a standalone, dependency-
   free bundle once with `npm run bundle --workspace=@figma-normalizator/codegen-tokens`
   and invoke `node codegen/tokens/dist/codegen-tokens.cjs <same flags>` —
   see "Building a standalone bundle" in `codegen/tokens/README.md`.

4. **Wire the generated data classes into the app.** v1 emits one file per
   collection only — there is no root aggregator by default (see "Status:
   Stage 1" below) — so calling `primitivesValue()` → `baseLight(primitives)`
   → … in the right order, and re-running step 3 whenever the token export
   changes, is left to hand-written app code.

Selection-scoped node IR (for design-to-code beyond tokens) is exported the
same way via the panel's **Extract** / **Export** buttons — see "Using the
panel" in `plugin/README.md` — but has no consuming code generator yet (see
"Status: Stage 1" below).

## Two documents, split by cadence

The plugin emits two artifacts, and the split between them is **cadence**,
not subject matter:

|         | `*.ir.json`           | `*.tokens.json`            |
| ------- | --------------------- | -------------------------- |
| Scope   | the current selection | the whole file's variables |
| Changes | constantly            | rarely                     |
| Schema  | `schema/ir/v1`        | `schema/tokens/v1`         |

Both share the same doctrine: semantics resolved on the Figma side,
deterministic canonical serialization, a content-hash version, and an
explicit `unresolved[]` channel instead of silent drops.

The token document exists because the alternative — dumping raw variables
and normalizing them downstream — measurably loses data. On a real
production file that path silently dropped three variables, could not
resolve 327 dangling alias targets, discarded every variable's `scopes`,
alphabetized mode names (destroying the default-mode signal), and flattened
leaf-collection values in a way that collapsed light/dark. See
`schema/tokens/MIGRATION.md` for the full field-by-field contract.

This is an npm workspaces monorepo. Each package has its own
`package.json` and extends the shared root `tsconfig.json`.

## Documentation

- [`docs/ARCHITECTURE.md`](./docs/ARCHITECTURE.md) — step-by-step walkthrough
  of the whole pipeline: the export lifecycle inside the plugin, layout/token/
  instance/list/overlay/asset resolution, the IR v1 schema, the mappings
  packages, the `codegen/tokens` Kotlin generator, and measurements taken
  against a real exported screen.
- [`docs/BACKLOG.md`](./docs/BACKLOG.md) — known gaps, limitations, and
  improvement ideas, grouped by severity.

Both documents are written in Russian, matching the team working on this
repository. Per-package READMEs (`plugin/README.md`, `schema/README.md`,
`mappings/README.md`, `mappings/wiring-rules/README.md`, `fixtures/README.md`,
`codegen/tokens/README.md`) remain the authoritative reference for each
package's own design decisions.

## Status: Stage 1

This repository is being built in stages. **Stage 1 (this stage) covers
Figma-side extraction** (a correct, well-typed IR + token document from a
Figma document) **plus the Kotlin token generator** (`codegen/tokens`, turns
the token document into Kotlin data classes). It does _not_ include:

- An MCP server for exposing the IR to external tools/agents.
- Code generation for the node IR (e.g. Jetpack Compose screens/components).
- A Swift token generator (deferred; see `docs/BACKLOG.md`).
- Any LLM assistance inside the plugin itself.

Those are later stages, built on top of the IR produced here.

## Development

```bash
npm install               # install all workspace dependencies
npm run lint              # ESLint across all packages
npm run typecheck         # tsc --noEmit in every package
npm run verify:generated  # regenerate + fail if anything below doesn't match what's committed
npm test                  # vitest, run once
npm run generate          # regenerate schema types, component-map, wiring-rules, collections-policy, and golden fixtures
```

CI (`.github/workflows/ci.yml`) runs install, lint, typecheck,
verify:generated, build, test, verify:generated again, and a
`codegen-tokens --check` smoke test (the CLI regenerating Kotlin for the
real-world fixture and comparing it to `codegen/tokens/testdata/golden/real-world/`)
on every push and pull request — a commit that changes
`schema/ir/v1/schema.json`, `schema/tokens/v1/schema.json`,
`mappings/component-map.yaml`, `mappings/wiring-rules/wiring-rules.yaml`,
`mappings/collections-policy.yaml`, or extractor behavior without also
regenerating and committing the derived artifacts (`schema/src/generated/ir.ts`,
`schema/src/generated/tokens.ts`, `mappings/src/generated/*.json`,
`fixtures/src/corpus/*/expected.ir.json`) fails CI instead of silently
drifting.

`verify:generated` exists because of a measured failure, not a hypothetical
one: a checked-in generated artifact was bundled into the plugin and then
silently decayed until a third of it referenced tokens that no longer
existed. Generated files are committed for reproducibility; this gate is
what keeps "committed" from meaning "stale".
