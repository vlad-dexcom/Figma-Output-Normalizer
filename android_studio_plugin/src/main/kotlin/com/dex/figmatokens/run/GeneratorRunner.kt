package com.dex.figmatokens.run

import com.dex.figmatokens.bridge.BridgeService
import com.dex.figmatokens.bridge.BridgeState
import com.dex.figmatokens.bridge.Readiness
import com.dex.figmatokens.bridge.ReadinessEvaluator
import com.dex.figmatokens.node.CodegenRepoResolver
import com.dex.figmatokens.node.NodeInstaller
import com.dex.figmatokens.node.NodeLocator
import com.dex.figmatokens.settings.FigmaTokensSettings
import com.dex.figmatokens.settings.FigmaTokensState
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.notification.NotificationGroupManager
import com.intellij.notification.NotificationType
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import com.intellij.openapi.vfs.LocalFileSystem
import com.intellij.openapi.vfs.VfsUtil
import java.io.File
import java.nio.file.Path
import java.util.concurrent.atomic.AtomicBoolean

/** Runs the `codegen/tokens` CLI as a background task and streams its output to a [GeneratorLog]. */
@Service(Service.Level.PROJECT)
class GeneratorRunner(private val project: Project) {

    private val running = AtomicBoolean(false)

    @Volatile
    private var currentHandler: OSProcessHandler? = null

    @Volatile
    private var currentIndicator: ProgressIndicator? = null

    val isRunning: Boolean get() = running.get()

    fun run(log: GeneratorLog, onFinished: (GeneratorResult) -> Unit) {
        if (!running.compareAndSet(false, true)) {
            log.error("A generation run is already in progress.")
            return
        }
        val state = FigmaTokensSettings.getInstance(project).state.copy()
        val title = if (state.dryRun) "Figma tokens: dry run" else "Generating design tokens"

        ProgressManager.getInstance().run(object : Task.Backgroundable(project, title, true) {
            override fun run(indicator: ProgressIndicator) {
                currentIndicator = indicator
                val result = try {
                    execute(state, log, indicator)
                } catch (e: Throwable) {
                    LOG.warn("Token generation failed", e)
                    log.error(e.message ?: e.toString())
                    GeneratorResult.Failure(-1, e.message ?: "Unexpected error")
                } finally {
                    currentHandler = null
                    currentIndicator = null
                    running.set(false)
                }
                notify(state, result)
                ApplicationManager.getApplication().invokeLater { onFinished(result) }
            }
        })
    }

    fun cancel() {
        currentIndicator?.cancel()
        currentHandler?.destroyProcess()
    }

