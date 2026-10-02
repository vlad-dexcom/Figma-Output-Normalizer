package com.dex.figmatokens.ui

import com.dex.figmatokens.bridge.BridgeService
import com.dex.figmatokens.bridge.BridgeState
import com.dex.figmatokens.bridge.PluginConnection
import com.dex.figmatokens.bridge.Readiness
import com.dex.figmatokens.bridge.ReadinessEvaluator
import com.dex.figmatokens.node.CodegenRepoResolver
import com.dex.figmatokens.node.NodeInstaller
import com.dex.figmatokens.node.NodeLocator
import com.dex.figmatokens.run.GeneratorResult
import com.dex.figmatokens.run.GeneratorRunner
import com.dex.figmatokens.settings.FigmaTokensSettings
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.application.ModalityState
import com.intellij.openapi.fileChooser.FileChooserDescriptorFactory
import com.intellij.openapi.progress.ProgressIndicator
import com.intellij.openapi.progress.ProgressManager
import com.intellij.openapi.progress.Task
import com.intellij.openapi.project.Project
import com.intellij.openapi.roots.ProjectRootManager
import com.intellij.openapi.ui.ComboBox
import com.intellij.openapi.ui.Messages
import com.intellij.openapi.ui.TextFieldWithBrowseButton
import com.intellij.ui.SimpleListCellRenderer
import com.intellij.ui.components.JBCheckBox
import com.intellij.ui.components.JBLabel
import com.intellij.ui.components.JBTextField
import com.intellij.ui.dsl.builder.AlignX
import com.intellij.ui.dsl.builder.RightGap
import com.intellij.ui.dsl.builder.panel
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.nio.file.Files
import javax.swing.JButton
import javax.swing.JComponent
import javax.swing.JPanel

/** The Figma Tokens tool window: configuration form, action buttons and a log console. */
class FigmaTokensPanel(private val project: Project, parent: Disposable) : JPanel(BorderLayout()) {

    private val settings = FigmaTokensSettings.getInstance(project)
    private val console = GeneratorConsole(project, parent)

    private val repoField = TextFieldWithBrowseButton()
    private val fileCombo = ComboBox<PluginConnection>().apply {
        renderer = SimpleListCellRenderer.create("") { it.fileName?.takeIf { n -> n.isNotBlank() } ?: it.fileKey ?: "Unknown file" }
    }
    private val fileKeyLabel = JBLabel()
    private var updatingFileCombo = false
    private val outputField = TextFieldWithBrowseButton()
    private val packageField = JBTextField()
    private val prefixField = JBTextField()
    private val npmField = TextFieldWithBrowseButton()
    private val excludeModeField = JBTextField()
    private val onUnresolvedField = JBTextField()
    private val legacyLayoutCheckBox = JBCheckBox("Legacy layout (--layout legacy; matches the old per-branch package shape)")
    private val dryRunCheckBox = JBCheckBox("Dry run (show what would be generated, write nothing)")

    private val alwaysRegenerateCheckBox = JBCheckBox("Always regenerate (don't skip when tokens and settings are unchanged)")
    private val useLocalTokensCheckBox = JBCheckBox("Use the previously downloaded tokens instead of downloading fresh ones from Figma")
    private val localTokensLabel = JBLabel()

    private val bridgeStatusLabel = JBLabel()
    private val pluginStatusLabel = JBLabel()
    private val bridge = BridgeService.getInstance(project)

    private var running = false

    private val generateButton = JButton("Generate")
    private val cancelButton = JButton("Cancel")

    init {
        setupBrowseButtons()
        loadState()
        generateButton.addActionListener { generate() }
        useLocalTokensCheckBox.addActionListener { refreshStatus(bridge.state) }
        cancelButton.addActionListener { GeneratorRunner.getInstance(project).cancel() }
        fileCombo.addActionListener {
            if (!updatingFileCombo) {
                bridge.selectedFileKey = (fileCombo.selectedItem as? PluginConnection)?.fileKey
                refreshStatus(bridge.state)
            }
        }
        bridge.addListener(parent) { state ->
            ApplicationManager.getApplication().invokeLater({ refreshStatus(state) }, ModalityState.any())
        }
        ApplicationManager.getApplication().executeOnPooledThread { bridge.startIfNeeded() }

        add(buildForm(), BorderLayout.NORTH)
        add(console.component, BorderLayout.CENTER)
        setRunning(false)
    }

