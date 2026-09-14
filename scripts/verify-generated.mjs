#!/usr/bin/env node
// Fails when any checked-in generated artifact disagrees with the source it
// was generated from.
//
// This exists because of a measured, expensive failure: the retired
// `token-map` artifact was generated once from a downstream snapshot of the
// Figma file, checked in, bundled into the plugin — and then silently
// decayed. By the time it was audited, 514 of its rows referenced token
// paths that no longer existed (including all 324 rows of a `stelo`
// collection that had been deleted from Figma outright), 112 live tokens had
// no entry, and 111 colour values disagreed with the file. Nothing in CI,
// the type system, or the test suite noticed, because nothing was checking.
//
// Individual packages already have vitest "not stale" assertions; this
// script is the single, fast, dependency-light gate that CI runs so a
// generated file can never be committed out of sync with its source — and so
// the *list* of things that must stay in sync lives in one visible place
// rather than being implicit across three packages.
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateComponentMapJson } from "../mappings/scripts/generate-map-lib.mjs";
import { generateWiringRulesJson } from "../mappings/scripts/generate-wiring-rules-lib.mjs";
import { generateCollectionsPolicyJson } from "../mappings/scripts/generate-collections-policy-lib.mjs";
import {
  generateIrTypesFile,
  generateTokenTypesFile,
} from "../schema/scripts/generate-types-lib.mjs";

const repoRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * Every generated artifact, paired with the command that regenerates it.
 * Adding a generated file without adding it here is the mistake this list
 * is meant to make obvious in review.
 */
const artifacts = [
  {
    file: "mappings/src/generated/component-map.json",
    regenerate: "npm run generate:map --workspace @figma-normalizator/mappings",
    generate: generateComponentMapJson,
  },
  {
    file: "mappings/src/generated/wiring-rules.json",
    regenerate: "npm run generate:wiring-rules --workspace @figma-normalizator/mappings",
    generate: generateWiringRulesJson,
  },
  {
    file: "mappings/src/generated/collections-policy.json",
    regenerate: "npm run generate:collections-policy --workspace @figma-normalizator/mappings",
    generate: generateCollectionsPolicyJson,
  },
  {
    file: "schema/src/generated/ir.ts",
    regenerate: "npm run generate:types --workspace @figma-normalizator/schema",
    generate: generateIrTypesFile,
  },
  {
    file: "schema/src/generated/tokens.ts",
    regenerate: "npm run generate:types --workspace @figma-normalizator/schema",
    generate: generateTokenTypesFile,
  },
];

async function main() {
  const stale = [];

  for (const artifact of artifacts) {
    const expected = await artifact.generate();
    let actual;
    try {
      actual = await readFile(path.join(repoRoot, artifact.file), "utf8");
    } catch {
      stale.push({ ...artifact, missing: true });
      continue;
    }
    if (actual !== expected) stale.push(artifact);
  }

  if (stale.length === 0) {
    console.log(`All ${artifacts.length} generated artifacts are up to date.`);
    return;
  }

  console.error("Stale generated artifacts detected:\n");
  for (const artifact of stale) {
    console.error(`  ${artifact.file}${artifact.missing ? " (missing)" : ""}`);
    console.error(`    regenerate with: ${artifact.regenerate}\n`);
  }
  console.error("Regenerate them and commit the diff.");
  process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
