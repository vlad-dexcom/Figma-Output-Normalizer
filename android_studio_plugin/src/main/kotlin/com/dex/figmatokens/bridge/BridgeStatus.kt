package com.dex.figmatokens.bridge

/** Lifecycle of the local bridge process, as the tool window shows it. */
sealed interface BridgeState {
    data class Stopped(val reason: String? = null) : BridgeState
    data object Starting : BridgeState
    data class Listening(val port: Int, val plugins: List<PluginConnection>) : BridgeState
    data class Failed(val message: String) : BridgeState
}

/** Whether "Generate" can work right now, and if not, why — shown next to the button. */
sealed interface Readiness {
    data class Ready(val file: PluginConnection) : Readiness
    data class BridgeDown(val message: String) : Readiness
    data object WaitingForPlugin : Readiness

    val isReady: Boolean get() = this is Ready
}

object ReadinessEvaluator {

    /** [selectedFileKey] picks among several connected files; null or unknown falls back to the first one. */
    fun evaluate(state: BridgeState, selectedFileKey: String?): Readiness {
        return when (state) {
            is BridgeState.Stopped -> Readiness.BridgeDown(state.reason ?: "The bridge is not running.")
            BridgeState.Starting -> Readiness.BridgeDown("The bridge is starting…")
            is BridgeState.Failed -> Readiness.BridgeDown(state.message)
            is BridgeState.Listening -> {
                val plugins = state.plugins
                if (plugins.isEmpty()) return Readiness.WaitingForPlugin
                val selected = selectedFileKey?.trim()?.takeIf { it.isNotEmpty() }
                Readiness.Ready(plugins.firstOrNull { it.fileKey == selected } ?: plugins.first())
            }
        }
    }

    /** One-line, user-facing description of a [Readiness]. */
    fun describe(readiness: Readiness): String = when (readiness) {
        is Readiness.Ready -> "Ready — ${readiness.file.fileName?.takeIf { it.isNotBlank() } ?: "Figma file"} is connected."
        is Readiness.BridgeDown -> readiness.message
        Readiness.WaitingForPlugin ->
            "Waiting for the Figma plugin. Open the design-system file in Figma desktop and run " +
                "Plugins → Development → Figma Normalizator."
    }
}
