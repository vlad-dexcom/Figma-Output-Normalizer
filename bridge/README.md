# @figma-exporter/bridge

Removes the manual export/download/CLI steps from token re-generation.
The plugin panel keeps a WebSocket open to a local bridge; `tokens:sync`
starts the bridge, asks the plugin for the file's tokens, saves the
document, and runs `codegen-tokens` on it — one command.

```
Figma desktop ─ plugin sandbox (extractTokens)
                  ⇅ postMessage
               plugin UI iframe (ui/bridgeClient.ts)
                  ⇅ ws://localhost:8765
               bridge (this package) ─ tokens:sync ─ codegen-tokens ─ Kotlin
```

## Usage

1. Build and (re)import the plugin (`npm run build --workspace=plugin`); the
   manifest allows `ws://localhost:8765` in development only.
2. Copy `tokens-sync.config.example.json` to `tokens-sync.config.json`
   (relative paths resolve against the config's directory) and set `output`
   to the Kotlin directory inside your local app checkout.
3. Run:
   ```bash
   npm run tokens:sync -- --config bridge/tokens-sync.config.json
   ```
4. Open the design-system file in Figma desktop and run the plugin. The panel
   shows "Bridge: connected", extraction starts by itself, and Kotlin is
   written. Start order doesn't matter: the plugin retries every 2 s.

Flags: `--output`, `--port`, `--timeout <sec>` (default 60), `--dry-run`,
`--check` (non-zero when the output is stale; writes nothing).

## Serve mode (IDE integrations)

`tokens:sync serve --port 8765` keeps the bridge running and speaks JSON lines on
stdio, so a host such as the DexFigmaPlugin Android Studio plugin can show live
status and trigger syncs without a process per run. The plugin sends a `hello`
(file key + name) on connect, so status includes which Figma file is attached.

- host → bridge: `{"cmd":"sync","id","config":{…},"dryRun":false}`, `{"cmd":"shutdown"}`
- bridge → host: `{"type":"status","bridge":"listening","port","plugins":[{"fileKey","fileName"}]}`
  (or `"bridge":"error","message"`), `{"type":"log","id","level","text"}`,
  `{"type":"result","id","exitCode","tokensChanged","version"}`, `{"type":"error","id","code","message"}`

`npm run bundle --workspace=@figma-exporter/bridge` builds a dependency-free
`bridge/dist/tokens-sync.cjs` (bridge + generator) runnable with a plain `node`.

## Guarantees

- The saved `figma.tokens.json` is byte-identical to a manual export, and
  the command reports whether it changed since the last sync.
- `fileKey` in the config pins the file: tokens from any other open Figma
  file are ignored, and a mismatch is reported explicitly.
- Binds to `127.0.0.1` only and rejects WebSocket connections carrying a
  web-page `Origin` (the plugin iframe's origin is `null`).
- No git actions; the generator's existing stale-file pruning applies.

## Not yet covered

Figma desktop must be open with the plugin running. Fully headless options
(REST Variables API, Enterprise only) and an MCP layer are tracked in
`docs/BACKLOG.md`.
