package com.dex.figmatokens.bridge

import com.dex.figmatokens.node.CodegenRepoResolver
import com.dex.figmatokens.node.NodeLocator
import com.dex.figmatokens.run.GeneratorCommandBuilder
import com.dex.figmatokens.run.GeneratorLog
import com.dex.figmatokens.run.GeneratorResult
import com.dex.figmatokens.run.LogLevel
import com.dex.figmatokens.run.LogLineClassifier
import com.dex.figmatokens.settings.FigmaTokensSettings
import com.intellij.execution.process.OSProcessHandler
import com.intellij.execution.process.ProcessAdapter
import com.intellij.execution.process.ProcessEvent
import com.intellij.execution.process.ProcessOutputTypes
import com.intellij.openapi.Disposable
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.service
import com.intellij.openapi.diagnostic.logger
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Key
import java.nio.file.Path
import java.util.UUID
import java.util.concurrent.CompletableFuture
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Owns the long-lived `tokens-sync serve` process (the local WebSocket bridge the Figma plugin
 * connects to), publishes its state so the tool window can show it, and runs syncs through it.
 */
@Service(Service.Level.PROJECT)
class BridgeService(private val project: Project) : Disposable {

    private class PendingSync(val log: GeneratorLog) {
        val errors = CopyOnWriteArrayList<String>()
        val future = CompletableFuture<GeneratorResult>()
    }

    private val listeners = CopyOnWriteArrayList<(BridgeState) -> Unit>()
    private val pending = ConcurrentHashMap<String, PendingSync>()
    private val lock = Any()

    @Volatile
    var state: BridgeState = BridgeState.Stopped()
        private set

    @Volatile
    private var handler: OSProcessHandler? = null

    /** Key of the connected Figma file the user picked in the panel; null means the first connected one. */
    @Volatile
    var selectedFileKey: String? = null

    /** [listener] is called on a background thread for every state change; it is invoked once immediately. */
    fun addListener(parent: Disposable, listener: (BridgeState) -> Unit) {
        listeners += listener
        com.intellij.openapi.util.Disposer.register(parent) { listeners -= listener }
        listener(state)
    }

    /** Starts the bridge unless it is already running. Blocking (locates node); call off the EDT. */
    fun startIfNeeded(): BridgeState {
        synchronized(lock) {
            if (handler?.isProcessTerminated == false) return state
            val settings = FigmaTokensSettings.getInstance(project).state
            val repoRoot = try {
                CodegenRepoResolver.resolve(settings.repoPath)
            } catch (e: CodegenRepoResolver.InvalidRepoException) {
                return update(BridgeState.Stopped(e.message))
            }
            if (!CodegenRepoResolver.bundleBuilt(repoRoot)) {
                return update(BridgeState.Stopped("The generator isn't built yet. Press \"Build Generator\"."))
            }
            val node = NodeLocator.locateNode(NodeLocator.nodeOverrideFromNpmPath(settings.npmPath))
                ?: return update(BridgeState.Stopped("No node executable was found. Install Node.js."))

            update(BridgeState.Starting)
            val commandLine = GeneratorCommandBuilder.buildServeCommand(node, CodegenRepoResolver.bundlePath(repoRoot), BRIDGE_PORT)
            val process = try {
                OSProcessHandler(commandLine)
            } catch (e: Exception) {
                LOG.warn("Could not start the bridge", e)
                return update(BridgeState.Failed("Could not start the bridge: ${e.message}"))
            }
            handler = process
            process.addProcessListener(LineListener(process))
            process.startNotify()
            return state
        }
    }

    /** Stops the bridge process; a later [startIfNeeded] starts a fresh one. */
    fun stop() {
        val current = synchronized(lock) { handler.also { handler = null } } ?: return
        runCatching {
            current.processInput?.let {
                it.write((BridgeProtocol.shutdownCommand() + "\n").toByteArray())
                it.flush()
            }
        }
        if (!current.waitFor(1_000)) current.destroyProcess()
        update(BridgeState.Stopped())
    }

    fun restart(): BridgeState {
        stop()
        return startIfNeeded()
    }

