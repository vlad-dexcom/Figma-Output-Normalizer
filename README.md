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
scripts/    # repo-wide checks (verify-generated.mjs)
```

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
  packages, the Python token generator, and measurements taken against a real
  exported screen.
- [`docs/BACKLOG.md`](./docs/BACKLOG.md) — known gaps, limitations, and
  improvement ideas, grouped by severity.

Both documents are written in Russian, matching the team working on this
repository. Per-package READMEs (`plugin/README.md`, `schema/README.md`,
`mappings/README.md`, `mappings/wiring-rules/README.md`, `fixtures/README.md`)
remain the authoritative reference for each package's own design decisions.

## Status: Stage 1

This repository is being built in stages. **Stage 1 (this stage) covers only
Figma-side extraction**: producing a correct, well-typed IR from a Figma
document. It does _not_ include:

- An MCP server for exposing the IR to external tools/agents.
- Any code generation (e.g. Jetpack Compose).
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
verify:generated, build, and test on every push and pull request — a
commit that changes `schema/ir/v1/schema.json`, `schema/tokens/v1/schema.json`,
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
