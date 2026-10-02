import { randomUUID } from "node:crypto";
import { WebSocketServer, type WebSocket } from "ws";
import {
  DEFAULT_BRIDGE_PORT,
  isBridgeResponse,
  isPluginHello,
  type BridgeRequest,
  type TokensPayload,
} from "./protocol.js";

export class BridgeError extends Error {
  constructor(
    message: string,
    readonly code: "no-plugin" | "timeout" | "wrong-file" | "plugin-error" | "closed",
  ) {
    super(message);
    this.name = "BridgeError";
  }
}

export interface BridgeOptions {
  port?: number;
  host?: string;
  log?: (message: string) => void;
}

export interface RequestTokensOptions {
  /** Reject (and keep waiting for another connected file) unless the plugin reports this file key. */
  expectedFileKey?: string;
  /** How long to wait for the plugin to connect AND answer. */
  timeoutMs?: number;
}

/**
 * Figma plugin iframes have an opaque ("null") origin. Any other origin is
 * a web page trying to reach localhost, which must not be able to feed the
 * codegen forged tokens.
 */
export function isAllowedOrigin(origin: string | undefined): boolean {
  return origin === undefined || origin === "null";
}

/** A connected plugin instance; `fileKey`/`fileName` are unknown until its hello arrives. */
export interface PluginInfo {
  id: number;
  fileKey?: string;
  fileName?: string;
}

export class Bridge {
  private readonly plugins = new Map<WebSocket, PluginInfo>();
  private readonly listeners = new Set<(plugins: PluginInfo[]) => void>();
  private nextId = 1;

  private constructor(
    private readonly wss: WebSocketServer,
    private readonly log: (message: string) => void,
  ) {
    wss.on("connection", (client) => {
      const info: PluginInfo = { id: this.nextId++ };
      this.plugins.set(client, info);
      this.emit();
      client.on("message", (data) => {
        try {
          const parsed: unknown = JSON.parse(String(data));
          if (isPluginHello(parsed)) {
            info.fileKey = parsed.fileKey || undefined;
            info.fileName = parsed.fileName || undefined;
            this.emit();
          }
        } catch {
          // Non-JSON frames are ignored, like any other unknown message.
        }
      });
      client.on("close", () => {
        this.plugins.delete(client);
        this.emit();
      });
    });
  }

  /** Currently connected plugin instances (one per open Figma file running the plugin). */
  getPlugins(): PluginInfo[] {
    return [...this.plugins.values()].map((p) => ({ ...p }));
  }

  /** Subscribes to connect/hello/disconnect changes. Returns an unsubscribe function. */
  onPluginsChanged(listener: (plugins: PluginInfo[]) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    const snapshot = this.getPlugins();
    for (const listener of this.listeners) listener(snapshot);
  }

  static start(options: BridgeOptions = {}): Promise<Bridge> {
    const log = options.log ?? (() => {});
    return new Promise((resolve, reject) => {
      const wss = new WebSocketServer({
        host: options.host ?? "127.0.0.1",
        port: options.port ?? DEFAULT_BRIDGE_PORT,
        verifyClient: (info: { origin?: string }) => isAllowedOrigin(info.origin),
      });
      wss.once("error", (error: NodeJS.ErrnoException) => {
        reject(
          error.code === "EADDRINUSE"
            ? new BridgeError(
                `Port ${options.port ?? DEFAULT_BRIDGE_PORT} is already in use (another bridge or tokens:sync running?).`,
                "closed",
              )
            : error,
        );
      });
      wss.once("listening", () => resolve(new Bridge(wss, log)));
    });
  }

  get port(): number {
    const address = this.wss.address();
    return typeof address === "object" && address ? address.port : 0;
  }

  get clientCount(): number {
    return this.wss.clients.size;
  }

  /**
   * Asks every connected plugin instance for the file's tokens and resolves
   * with the first answer that matches `expectedFileKey`. Clients that
   * connect after the call starts are asked too, so the caller may start
   * `tokens:sync` before opening the plugin in Figma.
   */
  requestTokens(options: RequestTokensOptions = {}): Promise<TokensPayload> {
    const timeoutMs = options.timeoutMs ?? 60_000;
    const requestId = randomUUID();
    const request: BridgeRequest = { type: "request", requestId, op: "extract-tokens" };
    const asked = new Set<WebSocket>();
    const seenFileKeys = new Set<string>();
    let lastPluginError: string | undefined;

    return new Promise((resolve, reject) => {
      const finish = (fn: () => void): void => {
        clearTimeout(timer);
        this.wss.off("connection", ask);
        for (const client of asked) client.off("message", onMessage);
        fn();
      };

      const onMessage = (data: unknown): void => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(String(data));
        } catch {
          return;
        }
        if (!isBridgeResponse(parsed) || parsed.requestId !== requestId) return;
        if (!parsed.ok) {
          lastPluginError = `${parsed.code}: ${parsed.message}`;
          this.log(`plugin reported an error: ${lastPluginError}`);
          return;
        }
        if (options.expectedFileKey && parsed.fileKey !== options.expectedFileKey) {
          seenFileKeys.add(parsed.fileKey);
          this.log(
            `ignoring tokens from file ${parsed.fileKey} (expected ${options.expectedFileKey})`,
          );
          return;
        }
        finish(() => resolve(parsed));
      };

      const ask = (client: WebSocket): void => {
        asked.add(client);
        client.on("message", onMessage);
        client.send(JSON.stringify(request));
      };

      const timer = setTimeout(() => {
        finish(() => {
          if (lastPluginError) {
            reject(new BridgeError(`Plugin failed: ${lastPluginError}`, "plugin-error"));
          } else if (seenFileKeys.size > 0) {
            reject(
              new BridgeError(
                `Connected Figma file(s) [${[...seenFileKeys].join(", ")}] do not match the ` +
                  `configured fileKey ${options.expectedFileKey}. Open the right file and run the plugin.`,
                "wrong-file",
              ),
            );
          } else if (asked.size === 0) {
            reject(
              new BridgeError(
                "No Figma plugin connected. Open the design-system file in Figma desktop and " +
                  "run Plugins → Development → Figma Normalizator.",
                "no-plugin",
              ),
            );
          } else {
            reject(new BridgeError("Timed out waiting for the plugin to respond.", "timeout"));
          }
        });
      }, timeoutMs);

      this.wss.on("connection", ask);
      for (const client of this.wss.clients) if (client.readyState === client.OPEN) ask(client);
    });
  }

  close(): Promise<void> {
    for (const client of this.wss.clients) client.terminate();
    return new Promise((resolve) => this.wss.close(() => resolve()));
  }
}
