package com.dex.figmatokens.run

import com.dex.figmatokens.node.NodeExecutable
import com.dex.figmatokens.bridge.SyncRequestConfig
import com.dex.figmatokens.settings.FigmaTokensState
import com.intellij.execution.configurations.GeneralCommandLine
import java.nio.file.Path

/**
 * Builds the two things the bridge needs: the `node <bundle> serve` command that starts it, and
 * the sync config (from the plugin settings) sent to it on every Generate. Tokens are fetched from
 * the running Figma plugin over the bridge, so no `tokens.json` file is ever picked by hand.
 */
object GeneratorCommandBuilder {

    class InvalidConfigurationException(message: String) : IllegalArgumentException(message)

    /** Reason codes the CLI's `--on-unresolved` accepts (kept in sync with `input/unresolved.ts`). */
    val KNOWN_REASONS: List<String> = listOf(
        "excluded-by-policy",
        "excluded-collection-alias",
        "missing-alias-target",
        "unresolvable-alias-chain",
        "unsupported-value",
    )

    /** Actions the CLI's `--on-unresolved` accepts, in the order they should be offered. */
    val KNOWN_ACTIONS: List<String> = listOf("silent", "warn", "fail")

    /** `node <bundle> serve --port <port>`: the long-lived bridge (JSON lines on stdio). */
    fun buildServeCommand(node: NodeExecutable, bundlePath: Path, port: Int): GeneralCommandLine =
        GeneralCommandLine(node.path)
            .withParameters(bundlePath.toString(), "serve", "--port", port.toString())
            .withWorkingDirectory(bundlePath.parent)
            .withCharset(Charsets.UTF_8)

    /** Translates the settings into the bridge's sync config; [tokensJson] is where it saves the fetched document. */
    fun buildSyncConfig(state: FigmaTokensState, tokensJson: Path, fileKey: String? = null): SyncRequestConfig {
        validate(state)
        val overrides = parseOnUnresolvedOverrides(state.onUnresolvedOverrides).associate { spec ->
            spec.substringBefore('=') to spec.substringAfter('=')
        }
        return SyncRequestConfig(
            fileKey = fileKey?.trim()?.takeIf { it.isNotEmpty() },
            output = state.outputDir.trim(),
            packageName = state.packageName.trim(),
            tokensJson = tokensJson.toString(),
            layout = if (state.legacyLayout) "legacy" else null,
            prefix = state.classPrefix.trim().takeIf { it.isNotEmpty() },
            excludeMode = state.excludeModePattern.trim().takeIf { it.isNotEmpty() },
            onUnresolved = overrides,
        )
    }

    /** Splits [raw] on whitespace/commas into validated `<reason>=<action>` specs, in order. */
    private fun parseOnUnresolvedOverrides(raw: String): List<String> =
        toValidatedSpecs(raw)

    /**
     * Best-effort parse of [raw] into `(reason, action)` pairs, for seeding the "Unresolved token
     * overrides" wizard dialog from whatever is already in the field. Unlike [parseOnUnresolvedOverrides]
     * this never throws: entries that don't parse, or use an unknown reason/action, are dropped
     * silently rather than blocking the dialog from opening.
     */
    fun parseOnUnresolvedOverridesLenient(raw: String): List<Pair<String, String>> =
        raw.trim().split(Regex("[\\s,]+")).filter { it.isNotEmpty() }.mapNotNull { spec ->
            val eq = spec.indexOf('=')
            if (eq <= 0 || eq == spec.length - 1) return@mapNotNull null
            val reason = spec.substring(0, eq)
            val action = spec.substring(eq + 1)
            if (reason !in KNOWN_REASONS || action !in KNOWN_ACTIONS) return@mapNotNull null
            reason to action
        }

    /** Serializes `(reason, action)` pairs back into the space-separated field format. */
    fun formatOnUnresolvedOverrides(pairs: List<Pair<String, String>>): String =
        pairs.joinToString(" ") { (reason, action) -> "$reason=$action" }

    private fun toValidatedSpecs(raw: String): List<String> =
        raw.trim().split(Regex("[\\s,]+")).filter { it.isNotEmpty() }.map { spec ->
            val eq = spec.indexOf('=')
            if (eq <= 0 || eq == spec.length - 1) {
                throw InvalidConfigurationException(
                    "Invalid unresolved-token override ${spec.let { "\"$it\"" }}: expected " +
                        "\"<reason>=<silent|warn|fail>\"."
                )
            }
            val reason = spec.substring(0, eq)
            val action = spec.substring(eq + 1)
            if (reason !in KNOWN_REASONS) {
                throw InvalidConfigurationException(
                    "Unknown unresolved-token reason \"$reason\" (expected one of " +
                        "${KNOWN_REASONS.joinToString(", ")})."
                )
            }
            if (action !in KNOWN_ACTIONS) {
                throw InvalidConfigurationException(
                    "Unknown unresolved-token action \"$action\" for reason \"$reason\" " +
                        "(expected one of ${KNOWN_ACTIONS.joinToString(", ")})."
                )
            }
            spec
        }

    private fun validate(state: FigmaTokensState) {
        if (state.repoPath.isBlank()) {
            throw InvalidConfigurationException("Generator repository path is required.")
        }
        if (state.outputDir.isBlank()) {
            throw InvalidConfigurationException("Output directory is required.")
        }
        if (state.packageName.isBlank()) {
            throw InvalidConfigurationException("Kotlin package is required.")
        }
    }

    /** Human-readable command for the console. Nothing secret ever appears on this command line. */
    fun describe(commandLine: GeneralCommandLine): String =
        (listOf(commandLine.exePath) + commandLine.parametersList.list).joinToString(" ")
}