    private fun buildForm(): JComponent = panel {
        row("Bridge:") {
            cell(bridgeStatusLabel).gap(RightGap.SMALL)
            button("Restart Bridge") { restartBridge() }
        }
        row("Figma plugin:") {
            cell(pluginStatusLabel)
        }
        row("Generator repository:") {
            cell(repoField).align(AlignX.FILL)
                .comment(
                    "Required. A local checkout of Figma-Output-Normalizer. Use \"Build " +
                        "Generator\" below once (or after pulling changes) to build the " +
                        "standalone generator bundle this plugin runs."
                )
        }
        row("Figma file:") {
            cell(fileCombo).gap(RightGap.SMALL)
            cell(fileKeyLabel)
        }.rowComment("Detected from the Figma plugin that is running. To use another file, open it in Figma and run the plugin there.")
        row("Output directory:") {
            cell(outputField).align(AlignX.FILL)
        }
        row("Package:") {
            cell(packageField).align(AlignX.FILL)
        }
        row("Class prefix:") {
            cell(prefixField).align(AlignX.FILL)
                .comment("Optional. Prepended to every generated root class name.")
        }
        row("Exclude mode pattern:") {
            cell(excludeModeField).align(AlignX.FILL)
                .comment("Optional regex (--exclude-mode), e.g. \"ios\" to skip iOS-only modes.")
        }
        row("Unresolved token overrides:") {
            cell(onUnresolvedField).align(AlignX.FILL).gap(RightGap.SMALL)
            button("Build…") { openOnUnresolvedWizard() }
        }.rowComment(
            "Optional, space/comma-separated \"reason=action\" pairs (one --on-unresolved " +
                "flag per entry), e.g. \"unsupported-value=warn\" for a run that genuinely " +
                "expects some unresolved tokens, or press \"Build…\" to compose them from " +
                "dropdowns instead of typing them."
        )
        row("npm executable:") {
            cell(npmField).align(AlignX.FILL)
                .comment(
                    "Optional. Only used by \"Build Generator\" below; leave blank to " +
                        "auto-detect npm (and node, expected alongside it) on PATH."
                )
        }
        row {
            cell(legacyLayoutCheckBox)
        }
        row {
            cell(dryRunCheckBox)
        }
        row {
            cell(alwaysRegenerateCheckBox)
        }
        row {
            cell(useLocalTokensCheckBox).gap(RightGap.SMALL)
            cell(localTokensLabel)
        }
        row {
            cell(generateButton).gap(RightGap.SMALL)
            cell(cancelButton).gap(RightGap.SMALL)
            button("Build Generator") { buildGenerator() }.gap(RightGap.SMALL)
            button("Check Environment") { checkEnvironment() }
        }
    }.apply { border = JBUI.Borders.empty(8) }

