import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { runCli, type CliIo } from "@figma-normalizator/codegen-tokens";
import { Bridge, BridgeError } from "./server.js";
import { DEFAULT_BRIDGE_PORT, type TokensPayload } from "./protocol.js";

/** `tokens-sync.config.json`. Relative paths resolve against the config file's directory. */
export interface SyncConfig {
  /** Pins the Figma file; tokens from any other open file are ignored. */
  fileKey?: string;
  /** Directory to write Kotlin into (typically inside a local app checkout). */
  output: string;
  /** Kotlin package for every generated file. */
  package: string;
  layout?: "flat" | "legacy";
  prefix?: string;
  /** Regex, or comma-separated regexes, passed to `--exclude-mode`. */
  excludeMode?: string | string[];
  /** `{ "unsupported-value": "fail" }` -> `--on-unresolved unsupported-value=fail`. */
  onUnresolved?: Record<string, "silent" | "warn" | "fail">;
  /** `{ child: parent }` -> `--fallback-collection child=parent`. */
  fallbackCollections?: Record<string, string>;
  /** Where the fetched token document is saved for review/diffing. Default: `figma.tokens.json`. */
  tokensJson?: string;
}

export class ConfigError extends Error {}

export async function loadConfig(configPath: string): Promise<SyncConfig> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch {
    throw new ConfigError(`Cannot read config file ${configPath}.`);
  }
  let config: SyncConfig;
  try {
    config = JSON.parse(raw) as SyncConfig;
  } catch (error) {
    throw new ConfigError(`${configPath} is not valid JSON: ${(error as Error).message}`);
  }
  for (const key of ["output", "package"] as const) {
    if (typeof config[key] !== "string" || config[key].length === 0) {
      throw new ConfigError(`${configPath}: "${key}" is required.`);
    }
  }
  if (config.layout !== undefined && config.layout !== "flat" && config.layout !== "legacy") {
    throw new ConfigError(`${configPath}: "layout" must be "flat" or "legacy".`);
  }
  return config;
}

export interface SyncOptions {
  config: SyncConfig;
  /** Directory relative config paths resolve against. */
  baseDir: string;
  port?: number;
  /** Reuse a running bridge (serve mode); otherwise one is started and closed for this call. */
  bridge?: Bridge;
  timeoutMs?: number;
  dryRun?: boolean;
  check?: boolean;
  io?: CliIo;
}

export interface SyncResult {
  exitCode: number;
  fileKey: string;
  version: string;
  /** False when the fetched document is byte-identical to the previously saved one. */
  tokensChanged: boolean;
  tokensJsonPath: string;
  summary: TokensPayload["summary"];
}

/** Builds the `codegen-tokens` argv equivalent of a config. Exported for tests. */
export function buildCodegenArgs(
  config: SyncConfig,
  input: string,
  output: string,
  flags: { dryRun?: boolean; check?: boolean } = {},
): string[] {
  const args = ["--input", input, "--output", output, "--package", config.package];
  if (config.layout) args.push("--layout", config.layout);
  if (config.prefix) args.push("--prefix", config.prefix);
  for (const pattern of [config.excludeMode ?? []].flat()) args.push("--exclude-mode", pattern);
  for (const [reason, action] of Object.entries(config.onUnresolved ?? {})) {
    args.push("--on-unresolved", `${reason}=${action}`);
  }
  for (const [child, parent] of Object.entries(config.fallbackCollections ?? {})) {
    args.push("--fallback-collection", `${child}=${parent}`);
  }
  if (flags.dryRun) args.push("--dry-run");
  if (flags.check) args.push("--check");
  return args;
}

/**
 * The whole flow in one call: ask the connected plugin for the file's
 * tokens, persist the document, and run the Kotlin generator on it.
 */
export async function syncTokens(options: SyncOptions): Promise<SyncResult> {
  const { config, baseDir } = options;
  const io: CliIo = options.io ?? {
    stdout: (m) => console.log(m),
    stderr: (m) => console.error(m),
  };
  const resolve = (p: string): string => path.resolve(baseDir, p);
  const tokensJsonPath = resolve(config.tokensJson ?? "figma.tokens.json");

  const ownsBridge = options.bridge === undefined;
  const bridge =
    options.bridge ??
    (await Bridge.start({
      port: options.port ?? DEFAULT_BRIDGE_PORT,
      log: (m) => io.stderr(`bridge: ${m}`),
    }));
  io.stdout(
    ownsBridge
      ? `Bridge listening on 127.0.0.1:${bridge.port}. Waiting for the Figma plugin ` +
          `(open the file and run Plugins → Development → Figma Normalizator)…`
      : `Requesting tokens from the connected Figma plugin…`,
  );

  let payload: TokensPayload;
  try {
    payload = await bridge.requestTokens({
      expectedFileKey: config.fileKey,
      timeoutMs: options.timeoutMs,
    });
  } finally {
    if (ownsBridge) await bridge.close();
  }

  const previous = await readFile(tokensJsonPath, "utf8").catch(() => undefined);
  const tokensChanged = previous !== payload.json;
  const skipWrite = options.dryRun || options.check;
  if (!skipWrite) {
    await mkdir(path.dirname(tokensJsonPath), { recursive: true });
    await writeFile(tokensJsonPath, payload.json, "utf8");
  }

  const { variableCount, skippedCollections } = payload.summary;
  io.stdout(
    `Received ${variableCount} variables (version ${payload.version}, ` +
      `${skippedCollections.length} collection(s) skipped by policy); tokens ` +
      `${tokensChanged ? "CHANGED" : "unchanged"} since the last sync.`,
  );

  // `--dry-run`/`--check` must not touch disk, so hand codegen a temp-free
  // path: the saved file when it is current, otherwise the fresh document.
  const input = skipWrite && tokensChanged ? await writeTemp(payload.json) : tokensJsonPath;
  const exitCode = await runCli(
    buildCodegenArgs(config, input, resolve(config.output), options),
    io,
  );

  return {
    exitCode,
    fileKey: payload.fileKey,
    version: payload.version,
    tokensChanged,
    tokensJsonPath,
    summary: payload.summary,
  };
}

async function writeTemp(json: string): Promise<string> {
  const { mkdtemp } = await import("node:fs/promises");
  const { tmpdir } = await import("node:os");
  const dir = await mkdtemp(path.join(tmpdir(), "tokens-sync-"));
  const file = path.join(dir, "figma.tokens.json");
  await writeFile(file, json, "utf8");
  return file;
}

export { BridgeError };
