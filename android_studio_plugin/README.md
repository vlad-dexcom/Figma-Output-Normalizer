# Dex Figma Tokens — Android Studio plugin

Generates Kotlin design-token source straight from the open Figma file, without leaving the IDE
and without exporting or picking any file.

This plugin is part of the [Figma Exporter repository](../README.md), under
`android_studio_plugin/`; it is no longer a separate Git project.

The IDE runs this repository's local **bridge** ([`bridge/`](../bridge/README.md)),
which the Figma plugin connects to over `ws://localhost:8765`. On
**Generate**, the bridge asks the Figma plugin for the file's tokens and runs the Kotlin generator
on them. Point this plugin at a local checkout of that repo, build the bridge once, open the
design-system file in Figma with the plugin running, and press **Generate**.

## Features

- **Live status** of the bridge and of the Figma plugin (which file is connected). **Generate** is
  enabled only when a Figma file is connected and ready, so you know when a refresh will work
- No tokens file to export or pick: tokens are pulled from Figma on every **Generate**
- The Figma file is detected automatically from the running Figma plugin (a dropdown appears if several files are connected)
- Tool window form for the repo checkout, output directory, package and class prefix
- **Build Generator** builds the standalone bridge bundle once (or after pulling repo changes),
  so day-to-day runs need only a plain `node` — no `npm install`, no workspace resolution
- Live log console (stdout as info, stderr as error), and a cancellable background task
- **Dry run** — see exactly what would be generated without writing a single file
- **`--layout legacy`** toggle for consumers still coupled to the old per-branch package shape
- **`--exclude-mode`** field for excluding modes by regex
- **Unresolved token overrides** field for `--on-unresolved <reason>=<silent|warn|fail>` — override
  the generator's default triage for a specific reason code on a run that genuinely expects some
  unresolved tokens (e.g. a first pass over a messy export); a **Build…** button opens a small
  dropdown-based wizard so you don't have to type the `reason=action` syntax by hand
- **Restart Bridge** and **Check Environment** (npm, node, the configured checkout)
- `Tools → Figma Tokens → Generate Design Tokens` menu actions
- Automatic VFS refresh and a notification when generation completes

## Requirements

- Android Studio / IntelliJ IDEA **2024.3** or newer
- **Node.js with npm** on `PATH` (or set an explicit npm path in the tool window; `node` is
  expected in the same folder)
- A local checkout of the exporter repository (`vlad-dexcom/Figma-Output-Normalizer`),
  whose npm packages use the `@figma-exporter` scope
- Figma desktop with that repo's Figma plugin imported (**Plugins → Development → Import plugin
  from manifest…**, rebuilt from the same checkout so it includes the bridge client)

Press **Check Environment** in the tool window to validate all of the above.

## Building

This Gradle project lives in the exporter's `android_studio_plugin/` directory and shares
the exporter's Git repository; it is not a separate repository or npm workspace.
Run these commands from the exporter root:

Building the IDE plugin requires **JDK 21**. If your default Java version differs,
set `JAVA_HOME` to a JDK 21 installation (on macOS: `export JAVA_HOME=$(/usr/libexec/java_home -v 21)`).
The Gradle wrapper is included; no separate Gradle installation is needed.

```bash
cd android_studio_plugin
./gradlew buildPlugin     # produces build/distributions/dex-figma-tokens-plugin-<version>.zip
./gradlew test            # unit + platform tests
./gradlew runIde          # launch a sandbox IDE with the plugin installed
```

## Installing

In Android Studio: **Settings → Plugins → ⚙ → Install Plugin from Disk…** and pick the zip from
`build/distributions/`.
From the exporter root, that path is
`android_studio_plugin/build/distributions/dex-figma-tokens-plugin-<version>.zip`.
After installing an updated ZIP, restart the IDE to load the new plugin code.

## Usage

1. Open the **Figma Tokens** tool window (right-hand side bar).
2. Set **Generator repository** to the exporter checkout's **root**, containing
   `package.json` and `bridge/package.json`, not `android_studio_plugin/` or `bridge/`.
   This is mandatory — the IDE plugin ZIP does not include the generator.
