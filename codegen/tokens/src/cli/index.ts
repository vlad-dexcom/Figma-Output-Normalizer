#!/usr/bin/env node
// Executable entry point for the `codegen-tokens` CLI (migration plan,
// stage 7). Thin by design: all real logic lives in `run.ts`/`args.ts` so
// it can be unit-tested without spawning a process.
//
// Invoke via `npm run cli --workspace=@figma-normalizator/codegen-tokens --
// <args>` (or `npx tsx src/cli/index.ts <args>` from this package's
// directory). This package's sibling workspace dependencies (schema,
// mappings) resolve to their TypeScript sources (`main: src/index.ts`),
// which only `tsx`/`vitest`-style loaders can import directly, so a plain
// `node dist/...` invocation of *this file* would not work -- but
// `npm run bundle --workspace=...` (scripts/build-bundle.mjs) produces a
// self-contained `dist/codegen-tokens.cjs` that inlines those sources and
// can be run with a plain `node`, for consumers that don't want an
// `npm install`/workspace checkout (see README.md, "Building a standalone
// bundle").
import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
