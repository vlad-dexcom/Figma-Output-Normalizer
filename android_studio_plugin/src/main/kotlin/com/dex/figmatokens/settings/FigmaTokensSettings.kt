package com.dex.figmatokens.settings

import com.intellij.openapi.components.PersistentStateComponent
import com.intellij.openapi.components.Service
import com.intellij.openapi.components.State
import com.intellij.openapi.components.Storage
import com.intellij.openapi.components.service
import com.intellij.openapi.project.Project
import com.intellij.util.xmlb.XmlSerializerUtil

data class FigmaTokensState(
    /**
     * Path to a local checkout of the Figma-Output-Normalizer repository, with `npm install`
     * already run there. Mandatory: there is no generator bundled with this plugin; it builds and
     * runs that repo's `bridge` package (`npm run bundle --workspace=@figma-exporter/bridge`).
     */
    var repoPath: String = "",
    var outputDir: String = "",
    var packageName: String = "",
    var classPrefix: String = "",
    /** Optional override; blank means auto-detect `npm` on PATH / well-known locations. */
    var npmPath: String = "",
    /** `--exclude-mode <regex>`; blank means no modes are excluded. */
    var excludeModePattern: String = "",
    /** `--layout legacy` instead of the default `flat` (see codegen/tokens/README.md). */
    var legacyLayout: Boolean = false,
    var dryRun: Boolean = false,
    /**
     * Space/comma-separated `<reason>=<silent|warn|fail>` pairs, one `--on-unresolved` flag per
     * entry. Overrides the generator's default triage for a specific unresolved-token reason code
     * for this run only — e.g. `unsupported-value=warn` to not fail a run that genuinely expects
     * some unresolved tokens (a first pass over a messy export). Blank means no overrides.
     */
    var onUnresolvedOverrides: String = "",
)

@Service(Service.Level.PROJECT)
@State(name = "DexFigmaTokensSettings", storages = [Storage("dexFigmaTokens.xml")])
class FigmaTokensSettings : PersistentStateComponent<FigmaTokensState> {

    private var state = FigmaTokensState()

    override fun getState(): FigmaTokensState = state

    override fun loadState(state: FigmaTokensState) {
        XmlSerializerUtil.copyBean(state, this.state)
    }

    companion object {
        fun getInstance(project: Project): FigmaTokensSettings = project.service()
    }
}
