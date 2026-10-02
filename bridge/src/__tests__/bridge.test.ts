import { mkdtemp, readFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import WebSocket from "ws";
import { Bridge, BridgeError, isAllowedOrigin } from "../server.js";
import { buildCodegenArgs, loadConfig, syncTokens, type SyncConfig } from "../sync.js";
import type { BridgeRequest, BridgeResponse } from "../protocol.js";

const FIXTURE = path.resolve(
  __dirname,
  "../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

const open: (Bridge | WebSocket)[] = [];
afterEach(async () => {
  for (const item of open.splice(0)) {
    if (item instanceof Bridge) await item.close();
    else item.terminate();
  }
});

/** Stands in for the plugin UI: answers every request with `respond(requestId)`. */
async function connectFakePlugin(
  port: number,
  respond: (requestId: string) => BridgeResponse,
  options: WebSocket.ClientOptions = {},
): Promise<WebSocket> {
  const ws = new WebSocket(`ws://127.0.0.1:${port}`, options);
  open.push(ws);
  ws.on("message", (data) => {
    const request = JSON.parse(String(data)) as BridgeRequest;
    ws.send(JSON.stringify(respond(request.requestId)));
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return ws;
}

const ok = (requestId: string, fileKey: string, json = "{}"): BridgeResponse => ({
  type: "response",
  requestId,
  ok: true,
  fileKey,
  version: "c1-test",
  json,
  summary: { variableCount: 1, skippedCollections: [] },
});

describe("Bridge", () => {
  it("returns the tokens from a connected plugin", async () => {
    const bridge = await Bridge.start({ port: 0 });
    open.push(bridge);
    await connectFakePlugin(bridge.port, (id) => ok(id, "F1"));
    const payload = await bridge.requestTokens({ expectedFileKey: "F1", timeoutMs: 2000 });
    expect(payload.fileKey).toBe("F1");
  });

  it("serves a plugin that connects after the request started", async () => {
    const bridge = await Bridge.start({ port: 0 });
    open.push(bridge);
    const pending = bridge.requestTokens({ timeoutMs: 2000 });
    await connectFakePlugin(bridge.port, (id) => ok(id, "F1"));
    await expect(pending).resolves.toMatchObject({ fileKey: "F1" });
  });

  it("picks the matching file when several are open", async () => {
    const bridge = await Bridge.start({ port: 0 });
    open.push(bridge);
    await connectFakePlugin(bridge.port, (id) => ok(id, "OTHER"));
    await connectFakePlugin(bridge.port, (id) => ok(id, "WANTED"));
    const payload = await bridge.requestTokens({ expectedFileKey: "WANTED", timeoutMs: 2000 });
    expect(payload.fileKey).toBe("WANTED");
  });

  it("reports a wrong file, a missing plugin and a plugin error distinctly", async () => {
    const bridge = await Bridge.start({ port: 0 });
    open.push(bridge);
    await expect(bridge.requestTokens({ timeoutMs: 100 })).rejects.toMatchObject({
      code: "no-plugin",
    });

    const wrong = await connectFakePlugin(bridge.port, (id) => ok(id, "OTHER"));
    await expect(
      bridge.requestTokens({ expectedFileKey: "WANTED", timeoutMs: 200 }),
    ).rejects.toMatchObject({ code: "wrong-file" });
    wrong.terminate();

    await connectFakePlugin(bridge.port, (id) => ({
      type: "response",
      requestId: id,
      ok: false,
      code: "token-budget-exceeded",
      message: "too many",
    }));
    await expect(bridge.requestTokens({ timeoutMs: 200 })).rejects.toBeInstanceOf(BridgeError);
  });

  it("rejects connections from web-page origins", async () => {
    expect(isAllowedOrigin("https://evil.example")).toBe(false);
    expect(isAllowedOrigin("null")).toBe(true);
    const bridge = await Bridge.start({ port: 0 });
    open.push(bridge);
    await expect(
      connectFakePlugin(bridge.port, (id) => ok(id, "F"), {
        headers: { Origin: "https://evil.example" },
      }),
    ).rejects.toBeTruthy();
  });
});

describe("syncTokens", () => {
  it("fetches tokens and generates Kotlin end to end", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "sync-test-"));
    const json = await readFile(FIXTURE, "utf8");
    const fileKey = (JSON.parse(json) as { envelope: { fileKey: string } }).envelope.fileKey;
    const config: SyncConfig = {
      fileKey,
      output: "kotlin",
      package: "com.example.tokens",
      excludeMode: "[iI][oO][sS]",
      onUnresolved: { "unsupported-value": "warn" },
    };
    const logs: string[] = [];
    const io = { stdout: (m: string) => logs.push(m), stderr: (m: string) => logs.push(m) };

    const port = 38765;
    const run = syncTokens({ config, baseDir: dir, port, timeoutMs: 5000, io });
    // Wait for the sync's own bridge to listen, then act as the plugin.
    let ws: WebSocket | undefined;
    for (let i = 0; i < 50 && !ws; i++) {
      await new Promise((r) => setTimeout(r, 50));
      ws = await connectFakePlugin(port, (id) => ok(id, fileKey, json)).catch(() => undefined);
    }
    const result = await run;

    expect(result.exitCode).toBe(0);
    expect(result.tokensChanged).toBe(true);
    expect(await readFile(path.join(dir, "figma.tokens.json"), "utf8")).toBe(json);
    const written = await readdir(path.join(dir, "kotlin"), { recursive: true });
    expect(written.some((f) => f.endsWith("Primitives.kt"))).toBe(true);
  });
});

describe("config", () => {
  it("maps a config to codegen-tokens flags", () => {
    const args = buildCodegenArgs(
      {
        output: "o",
        package: "p",
        layout: "legacy",
        prefix: "DT",
        excludeMode: ["a", "b"],
        onUnresolved: { x: "fail" },
        fallbackCollections: { c: "p" },
      },
      "in.json",
      "/abs/o",
      { check: true },
    );
    expect(args).toEqual([
      "--input",
      "in.json",
      "--output",
      "/abs/o",
      "--package",
      "p",
      "--layout",
      "legacy",
      "--prefix",
      "DT",
      "--exclude-mode",
      "a",
      "--exclude-mode",
      "b",
      "--on-unresolved",
      "x=fail",
      "--fallback-collection",
      "c=p",
      "--check",
    ]);
  });

  it("rejects a config missing required keys", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "cfg-"));
    const file = path.join(dir, "c.json");
    await import("node:fs/promises").then((fs) => fs.writeFile(file, '{"output":"x"}'));
    await expect(loadConfig(file)).rejects.toThrow(/"package" is required/);
  });
});
