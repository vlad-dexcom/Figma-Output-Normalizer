#!/usr/bin/env node
// Bundles the tokens-sync CLI (including `serve` mode, `ws` and the
// codegen-tokens generator) into one dependency-free file so external
// hosts such as the DexFigmaPlugin IDE plugin can run it with a plain `node`.
// Usage: npm run bundle --workspace=@figma-normalizator/bridge
import { build } from "esbuild";
import path from "node:path";

const packageRoot = path.join(path.dirname(new URL(import.meta.url).pathname), "..");

await build({
  entryPoints: [path.join(packageRoot, "src/cli.ts")],
  outfile: path.join(packageRoot, "dist/tokens-sync.cjs"),
  bundle: true,
  platform: "node",
  format: "cjs",
  target: "node18",
  legalComments: "none",
  // Optional native accelerators `ws` falls back from when absent.
  external: ["bufferutil", "utf-8-validate"],
  logLevel: "info",
});
