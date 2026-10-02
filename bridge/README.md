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

Run the commands below from the exporter repository root, after `npm install`.

1. Build and (re)import the plugin (`npm run build --workspace=plugin`); the
   manifest allows `ws://localhost:8765` in development only.
2. Copy `bridge/tokens-sync.config.example.json` to `bridge/tokens-sync.config.json`
   (relative paths resolve against the config's directory) and set `output`
   to the Kotlin directory inside your local app checkout. Set `package` and
   either replace the example's `fileKey` with your Figma file key or remove it
   to accept whichever file has the plugin running. The sample's
   `onUnresolved.unsupported-value: "warn"` is an explicit override; remove
   it to keep the generator's default failure on unsupported values.
3. Run:
   ```bash
   npm run tokens:sync -- --config bridge/tokens-sync.config.json
   ```
4. Open the design-system file in Figma desktop and run the plugin. The panel
   shows "Bridge: connected", extraction starts by itself, and Kotlin is
   written. Start order doesn't matter: the plugin retries every 2 s.

Flags: `--output`, `--port`, `--timeout <sec>` (default 60), `--dry-run`,
`--check` (non-zero when the output is stale; writes nothing).

Config fields: `output` and `package` are required; `fileKey`, `layout`
(`flat` or `legacy`), `prefix`, `excludeMode` (string or array),
`onUnresolved`, `fallbackCollections` (`{ "child": "parent" }`), and
`tokensJson` (default `figma.tokens.json`) are optional. Relative `output`
and `tokensJson` paths resolve against the config directory; a CLI
`--output` override resolves against the caller's working directory.

## Serve mode (IDE integrations)

`npm run tokens:sync -- serve --port 8765` keeps the bridge running and speaks JSON lines on
stdio, so the integrated [Dex Figma Tokens IDE plugin](../android_studio_plugin/README.md) can show live
status and trigger syncs without a process per run. The plugin sends a `hello`
(file key + name) on connect, so status includes which Figma file is attached.

Each message is one JSON object per line. For example, the host sends:

```jsonl
{"cmd":"sync","id":"1","config":{"output":"/app/tokens","package":"com.example.tokens"},"dryRun":false}
{"cmd":"shutdown"}
```

A `sync` with `"skipIfUnchanged":true` skips code generation (`result.skipped: true`) when
the tokens are byte-identical to the last run and the generator settings are unchanged
(tracked in a `<tokensJson>.stamp` file). With `"useLocal":true` the bridge does not ask the
Figma plugin at all and generates from the previously saved `tokensJson` document.

The bridge emits `status` (`bridge`, `port`, `plugins`, or an error
`message`), `log` (`id`, `level`, `text`), `result` (`id`, `exitCode`,
`tokensChanged`, `skipped`, `version`, `fileKey`), and `error` (`id` when available,
`code`, `message`) objects. Sync commands may also carry `check` and
`timeoutMs` (default 120000); relative config paths in serve mode resolve
against the bridge process's working directory.

`npm run bundle --workspace=@figma-exporter/bridge` builds a dependency-free
`bridge/dist/tokens-sync.cjs` (bridge + generator) runnable with a plain `node`.

```bash
node bridge/dist/tokens-sync.cjs serve --port 8765
```

The IDE's **Build Generator** button builds this bridge bundle, not the
file-input-only `codegen/tokens/dist/codegen-tokens.cjs` bundle. Rebuild
after pulling changes to the bridge or its workspace dependencies.
Only one bridge may own port 8765 at a time: stop a standalone CLI run
before starting the IDE bridge (or vice versa). The Figma plugin's URL and
development manifest currently use that port.

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