    private fun setupBrowseButtons() {
        repoField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory.createSingleFolderDescriptor()
                .withTitle("Select Figma-Output-Normalizer Checkout"),
        )
        outputField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory.createSingleFolderDescriptor()
                .withTitle("Select Output Directory"),
        )
        npmField.addBrowseFolderListener(
            project,
            FileChooserDescriptorFactory.createSingleFileDescriptor()
                .withTitle("Select npm Executable"),
        )
    }

    private fun loadState() {
        val state = settings.state
        repoField.text = state.repoPath
        outputField.text = state.outputDir.ifBlank { defaultOutputDir() }
        packageField.text = state.packageName.ifBlank { "com.example.tokens" }
        prefixField.text = state.classPrefix
        excludeModeField.text = state.excludeModePattern
        onUnresolvedField.text = state.onUnresolvedOverrides
        npmField.text = state.npmPath
        legacyLayoutCheckBox.isSelected = state.legacyLayout
        dryRunCheckBox.isSelected = state.dryRun
        alwaysRegenerateCheckBox.isSelected = state.alwaysRegenerate
        useLocalTokensCheckBox.isSelected = state.useLocalTokens
    }

    private fun saveState() {
        val state = settings.state
        state.repoPath = repoField.text.trim()
        state.outputDir = outputField.text.trim()
        state.packageName = packageField.text.trim()
        state.classPrefix = prefixField.text.trim()
        state.excludeModePattern = excludeModeField.text.trim()
        state.onUnresolvedOverrides = onUnresolvedField.text.trim()
        state.npmPath = npmField.text.trim()
        state.legacyLayout = legacyLayoutCheckBox.isSelected
        state.dryRun = dryRunCheckBox.isSelected
        state.alwaysRegenerate = alwaysRegenerateCheckBox.isSelected
        state.useLocalTokens = useLocalTokensCheckBox.isSelected
    }

    /** Runs with the current form values, saving them first. */
    fun generate(dryRunOverride: Boolean? = null) {
        if (dryRunOverride != null) {
            dryRunCheckBox.isSelected = dryRunOverride
        }
        saveState()

        val runner = GeneratorRunner.getInstance(project)
        if (runner.isRunning) {
            Messages.showInfoMessage(project, "A generation run is already in progress.", "Figma Tokens")
            return
        }
        setRunning(true)
        runner.run(console) { result ->
            setRunning(false)
            if (result is GeneratorResult.Failure) {
                offerBuildGenerator(result.message)
            }
        }
    }

    /** Runs "Build Generator" (npm install + npm run bundle) with the current repo path. */
    private fun buildGenerator() {
        saveState()
        val runner = GeneratorRunner.getInstance(project)
        if (runner.isRunning) {
            Messages.showInfoMessage(project, "A generation run is already in progress.", "Figma Tokens")
            return
        }
        setRunning(true)
        runner.buildBundle(console) { setRunning(false) }
    }

    private fun setRunning(running: Boolean) {
        this.running = running
        cancelButton.isEnabled = running
        refreshStatus(bridge.state)
    }

    private fun restartBridge() {
        saveState()
        ApplicationManager.getApplication().executeOnPooledThread { bridge.restart() }
    }

    /** Renders bridge + plugin status and enables Generate only when a Figma file is connected and ready. */
    private fun refreshStatus(state: BridgeState) {
        val readiness = ReadinessEvaluator.evaluate(state, bridge.selectedFileKey)
        updateFileSelector(state, (readiness as? Readiness.Ready)?.file)

        bridgeStatusLabel.text = when (state) {
            is BridgeState.Listening -> status(GREEN, "Listening on localhost:${state.port}")
            BridgeState.Starting -> status(AMBER, "Starting…")
            is BridgeState.Failed -> status(RED, state.message)
            is BridgeState.Stopped -> status(GRAY, state.reason ?: "Stopped")
        }
        pluginStatusLabel.text = when (readiness) {
            is Readiness.Ready -> status(GREEN, "Connected — ${readiness.file.fileName ?: readiness.file.fileKey ?: "Figma file"}. Ready to generate.")
            Readiness.WaitingForPlugin -> status(AMBER, ReadinessEvaluator.describe(readiness))
            is Readiness.BridgeDown -> status(GRAY, "Not available until the bridge is running.")
        }
        val localTokens = GeneratorRunner.tokensJsonPath(project)
        val localExists = Files.isRegularFile(localTokens)
        useLocalTokensCheckBox.isEnabled = localExists && !running
        localTokensLabel.text = if (localExists) {
            "(downloaded ${Files.getLastModifiedTime(localTokens).toString().substringBefore('.').replace('T', ' ')} UTC)"
        } else {
            "(nothing downloaded yet)"
        }
        val useLocal = localExists && useLocalTokensCheckBox.isSelected
        val canGenerate = if (useLocal) state is BridgeState.Listening else readiness.isReady
        generateButton.isEnabled = !running && canGenerate
        generateButton.toolTipText =
            if (canGenerate) null else ReadinessEvaluator.describe(readiness)
    }

    private fun updateFileSelector(state: BridgeState, selected: PluginConnection?) {
        val plugins = (state as? BridgeState.Listening)?.plugins.orEmpty()
        updatingFileCombo = true
        try {
            val current = (0 until fileCombo.itemCount).map { fileCombo.getItemAt(it) }
            if (current != plugins) {
                fileCombo.removeAllItems()
                plugins.forEach { fileCombo.addItem(it) }
            }
            fileCombo.selectedItem = selected
        } finally {
            updatingFileCombo = false
        }
        fileCombo.isEnabled = plugins.size > 1
        fileKeyLabel.text = selected?.fileKey?.let { "($it)" } ?: ""
    }

    private fun status(color: String, text: String): String =
        "<html><span style='color:$color'>●</span> ${escape(text)}</html>"

    private fun escape(text: String): String =
        text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")

    /** Opens the dropdown-based wizard for composing "Unresolved token overrides", seeded from the field. */
    private fun openOnUnresolvedWizard() {
        val result = OnUnresolvedOverridesDialog.showAndGet(project, onUnresolvedField.text) ?: return
        onUnresolvedField.text = result
    }

    private fun checkEnvironment() {
        NodeLocator.clearCache()
        val npmOverride = npmField.text.trim().takeIf { it.isNotEmpty() }
        val repoPath = repoField.text.trim()
        ProgressManager.getInstance().run(object : Task.Backgroundable(project, "Checking environment", false) {
            override fun run(indicator: ProgressIndicator) {
                val npm = NodeLocator.locate(npmOverride, useCache = false)
                val npmMessage = if (npm == null) {
                    "No npm executable found. Install Node.js, or set an explicit path above." +
                        installSuggestion()
                } else {
                    "npm ${npm.version} at ${npm.path}"
                }
                val node = NodeLocator.locateNode(useCache = false)
                val nodeMessage = if (node == null) {
                    "No node executable found. Install Node.js." + installSuggestion()
                } else {
                    "node ${node.version} at ${node.path}"
                }
                val repoMessage = describeRepo(repoPath)
                ApplicationManager.getApplication().invokeLater {
                    console.system(npmMessage)
                    console.system(nodeMessage)
                    console.system(repoMessage)
                }
            }
        })
    }

    /** A "Try: <command>" hint shown next to npm/node-missing messages, when a suggestion is known. */
    private fun installSuggestion(): String {
        val command = NodeInstaller.suggestedCommand()
        return if (command != null) " Try: $command" else " Download from ${NodeInstaller.MANUAL_DOWNLOAD_URL}"
    }

    /** Reports whether the configured repo path is a usable checkout, so a bad path is caught early. */
    private fun describeRepo(repoPath: String): String {
        if (repoPath.isEmpty()) return "Generator repository: not set (required)."
        val problem = CodegenRepoResolver.problemWith(repoPath)
        if (problem != null) return "Generator repository: unusable — $problem"
        val root = CodegenRepoResolver.resolve(repoPath)
        return if (CodegenRepoResolver.bundleBuilt(root)) {
            "Generator repository: $root (generator bundle built at ${CodegenRepoResolver.bundlePath(root)})"
        } else {
            "Generator repository: $root — no generator bundle built yet; use \"Build Generator\"."
        }
    }

    /** When a run failed because the bundle isn't built yet, offer to build it for the user. */
    private fun offerBuildGenerator(message: String) {
        if (!message.contains("Build Generator")) return
        val answer = Messages.showYesNoDialog(
            project,
            "Build the generator now? This runs 'npm install' and 'npm run bundle' in the " +
                "configured checkout.",
            "Figma Tokens",
            "Build",
            "Cancel",
            Messages.getQuestionIcon(),
        )
        if (answer != Messages.YES) return
        buildGenerator()
    }

    /** Best guess at where generated Kotlin should live: the first `src/main/java` content root. */
    private fun defaultOutputDir(): String {
        val roots = ProjectRootManager.getInstance(project).contentSourceRoots
        val preferred = roots.firstOrNull { it.path.endsWith("src/main/java") || it.path.endsWith("src/main/kotlin") }
        return preferred?.path ?: roots.firstOrNull()?.path ?: project.basePath.orEmpty()
    }

    private companion object {
        const val GREEN = "#59A869"
        const val AMBER = "#E0A030"
        const val RED = "#DB5C5C"
        const val GRAY = "#8C8C8C"
    }
}
