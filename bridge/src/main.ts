// `tokens:sync`: Figma plugin -> tokens.json -> Kotlin, in one command.
import path from "node:path";
import { DEFAULT_BRIDGE_PORT } from "./protocol.js";
import { BridgeError } from "./server.js";
import { serve } from "./serve.js";
import { ConfigError, loadConfig, syncTokens } from "./sync.js";

const HELP = `Usage: tokens:sync [--config <path>] [options]

Asks the running Figma plugin for the file's design tokens (over a local
WebSocket), saves the document, and runs the Kotlin generator on it.

  serve              Long-lived mode for IDE integrations (JSON lines on stdio).
  --config <path>    Config file (default: ./tokens-sync.config.json).
  --output <dir>     Override "output" from the config.
  --port <n>         Bridge port (default 8765; must match the plugin manifest).
  --timeout <sec>    Wait for plugin connection + response (default 60).
  --dry-run          Show what would change; writes nothing.
  --check            Exit non-zero if the generated output is stale; writes nothing.
  --help, -h         Show this help.
`;

export async function main(argv: readonly string[]): Promise<number> {
  let configPath = "tokens-sync.config.json";
  let output: string | undefined;
  let port: number | undefined;
  let timeoutSec = 60;
  let dryRun = false;
  let serveMode = false;
  let check = false;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const value = (): string => {
      const v = argv[++i];
      if (v === undefined) throw new ConfigError(`${arg} requires a value.`);
      return v;
    };
    switch (arg) {
      case "--config":
        configPath = value();
        break;
      case "--output":
        output = value();
        break;
      case "--port":
        port = Number(value());
        break;
      case "--timeout":
        timeoutSec = Number(value());
        break;
      case "serve":
        serveMode = true;
        break;
      case "--dry-run":
        dryRun = true;
        break;
      case "--check":
        check = true;
        break;
      case "--help":
      case "-h":
        console.log(HELP);
        return 0;
      default:
        console.error(`Unknown argument: ${arg}\n\n${HELP}`);
        return 1;
    }
  }

  if (serveMode) return serve({ port: port ?? DEFAULT_BRIDGE_PORT });

  try {
    const absConfig = path.resolve(configPath);
    const config = await loadConfig(absConfig);
    // A CLI --output is relative to the caller's cwd, not the config's dir.
    const baseDir = path.dirname(absConfig);
    if (output !== undefined) config.output = path.resolve(output);
    const result = await syncTokens({
      config,
      baseDir,
      port,
      timeoutMs: timeoutSec * 1000,
      dryRun,
      check,
    });
    return result.exitCode;
  } catch (error) {
    if (error instanceof ConfigError || error instanceof BridgeError) {
      console.error(error.message);
      return 1;
    }
    throw error;
  }
}
