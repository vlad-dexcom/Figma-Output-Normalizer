// Wire protocol between the bridge server (Node) and the plugin UI iframe.
// Deliberately dependency-free (types + constants only) so the plugin bundle
// can import it via `@figma-normalizator/bridge/protocol` without pulling
// in `ws` or any Node API.

export const BRIDGE_PROTOCOL_VERSION = 1;
export const DEFAULT_BRIDGE_PORT = 8765;
/** URL the plugin UI connects to; must match `networkAccess.devAllowedDomains` in the manifest. */
export const BRIDGE_PLUGIN_URL = `ws://localhost:${DEFAULT_BRIDGE_PORT}`;

/** Server -> plugin. */
export type BridgeRequest = {
  type: "request";
  requestId: string;
  op: "extract-tokens";
};

export interface TokensPayload {
  fileKey: string;
  version: string;
  /** The canonically serialized token document, byte-identical to a manual export. */
  json: string;
  summary: { variableCount: number; skippedCollections: { name: string; reason: string }[] };
}

/** Plugin -> server, sent once per connection so the bridge can show which file is attached. */
export interface PluginHello {
  type: "hello";
  protocol: number;
  fileKey: string;
  fileName: string;
}

/** Plugin -> server. */
export type BridgeResponse =
  | ({ type: "response"; requestId: string; ok: true } & TokensPayload)
  | { type: "response"; requestId: string; ok: false; code: string; message: string };

export function isPluginHello(value: unknown): value is PluginHello {
  const v = value as Partial<PluginHello> | null;
  return !!v && v.type === "hello" && typeof v.fileKey === "string";
}

export function isBridgeRequest(value: unknown): value is BridgeRequest {
  const v = value as Partial<BridgeRequest> | null;
  return (
    !!v && v.type === "request" && typeof v.requestId === "string" && v.op === "extract-tokens"
  );
}

export function isBridgeResponse(value: unknown): value is BridgeResponse {
  const v = value as Partial<BridgeResponse> | null;
  return !!v && v.type === "response" && typeof v.requestId === "string" && "ok" in v;
}
