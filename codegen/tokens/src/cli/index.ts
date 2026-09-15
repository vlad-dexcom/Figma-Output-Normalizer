#!/usr/bin/env node
// Executable entry point for the `codegen-tokens` CLI (migration plan,
// stage 7). Thin by design: all real logic lives in `run.ts`/`args.ts` so
// it can be unit-tested without spawning a process.
//
// Invoke via `npm run cli --workspace=@figma-normalizator/codegen-tokens --
// <args>` (or `npx tsx src/cli/index.ts <args>` from this package's
// directory) -- not as a compiled/published `bin`. This package's sibling
// workspace dependencies (schema, mappings) resolve to their TypeScript
// sources (`main: src/index.ts`), which only `tsx`/`vitest`-style loaders
// can import directly; a plain `node dist/...` invocation cannot.
import { runCli } from "./run.js";

runCli(process.argv.slice(2)).then((code) => {
  process.exitCode = code;
});