    /**
     * Runs one sync through the bridge, blocking until it finishes, streaming the bridge's log to
     * [log]. Requires [state] to be [BridgeState.Listening]; the caller checks [Readiness] first.
     */
    fun sync(config: SyncRequestConfig, dryRun: Boolean, log: GeneratorLog, indicator: ProgressIndicator): GeneratorResult {
        val process = handler?.takeIf { !it.isProcessTerminated }
            ?: return GeneratorResult.Failure(-1, "The bridge is not running.")
        val id = UUID.randomUUID().toString()
        val request = PendingSync(log)
        pending[id] = request
        try {
            val input = process.processInput ?: return GeneratorResult.Failure(-1, "The bridge has no input stream.")
            input.write((BridgeProtocol.syncCommand(id, config, dryRun) + "\n").toByteArray())
            input.flush()
            while (true) {
                try {
                    return request.future.get(200, TimeUnit.MILLISECONDS)
                } catch (_: java.util.concurrent.TimeoutException) {
                    if (indicator.isCanceled) {
                        log.system("Cancelled.")
                        return GeneratorResult.Cancelled
                    }
                }
            }
        } finally {
            pending.remove(id)
        }
    }

    private fun update(newState: BridgeState): BridgeState {
        state = newState
        listeners.forEach { runCatching { it(newState) } }
        return newState
    }

    private fun handle(event: BridgeEvent) {
        when (event) {
            is BridgeEvent.Status -> update(
                if (event.listening) BridgeState.Listening(event.port ?: BRIDGE_PORT, event.plugins)
                else BridgeState.Failed(event.error ?: "The bridge failed to start."),
            )
            is BridgeEvent.Log -> pending[event.id]?.let { request ->
                val fromStderr = event.level == "error"
                val level = LogLineClassifier.levelOf(event.text, fromStderr)
                if (level == LogLevel.ERROR && event.text.isNotBlank()) request.errors += event.text
                if (event.text.isNotBlank()) request.log.append(event.text, level)
            }
            is BridgeEvent.Result -> pending[event.id]?.let { request ->
                request.future.complete(
                    if (event.exitCode == 0) {
                        GeneratorResult.Success(dryRun = false, warnings = emptyList())
                    } else {
                        GeneratorResult.Failure(event.exitCode, request.errors.lastOrNull() ?: "Generator exited with code ${event.exitCode}")
                    },
                )
            }
            is BridgeEvent.Failed -> {
                val request = event.id?.let { pending[it] }
                request?.log?.error(event.message)
                request?.future?.complete(GeneratorResult.Failure(-1, event.message))
            }
        }
    }

    private inner class LineListener(private val owner: OSProcessHandler) : ProcessAdapter() {
        private val buffer = StringBuilder()

        @Synchronized
        override fun onTextAvailable(event: ProcessEvent, outputType: Key<*>) {
            if (outputType == ProcessOutputTypes.STDERR) {
                // The bridge keeps stdout for protocol lines; stderr is diagnostics only.
                LOG.info("bridge stderr: ${event.text.trimEnd()}")
                return
            }
            buffer.append(event.text)
            while (true) {
                val newline = buffer.indexOf("\n")
                if (newline < 0) break
                val line = buffer.substring(0, newline)
                buffer.delete(0, newline + 1)
                BridgeProtocol.parse(line)?.let { handle(it) }
            }
        }

        override fun processTerminated(event: ProcessEvent) {
            // Ignore the exit of a process that stop()/restart() already replaced or discarded.
            if (handler === owner) {
                handler = null
                // A start failure already reported its own reason (e.g. port in use); keep it.
                if (state !is BridgeState.Failed) {
                    update(BridgeState.Stopped("The bridge exited (code ${event.exitCode})."))
                }
            }
            pending.values.forEach {
                it.future.complete(GeneratorResult.Failure(-1, "The bridge stopped while generating."))
            }
        }
    }

    override fun dispose() {
        stop()
    }

    companion object {
        private val LOG = logger<BridgeService>()

        fun getInstance(project: Project): BridgeService = project.service()
    }
}
