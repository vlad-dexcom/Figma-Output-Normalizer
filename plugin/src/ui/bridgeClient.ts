// WebSocket client that lets a local bridge server (see `bridge/`) drive
// token extraction without anyone clicking buttons. Only the UI iframe can
// open sockets (the plugin sandbox has no network), so this relays: bridge
// request -> `extract-tokens` (with a requestId) to the sandbox -> the
// sandbox's requestId-tagged result/error back out over the socket.
// Everything environment-specific is injected so it runs under vitest.
import {
  BRIDGE_PROTOCOL_VERSION,
  isBridgeRequest,
  type BridgeResponse,
  type TokensPayload,
} from "@figma-exporter/bridge/protocol";
import type { PluginToUIMessage, UIToPluginMessage } from "../messages.js";

export type BridgeStatus = "connected" | "disconnected";

export interface SocketLike {
  onopen: (() => void) | null;
  onclose: (() => void) | null;
  onmessage: ((event: { data: unknown }) => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(): void;
}

export interface BridgeClientDeps {
  url: string;
  createSocket: (url: string) => SocketLike;
  postToPlugin: (message: UIToPluginMessage) => void;
  onStatus: (status: BridgeStatus) => void;
  setTimeout?: (fn: () => void, ms: number) => unknown;
  retryDelayMs?: number;
}

export interface BridgeClient {
  start(): void;
  /** Feed every sandbox message here; returns true if it belonged to a bridge request. */
  handlePluginMessage(message: PluginToUIMessage): boolean;
}

export function createBridgeClient(deps: BridgeClientDeps): BridgeClient {
  const schedule = deps.setTimeout ?? ((fn, ms) => setTimeout(fn, ms));
  const retryDelay = deps.retryDelayMs ?? 2000;
  let socket: SocketLike | null = null;
  const pending = new Set<string>();
  let isOpen = false;
  let fileInfo: { fileKey: string; fileName: string } | null = null;

  const sendHello = (): void => {
    if (!socket || !isOpen || !fileInfo) return;
    socket.send(JSON.stringify({ type: "hello", protocol: BRIDGE_PROTOCOL_VERSION, ...fileInfo }));
  };

  const send = (response: BridgeResponse): void => {
    if (socket && isOpen) socket.send(JSON.stringify(response));
  };

  const connect = (): void => {
    let current: SocketLike;
    try {
      current = deps.createSocket(deps.url);
    } catch {
      schedule(connect, retryDelay);
      return;
    }
    socket = current;
    current.onopen = () => {
      isOpen = true;
      deps.onStatus("connected");
      sendHello();
    };
    current.onmessage = (event) => {
      let parsed: unknown;
      try {
        parsed = JSON.parse(String(event.data));
      } catch {
        return;
      }
      if (!isBridgeRequest(parsed)) return;
      pending.add(parsed.requestId);
      deps.postToPlugin({ type: "extract-tokens", requestId: parsed.requestId });
    };
    current.onclose = () => {
      if (socket === current) {
        socket = null;
        isOpen = false;
      }
      pending.clear();
      deps.onStatus("disconnected");
      schedule(connect, retryDelay);
    };
    current.onerror = () => {
      // `onclose` always follows an error and owns the reconnect.
    };
  };

  return {
    start: connect,
    handlePluginMessage(message) {
      if (message.type === "file-info") {
        fileInfo = { fileKey: message.fileKey, fileName: message.fileName };
        sendHello();
        return true;
      }
      if (message.type !== "token-result" && message.type !== "error") return false;
      const requestId = message.requestId;
      if (requestId === undefined || !pending.has(requestId)) return false;
      pending.delete(requestId);

      if (message.type === "error") {
        send({
          type: "response",
          requestId,
          ok: false,
          code: message.code,
          message: message.message,
        });
      } else {
        const payload: TokensPayload = {
          fileKey: message.source.fileKey,
          version: message.source.version,
          json: message.json ?? "",
          summary: message.summary,
        };
        send({ type: "response", requestId, ok: true, ...payload });
      }
      return true;
    },
  };
}
