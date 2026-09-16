#!/usr/bin/env node
// Bundles the `codegen-tokens` CLI (src/cli/index.ts) plus its sibling
// workspace dependencies (schema, mappings) into a single, dependency-free
// JavaScript file at dist/codegen-tokens.cjs.
//
// Why this exists: this package's workspace dependencies resolve to their
// TypeScript sources (`main: src/index.ts`), which only `tsx`/`vitest`-style
// loaders can import directly (see src/cli/index.ts's header comment) -- so
// today the only way to run the CLI is `npm run cli --workspace=...`, which
// requires `npm install` and the whole monorepo checkout to be present.
//
// This script produces a single self-contained artifact that only needs a
// plain `node` to run (no npm, no node_modules, no workspace resolution),
// so it can be built once and then invoked directly by external consumers
// such as the DexFigmaPlugin IDE plugin.
//
// Usage: npm run bundle --workspace=@figma-normalizator/codegen-tokens
import { build } from "esbuild";
import path from "node:path";

const here = path.dirname(new URL(import.meta.url).pathname);
const packageRoot = path.join(here, "..");

await build({
  entryPoints: [path.join(packageRoot, "src/cli/index.ts")],
  outfile: path.join(packageRoot, "dist/codegen-tokens.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  legalComments: "none",
  logLevel: "info",
});
