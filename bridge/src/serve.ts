// `tokens-sync serve`: a long-lived bridge for IDE integrations. Speaks
// JSON lines on stdio so a host (the Android Studio plugin) can show live
// connection status and trigger syncs without spawning a process per run.
//
//   host -> bridge (stdin):  {"cmd":"sync","id":"1","config":{...},"dryRun":false}
//                            {"cmd":"shutdown"}
//   bridge -> host (stdout): {"type":"status","bridge":"listening","port":8765,"plugins":[...]}
//                            {"type":"status","bridge":"error","message":"..."}
//                            {"type":"log","id":"1","level":"info|error|system","text":"..."}
//                            {"type":"result","id":"1","exitCode":0,"tokensChanged":true,"version":"..."}
//                            {"type":"error","id":"1","code":"no-plugin","message":"..."}
//
// stdout carries ONLY protocol lines; everything human-readable is a "log".
import { createInterface } from "node:readline";
import type { Readable, Writable } from "node:stream";
import { Bridge, BridgeError, type PluginInfo } from "./server.js";
import { ConfigError, syncTokens, type SyncConfig } from "./sync.js";

export interface SyncCommand {
  cmd: "sync";
  id: string;
  config: SyncConfig;
  dryRun?: boolean;
  check?: boolean;
  timeoutMs?: number;
}

export interface ServeOptions {
  port: number;
  input?: Readable;
  output?: Writable;
}

/** Runs until a `shutdown` command or stdin closes. Resolves with the process exit code. */
export async function serve(options: ServeOptions): Promise<number> {
  const out = options.output ?? process.stdout;
  const emit = (message: Record<string, unknown>): void => {
    out.write(JSON.stringify(message) + "\n");
  };

  let bridge: Bridge;
  try {
    bridge = await Bridge.start({ port: options.port });
  } catch (error) {
    emit({ type: "status", bridge: "error", message: (error as Error).message });
    return 1;
  }
  const emitStatus = (plugins: PluginInfo[]): void =>
    emit({ type: "status", bridge: "listening", port: bridge.port, plugins });
  bridge.onPluginsChanged(emitStatus);
  emitStatus(bridge.getPlugins());

  // Serialized: two syncs would write the same output directory concurrently.
  let queue: Promise<void> = Promise.resolve();
  const handleSync = async (command: SyncCommand): Promise<void> => {
    const log =
      (level: string) =>
      (text: string): void => {
        for (const line of text.split("\n"))
          emit({ type: "log", id: command.id, level, text: line });
      };
    try {
      const result = await syncTokens({
        config: command.config,
        baseDir: process.cwd(),
        bridge,
        timeoutMs: command.timeoutMs ?? 30_000,
        dryRun: command.dryRun,
        check: command.check,
        io: { stdout: log("info"), stderr: log("error") },
      });
      emit({
        type: "result",
        id: command.id,
        exitCode: result.exitCode,
        tokensChanged: result.tokensChanged,
        version: result.version,
        fileKey: result.fileKey,
      });
    } catch (error) {
      emit({
        type: "error",
        id: command.id,
        code: error instanceof BridgeError ? error.code : "failed",
        message: error instanceof Error ? error.message : String(error),
      });
    }
  };

  return new Promise<number>((resolve) => {
    const shutdown = async (): Promise<void> => {
      await queue;
      await bridge.close();
      resolve(0);
    };
    const rl = createInterface({ input: options.input ?? process.stdin });
    rl.on("line", (line) => {
      let command: Omit<Partial<SyncCommand>, "cmd"> & { cmd?: string };
      try {
        command = JSON.parse(line);
      } catch {
        emit({ type: "error", code: "bad-command", message: "Command is not valid JSON." });
        return;
      }
      if (command.cmd === "shutdown") {
        void shutdown();
      } else if (command.cmd === "sync" && command.id && command.config) {
        queue = queue.then(() => handleSync(command as SyncCommand));
      } else {
        emit({
          type: "error",
          id: command.id,
          code: "bad-command",
          message: `Unknown or incomplete command: ${command.cmd}`,
        });
      }
    });
    rl.on("close", () => void shutdown());
  });
}

export { ConfigError };
