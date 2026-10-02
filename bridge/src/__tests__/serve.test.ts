import { PassThrough } from "node:stream";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import WebSocket from "ws";
import { serve } from "../serve.js";

const FIXTURE = path.resolve(
  __dirname,
  "../../../fixtures/src/real-world/gPHx1sqQHIfMs8706VDGM1_c1-4228e256df698463.tokens.json",
);

type Msg = Record<string, unknown>;

function harness() {
  const input = new PassThrough();
  const output = new PassThrough();
  const messages: Msg[] = [];
  output.on("data", (chunk: Buffer) => {
    for (const line of chunk.toString().split("\n").filter(Boolean)) {
      messages.push(JSON.parse(line) as Msg);
    }
  });
  const waitFor = async (predicate: (m: Msg) => boolean, ms = 5000): Promise<Msg> => {
    const deadline = Date.now() + ms;
    while (Date.now() < deadline) {
      const found = messages.find(predicate);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`timed out; got ${JSON.stringify(messages)}`);
  };
  return { input, output, messages, waitFor };
}

describe("serve", () => {
  it("reports plugin status live and runs a sync on command", async () => {
    const port = 38766;
    const h = harness();
    const done = serve({ port, input: h.input, output: h.output });

    await h.waitFor((m) => m.type === "status" && m.bridge === "listening");

    const json = await readFile(FIXTURE, "utf8");
    const fileKey = (JSON.parse(json) as { envelope: { fileKey: string } }).envelope.fileKey;
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    await new Promise<void>((resolve) => ws.once("open", () => resolve()));
    ws.send(JSON.stringify({ type: "hello", protocol: 1, fileKey, fileName: "Design System" }));
    ws.on("message", (data) => {
      const request = JSON.parse(String(data)) as { requestId: string };
      ws.send(
        JSON.stringify({
          type: "response",
          requestId: request.requestId,
          ok: true,
          fileKey,
          version: "c1-test",
          json,
          summary: { variableCount: 1, skippedCollections: [] },
        }),
      );
    });

    const status = await h.waitFor(
      (m) => m.type === "status" && (m.plugins as unknown[]).length === 1 && hasFile(m, fileKey),
    );
    expect((status.plugins as { fileName: string }[])[0]?.fileName).toBe("Design System");

    const dir = await mkdtemp(path.join(tmpdir(), "serve-test-"));
    h.input.write(
      JSON.stringify({
        cmd: "sync",
        id: "1",
        config: {
          fileKey,
          output: path.join(dir, "kotlin"),
          package: "com.example.tokens",
          tokensJson: path.join(dir, "figma.tokens.json"),
          excludeMode: "[iI][oO][sS]",
          onUnresolved: { "unsupported-value": "warn" },
        },
      }) + "\n",
    );
    const result = await h.waitFor((m) => m.type === "result" && m.id === "1");
    expect(result).toMatchObject({ exitCode: 0, tokensChanged: true, version: "c1-test" });

    ws.close();
    await h.waitFor(
      (m) =>
        m.type === "status" && (m.plugins as unknown[]).length === 0 && h.messages.indexOf(m) > 1,
    );
    h.input.write('{"cmd":"shutdown"}\n');
    expect(await done).toBe(0);
  });

  it("reports a busy port as a bridge error", async () => {
    const port = 38767;
    const first = harness();
    const running = serve({ port, input: first.input, output: first.output });
    await first.waitFor((m) => m.bridge === "listening");

    const second = harness();
    expect(await serve({ port, input: second.input, output: second.output })).toBe(1);
    expect(second.messages[0]).toMatchObject({ type: "status", bridge: "error" });

    first.input.write('{"cmd":"shutdown"}\n');
    await running;
  });
});

function hasFile(m: Msg, fileKey: string): boolean {
  return (m.plugins as { fileKey?: string }[]).some((p) => p.fileKey === fileKey);
}
