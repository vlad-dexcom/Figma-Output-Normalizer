# Fixture corpus

This package captures a corpus of realistic-screen-shaped Figma node trees
and their expected IR output, used to catch any unintended change to
`plugin/src/extractor/` behavior. Since no live Figma file/API access exists
in CI, every "screen" here is a constructed mock node tree, built with the
same `mockFrame`/`mockInstance`/`mockText`/... helpers
(`plugin/src/test/nodeBuilders.ts`) already used by the extractor's own unit
tests — not a capture from a real Figma document.

`schema/fixtures/*.json` holds the two original hand-written worked examples
(`button-instance`, `container-with-text`). This corpus is deliberately
broader and more realistic: each scenario combines several extractor
features at once, the way an actual screen would, rather than isolating one
feature per fixture.

## Layout

Each scenario lives in `src/corpus/<scenario-name>/`:

- `input.mock.ts` — exports a `FixtureScenario` (see `src/scenario.ts`): the
  mock node tree plus `fileKey`/`version`/optional bound variables.
- `expected.ir.json` — the frozen `ExtractionResult` (`{ schemaVersion, nodes, unresolved, version }`)
  produced by running that mock tree through the real extractor
  (`extractSelection`).

`src/corpus/index.ts` lists every scenario; `src/__tests__/snapshot.test.ts`
and `src/__tests__/schema-validation.test.ts` iterate that list, so adding a
new scenario there is all that's needed to wire it into `npm test`.

## Scenarios

| Scenario                      | What it exercises                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `card-with-button`            | A card-like screen nested 2+ levels deep (`Screen > Card > ButtonRow > AppButton`), mixing plain text, mixed-style text (`getStyledTextSegments` with 2 runs), and a mapped `instance` node alongside `text`/`layout` siblings — plus bound-variable token resolution (padding/gap/background/typography) next to unbound literals.                          |
| `instance-list`               | 4 structurally-identical `AppButton` instances (same main component, same component-property keys, different labels) collapsing into a single `list` node (`itemCount: 4`), driven by real `instance` IR nodes rather than the bare frames used in `list.test.ts`.                                                                                           |
| `row-with-icon-and-accordion` | An icon `asset` node alongside `text` and an `instance` in the same parent, where the instance (`Accordions`) is a genuinely unmapped component set (`compose: null` in `mappings/component-map.yaml`) — exercising the `unmapped-component` `UnresolvedEntry` path end-to-end in a realistic layout, not in isolation.                                      |
| `overlay-badge-over-avatar`   | A mapped `AppBadge` instance absolutely positioned (`layoutPositioning: "ABSOLUTE"`) over the top-right corner of an avatar `asset`, inside a non-auto-layout ("stack") parent — exercising the overlay grouping/alignment path.                                                                                                                             |
| `dashboard-screen`            | A larger, comprehensive screen combining several of the above in one composition: a header mixing mixed-style text with an icon asset, a _frame-based_ (non-instance) reminders list collapsing to a `list` node, and a footer `AppButton` instance using an unmapped Figma variant value (`Style=Elevated Action`), exercising the `unmapped-variant` path. |

## Updating a snapshot

`expected.ir.json` files are **frozen extractor output**, not hand-written
expectations — they are meant to change only when the extractor's behavior
intentionally changes.

1. Make your extractor change in `plugin/src/extractor/`.
2. Run `npm test` — any affected fixture's snapshot test will fail with a
   diff.
3. **Review the new output carefully** against `schema/ir/v1/schema.json`
   and the extractor's documented rules to confirm the change is correct,
   not a regression.
4. Regenerate the frozen snapshots:
   ```sh
   npm run fixtures:update -w fixtures
   ```
   This re-runs every scenario through the real extractor and rewrites its
   `expected.ir.json` (formatted with the repo's Prettier config).
5. Re-run `npm test` (and `npm run format:check`) to confirm everything is
   green, then commit the diff to `expected.ir.json` alongside your
   extractor change so reviewers can see exactly what changed.

Use `fixtures:update` locally for deliberate, human-reviewed updates. CI
also regenerates snapshots through `npm run verify:generated`, then fails
if they differ from committed files; it never commits or accepts updated
snapshots automatically. `npm test` independently compares extractor output
with the frozen snapshots.

## Schema validation

Every corpus fixture is also validated as a complete `irDocument` against
`schema/ir/v1/schema.json` (`src/__tests__/schema-validation.test.ts`,
reusing the same ajv-based approach as `schema/src/ir-schema.test.ts`). This
catches a fixture that's internally consistent with extractor output but
happens to violate the schema — e.g. after a schema change lands without a
matching extractor update.

Captured production exports live separately under
[`src/real-world/`](./src/real-world/README.md). They are schema-regression
inputs, not re-extractable mock scenarios, and are not rewritten by
`fixtures:update`.
