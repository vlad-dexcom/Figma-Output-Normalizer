# @figma-normalizator/codegen-tokens

Kotlin design-token code generator. Reads a `*.tokens.json` document
(`schema/tokens/v1/schema.json`, produced by `plugin/`'s token export) and
emits Kotlin source. It has **no Figma access of its own** — no REST client,
no API token, no network calls — by design: every fact this package needs
(resolved alias chains, real mode names and order, variable scopes, the
exclusion policy actually applied) is already resolved on the Figma side,
where that information exists. See `schema/tokens/MIGRATION.md` for the full
contract this package implements against, and `docs/ARCHITECTURE.md` for how
it fits into the rest of the pipeline.

This package replaces `_legacy-python/` (the retired Python generator that
fetched from the Figma REST API and resolved its own alias graph). That
directory is kept temporarily as a read-only reference while the port is in
progress — see its README for the deletion condition.

## Status

Under construction. This README will grow a Quick Start / CLI reference /
architecture section as the corresponding pipeline stages (input validation,
codegen model, Kotlin emitter, CLI) land. Until then, treat this package as
scaffolding only.

## Package layout (target shape)

```
src/
  cli.ts               # thin orchestration — no Figma flags, only IR input
  config.ts            # config + validation
  input/                # facts about Figma: schema, policy, unresolved[]
    load.ts             #   read + ajv-validate a *.tokens.json against tokens/v1
    guards.ts           #   envelope.kind/schemaVersion checks
    unresolved.ts        #   per-reason-code handling of unresolved[]
  model/                # codegen decisions: roles, packages, builders
    types.ts             #   TokenModel
    build.ts              #   TokenDocument -> TokenModel (collections keyed by id)
    modes.ts              #   expand modes through alias.byMode
    classify.ts           #   structural collection classification (ported)
    graph.ts               #   dependency graph + builder ordering (ported)
  emit/
    naming.ts             #   casing/escaping helpers (ported)
    kotlin.ts              #   Kotlin emitter (ported)
    writer.ts               #   deterministic file writing + --check
testdata/
  minimal.tokens.json      # small handwritten input
  golden/kotlin/            # frozen expected output
```

`input/` and `model/` are deliberately separate: `input/` is about facts
Figma recorded (schema, policy, unresolved reasons), `model/` is about
codegen decisions (roles, packages, builder chains) that Token IR
intentionally does not model. See `schema/tokens/MIGRATION.md` → "What stays
in the generator" for that boundary in the source document.
