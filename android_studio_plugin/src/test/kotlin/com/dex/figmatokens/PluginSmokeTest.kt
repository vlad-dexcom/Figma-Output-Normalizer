package com.dex.figmatokens

import com.dex.figmatokens.run.GeneratorRunner
import com.dex.figmatokens.settings.FigmaTokensSettings
import com.dex.figmatokens.ui.FigmaTokensToolWindowFactory
import com.intellij.testFramework.fixtures.BasePlatformTestCase

class PluginSmokeTest : BasePlatformTestCase() {

    fun testServicesAreRegistered() {
        assertNotNull(FigmaTokensSettings.getInstance(project))
        assertNotNull(GeneratorRunner.getInstance(project))
        assertFalse(GeneratorRunner.getInstance(project).isRunning)
    }

    fun testSettingsRoundTrip() {
        val settings = FigmaTokensSettings.getInstance(project)
        settings.state.repoPath = "/tmp/figma-output-normalizer"
        settings.state.packageName = "com.example.tokens"

        val reloaded = FigmaTokensSettings.getInstance(project).state
        assertEquals("/tmp/figma-output-normalizer", reloaded.repoPath)
        assertEquals("com.example.tokens", reloaded.packageName)
    }

    fun testToolWindowPanelBuilds() {
        val panel = com.dex.figmatokens.ui.FigmaTokensPanel(project, testRootDisposable)

        assertTrue(panel.componentCount > 0)
    }

    fun testToolWindowIdMatchesPluginXml() {
        assertEquals("Figma Tokens", FigmaTokensToolWindowFactory.TOOL_WINDOW_ID)
    }
}