3. Press **Build Generator**. This runs `npm install` (only if needed) and
   `npm run bundle --workspace=@figma-exporter/bridge` in that checkout, producing
   `bridge/dist/tokens-sync.cjs`. Re-run this after pulling changes to that repo. The bridge then
   starts automatically and **Bridge** shows "Listening on localhost:8765".
4. In Figma desktop, open the design-system file and run **Plugins → Development → Figma
   Exporter**. **Figma plugin** turns green ("Connected — <file>. Ready to generate.").
5. Pick the output directory (defaults to the module's `src/main/java`) and the package.
6. Optionally set a class prefix (e.g. `DS`), an `--exclude-mode` regex,
   unresolved-token overrides (type them directly, or press **Build…** next to the field), and
   the legacy layout toggle.
7. Press **Generate**, or tick **Dry run** first to preview.

Under the hood the IDE keeps `node bridge/dist/tokens-sync.cjs serve --port 8765` running (JSON
lines on stdio: live status out, sync commands in). **Generate** sends it a sync command built from
the form; the bridge fetches the tokens from the Figma plugin, saves the last document to
`.idea/dexFigmaTokens/figma.tokens.json`, and runs the generator. Only **Build Generator** itself
needs npm. Port 8765 is fixed (it must match the Figma plugin's manifest); a second IDE window
using it shows "Port 8765 is already in use".

## Troubleshooting

| Symptom | Fix |
|---|---|
| "No npm executable was found" | Install Node.js, or set an explicit npm path in the tool window (used by **Build Generator**); **Check Environment** also suggests an OS-specific install command (e.g. `brew install node`, `winget install -e --id OpenJS.NodeJS.LTS`, or an `apt`/`dnf`/`pacman` command on Linux) |
| "No node executable was found on PATH" | Install Node.js (or make sure `node` sits next to the configured npm path); same install-command suggestion as above applies |
| "Generator repository path is required" | Set **Generator repository** to a `Figma-Output-Normalizer` checkout |
| "No 'bridge/package.json' found under …" | The path isn't the repo root, isn't that repo, or the checkout predates the bridge (pull the latest) |
| "does not declare the '@figma-exporter/bridge' workspace" | Wrong repo, or a stale/renamed checkout |
| "does not declare the '@figma-normalizator/bridge' workspace" | An older IDE plugin is installed; rebuild/install the current plugin ZIP and restart the IDE. Do not rename the exporter workspace to match the stale plugin |
| "No prebuilt generator found at …" | Press **Build Generator** (or accept the prompt offered after a failed run) |
| Figma plugin stays "Waiting" | Rebuild and re-import the Figma plugin from the same checkout, open the file and run it (it retries every 2 s); the bridge must show "Listening" |
| Bridge shows "Port 8765 is already in use" | Another IDE window or a `tokens:sync` run holds the port; close it, then **Restart Bridge** |
| Generation writes nothing | **Dry run** is ticked — untick it |
| Nothing appears in the Project view | The output directory is outside the project; pick a path under a content root |

## Git and build boundaries

Commit IDE plugin changes through the exporter repository. There should be no
`android_studio_plugin/.git` directory and no Git submodule for this folder.
When opening the Gradle project on its own, the IDE's Git directory mapping
should point to the parent exporter root.

The plugin's `.gitignore` excludes Gradle caches, build outputs, local properties,
and IDE metadata, while keeping the Gradle wrapper (including its JAR) in source.
Root npm commands and the current GitHub Actions workflow do not run this project's
Gradle build or tests; use the commands above for Kotlin changes.

## Project layout

```
build.gradle.kts                       # IntelliJ Platform plugin build
src/main/kotlin/com/dex/figmatokens/
├── settings/    # persisted config (repo path, output, package, flags)
├── bridge/      # bridge process lifecycle, JSON-lines protocol, readiness (status) logic
├── node/        # npm/node detection, generator-repo checkout and bundle validation
├── run/         # serve command + sync config, bundle building, generation orchestration
├── ui/          # tool window, form, console
└── actions/     # Tools-menu actions
```
