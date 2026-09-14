Golden real-world artifact for schema-shape regression testing (backlog
S6/`golden-fixture`).

`daily_42487-22668_c1-790c0e5841aac834.ir.json` is a real `*.ir.json`
export produced by the plugin against an actual production screen — not
a synthetic mock like the fixtures in `../corpus/`. It was captured
before this project added `schemaVersion`/`severity` to the envelope, so
it deliberately does **not** validate as a whole `irDocument` (it has no
`schemaVersion` at all) — see `../__tests__/real-world.test.ts`, which
validates its `nodes[]`/`unresolved[]` entries individually against
`irNode`/`unresolvedEntry` instead of the envelope.

Unlike `../corpus/*` fixtures (which pair a mock Figma node tree
`input.mock.ts` with an `expected.ir.json` the extractor is snapshot-tested
against), there is no way to re-run the real extractor against this file:
only the already-extracted _output_ was captured, not the original Figma
node tree that produced it. So this fixture cannot participate in
`fixtures:update`/the snapshot test — it exists purely to validate that
the schema still accepts the shape of messy, real-world data (deeply
nested trees, hundreds of `unresolved` entries, mixed values, absent
optional fields) that hand-written corpus mocks might not naturally
exercise. If a future schema change breaks validation against this file,
that's a real backward-compatibility signal worth investigating before
loosening or tightening the schema further.
