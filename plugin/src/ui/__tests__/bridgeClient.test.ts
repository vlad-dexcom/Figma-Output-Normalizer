import { describe, expect, it, vi } from "vitest";
import { createBridgeClient, type SocketLike } from "../bridgeClient.js";

function fakeSocket(): SocketLike & { sent: string[] } {
  const sent: string[] = [];
  return {
    sent,
    onopen: null,
    onclose: null,
    onmessage: null,
    onerror: null,
    send: (d: string) => void sent.push(d),
    close: () => {},
  };
}

function setup() {
  const sockets: ReturnType<typeof fakeSocket>[] = [];
  const timers: (() => void)[] = [];
  const postToPlugin = vi.fn();
  const onStatus = vi.fn();
  const client = createBridgeClient({
    url: "ws://x",
    createSocket: () => {
      const s = fakeSocket();
      sockets.push(s);
      return s;
    },
    postToPlugin,
    onStatus,
    setTimeout: (fn) => void timers.push(fn),
  });
  client.start();
  return { client, sockets, timers, postToPlugin, onStatus };
}

const request = JSON.stringify({ type: "request", requestId: "a", op: "extract-tokens" });

describe("bridge client", () => {
  it("relays a request to the sandbox and the tokens result back", () => {
    const { client, sockets, postToPlugin, onStatus } = setup();
    sockets[0]!.onopen?.();
    expect(onStatus).toHaveBeenCalledWith("connected");

    sockets[0]!.onmessage?.({ data: request });
    expect(postToPlugin).toHaveBeenCalledWith({ type: "extract-tokens", requestId: "a" });

    const handled = client.handlePluginMessage({
      type: "token-result",
      requestId: "a",
      json: '{"k":1}',
      tokens: {} as never,
      source: { fileKey: "f", version: "v" },
      summary: { variableCount: 3, skippedCollections: [] },
    });
    expect(handled).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: "response",
      requestId: "a",
      ok: true,
      fileKey: "f",
      version: "v",
      json: '{"k":1}',
    });
  });

  it("relays errors and ignores messages it did not request", () => {
    const { client, sockets } = setup();
    sockets[0]!.onopen?.();
    sockets[0]!.onmessage?.({ data: request });

    expect(client.handlePluginMessage({ type: "error", message: "m", code: "unknown" })).toBe(
      false,
    );
    expect(
      client.handlePluginMessage({
        type: "error",
        message: "boom",
        code: "unknown",
        requestId: "a",
      }),
    ).toBe(true);
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({ ok: false, message: "boom" });
  });

  it("ignores garbage and reconnects after close", () => {
    const { sockets, timers, postToPlugin, onStatus } = setup();
    sockets[0]!.onmessage?.({ data: "not json" });
    expect(postToPlugin).not.toHaveBeenCalled();

    sockets[0]!.onclose?.();
    expect(onStatus).toHaveBeenCalledWith("disconnected");
    timers[0]!();
    expect(sockets).toHaveLength(2);
  });

  it("announces the file on connect, and when file-info arrives after connecting", () => {
    const { client, sockets } = setup();
    client.handlePluginMessage({ type: "file-info", fileKey: "F", fileName: "DS" });
    sockets[0]!.onopen?.();
    expect(JSON.parse(sockets[0]!.sent[0]!)).toMatchObject({
      type: "hello",
      fileKey: "F",
      fileName: "DS",
    });

    const late = setup();
    late.sockets[0]!.onopen?.();
    expect(late.sockets[0]!.sent).toHaveLength(0);
    late.client.handlePluginMessage({ type: "file-info", fileKey: "G", fileName: "X" });
    expect(JSON.parse(late.sockets[0]!.sent[0]!)).toMatchObject({ type: "hello", fileKey: "G" });
  });
});