    /**
     * Builds the standalone generator bundle in the configured repo checkout: `npm install`
     * (only if `node_modules` is missing) followed by
     * `npm run bundle --workspace=${CodegenRepoResolver.WORKSPACE_NAME}`. Used by the tool
     * window's "Build Generator" button when [execute] reports the bundle is missing.
     */
    fun buildBundle(log: GeneratorLog, onFinished: (Boolean) -> Unit) {
        if (!running.compareAndSet(false, true)) {
            log.error("A generation run is already in progress.")
            return
        }
        val state = FigmaTokensSettings.getInstance(project).state.copy()
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Building generator", true) {
            override fun run(indicator: ProgressIndicator) {
                currentIndicator = indicator
                val success = try {
                    doBuildBundle(state, log, indicator)
                } catch (e: Throwable) {
                    LOG.warn("Building the generator bundle failed", e)
                    log.error(e.message ?: e.toString())
                    false
                } finally {
                    currentHandler = null
                    currentIndicator = null
                    running.set(false)
                }
                ApplicationManager.getApplication().invokeLater { onFinished(success) }
            }
        })
    }

    private fun doBuildBundle(state: FigmaTokensState, log: GeneratorLog, indicator: ProgressIndicator): Boolean {
        log.clear()
        indicator.isIndeterminate = true

        indicator.text = "Validating generator repository"
        val repoRoot: Path = try {
            CodegenRepoResolver.resolve(state.repoPath)
        } catch (e: CodegenRepoResolver.InvalidRepoException) {
            log.error(e.message ?: "Invalid generator repository path")
            return false
        }

        indicator.text = "Locating npm"
        val npm = NodeLocator.locate(state.npmPath.takeIf { it.isNotBlank() })
        if (npm == null) {
            log.error(
                "No npm executable was found. Install Node.js, or set an explicit npm path " +
                    "in the Figma Tokens tool window." + installSuggestionSuffix()
            )
            return false
        }
        log.system("npm ${npm.version} at ${npm.path}")

        if (!CodegenRepoResolver.dependenciesInstalled(repoRoot)) {
            indicator.text = "Running npm install"
            if (!runStreaming(npm.path, listOf("install"), repoRoot, log, indicator)) return false
        }

        indicator.text = "Running npm run bundle"
        if (!runStreaming(
                npm.path,
                listOf("run", "bundle", "--workspace", CodegenRepoResolver.WORKSPACE_NAME),
                repoRoot,
                log,
                indicator,
            )
        ) {
            return false
        }

        log.system("Generator built at ${CodegenRepoResolver.bundlePath(repoRoot)}.")
        // A running bridge still executes the old bundle; restart it so status and syncs use the new one.
        BridgeService.getInstance(project).restart()
        return true
    }

    private fun runStreaming(
        exePath: String,
        args: List<String>,
        workingDirectory: Path,
        log: GeneratorLog,
        indicator: ProgressIndicator,
    ): Boolean {
        val commandLine = com.intellij.execution.configurations.GeneralCommandLine(exePath)
            .withParameters(args)
            .withWorkingDirectory(workingDirectory)
            .withCharset(Charsets.UTF_8)
        log.system("$ ${(listOf(exePath) + args).joinToString(" ")}")

        val handler = OSProcessHandler(commandLine)
        currentHandler = handler
        handler.addProcessListener(object : ProcessAdapter() {
            override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
                val raw = event.text.trimEnd('\n', '\r')
                if (raw.isBlank()) return
                val level = LogLineClassifier.levelOf(raw, outputType == ProcessOutputTypes.STDERR)
                indicator.text2 = raw.take(120)
                log.append(raw, level)
            }
        })
        handler.startNotify()

        while (!handler.waitFor(POLL_INTERVAL_MS)) {
            if (indicator.isCanceled) {
                handler.destroyProcess()
                handler.waitFor(POLL_INTERVAL_MS)
                log.system("Cancelled.")
                return false
            }
        }
        if (indicator.isCanceled) return false

        val exitCode = handler.exitCode ?: -1
        if (exitCode != 0) {
            log.error("${(listOf(exePath) + args).joinToString(" ")} failed (exit code $exitCode).")
            return false
        }
        return true
    }

    private fun execute(
        state: FigmaTokensState,
        log: GeneratorLog,
        indicator: ProgressIndicator,
    ): GeneratorResult {
        log.clear()
        indicator.isIndeterminate = true

        indicator.text = "Validating generator repository"
        val repoRoot: Path = try {
            CodegenRepoResolver.resolve(state.repoPath)
        } catch (e: CodegenRepoResolver.InvalidRepoException) {
            return failWith(log, e.message ?: "Invalid generator repository path")
        }
        log.system("Using generator repository at $repoRoot")
        if (!CodegenRepoResolver.bundleBuilt(repoRoot)) {
            return failWith(log, bundleMissingMessage(repoRoot))
        }

        val bridge = BridgeService.getInstance(project)
        indicator.text = "Checking the Figma bridge"
        bridge.startIfNeeded()
        awaitBridgeSettled(bridge, indicator)
        val readiness = ReadinessEvaluator.evaluate(bridge.state, bridge.selectedFileKey)
        if (readiness !is Readiness.Ready) {
            return failWith(log, ReadinessEvaluator.describe(readiness))
        }

        val config = try {
            GeneratorCommandBuilder.buildSyncConfig(state, tokensJsonPath(repoRoot), readiness.file.fileKey)
        } catch (e: GeneratorCommandBuilder.InvalidConfigurationException) {
            return failWith(log, e.message ?: "Invalid configuration")
        }

        log.system("Fetching tokens from ${readiness.file.fileName ?: "the connected Figma file"} through the bridge…")
        indicator.text = "Generating design tokens"
        return when (val result = bridge.sync(config, state.dryRun, log, indicator)) {
            is GeneratorResult.Success -> {
                if (!state.dryRun) refreshOutput(state.outputDir)
                log.system(if (state.dryRun) "Dry run finished." else "Done.")
                GeneratorResult.Success(state.dryRun, result.warnings)
            }
            is GeneratorResult.Failure -> {
                log.error("Failed.")
                result
            }
            GeneratorResult.Cancelled -> result
        }
    }

    /** Where the bridge keeps the last fetched token document (handy for diffing what changed in Figma). */
    private fun tokensJsonPath(repoRoot: Path): Path =
        Path.of(project.basePath ?: repoRoot.toString()).resolve(".idea/dexFigmaTokens/figma.tokens.json")

    /** Gives a just-started bridge a few seconds to report that it is listening (or that it failed). */
    private fun awaitBridgeSettled(bridge: BridgeService, indicator: ProgressIndicator) {
        val deadline = System.currentTimeMillis() + BRIDGE_START_TIMEOUT_MS
        while (bridge.state is BridgeState.Starting && System.currentTimeMillis() < deadline) {
            if (indicator.isCanceled) return
            Thread.sleep(POLL_INTERVAL_MS / 2)
        }
    }

    private fun failWith(log: GeneratorLog, message: String): GeneratorResult {
        log.error(message)
        return GeneratorResult.Failure(-1, message.lineSequence().first())
    }

    /** A "Try: <command>" hint appended to npm/node-missing messages, when a suggestion is known. */
    private fun installSuggestionSuffix(): String {
        val command = NodeInstaller.suggestedCommand()
        return if (command != null) {
            "\nTry running this in a terminal:\n  $command"
        } else {
            "\nDownload an installer from ${NodeInstaller.MANUAL_DOWNLOAD_URL}"
        }
    }

    private fun bundleMissingMessage(repoRoot: Path): String =
        "No prebuilt generator (bridge) found at ${CodegenRepoResolver.bundlePath(repoRoot)}. Use " +
            "'Build Generator' in the tool window to build it (runs 'npm install' and " +
            "'npm run bundle --workspace=${CodegenRepoResolver.WORKSPACE_NAME}')."

    private fun refreshOutput(outputDir: String) {
        val file = File(outputDir)
        if (!file.exists()) return
        val virtualFile = LocalFileSystem.getInstance().refreshAndFindFileByIoFile(file) ?: return
        VfsUtil.markDirtyAndRefresh(false, true, true, virtualFile)
    }

    private fun notify(state: FigmaTokensState, result: GeneratorResult) {
        val group = NotificationGroupManager.getInstance().getNotificationGroup(NOTIFICATION_GROUP)
        val notification = when (result) {
            is GeneratorResult.Success -> {
                val suffix = if (result.warnings.isEmpty()) "" else " (${result.warnings.size} warning(s))"
                val text = if (result.dryRun) {
                    "Dry run completed$suffix. No files were written."
                } else {
                    "Design tokens generated into ${state.outputDir}$suffix"
                }
                group.createNotification("Figma tokens", text, NotificationType.INFORMATION)
            }
            is GeneratorResult.Failure ->
                group.createNotification("Figma tokens failed", result.message, NotificationType.ERROR)
            GeneratorResult.Cancelled ->
                group.createNotification("Figma tokens", "Generation cancelled.", NotificationType.INFORMATION)
        }
        notification.notify(project)
    }

    companion object {
        private val LOG = logger<GeneratorRunner>()
        private const val POLL_INTERVAL_MS = 200L
        private const val BRIDGE_START_TIMEOUT_MS = 5_000L
        const val NOTIFICATION_GROUP = "DexFigmaTokens"

        fun getInstance(project: Project): GeneratorRunner = project.service()
    }
}
