package com.dex.figmatokens

import com.dex.figmatokens.node.NodeExecutable
import com.dex.figmatokens.run.GeneratorCommandBuilder
import com.dex.figmatokens.settings.FigmaTokensState
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.nio.file.Path

class GeneratorCommandBuilderTest {

    private val node = NodeExecutable("/usr/local/bin/node", "v22.11.0")
    private val bundlePath: Path = Path.of("/tmp/figma-output-normalizer/bridge/dist/tokens-sync.cjs")
    private val tokensJson: Path = Path.of("/project/.idea/dexFigmaTokens/figma.tokens.json")

    private fun baseState() = FigmaTokensState(
        repoPath = "/tmp/figma-output-normalizer",
        outputDir = "/project/app/src/main/java",
        packageName = "com.example.tokens",
    )

    private fun config(state: FigmaTokensState = baseState(), fileKey: String? = null) =
        GeneratorCommandBuilder.buildSyncConfig(state, tokensJson, fileKey)

    @Test
    fun `serve command runs the bundle in serve mode on the given port`() {
        val commandLine = GeneratorCommandBuilder.buildServeCommand(node, bundlePath, 8765)

        assertEquals("/usr/local/bin/node", commandLine.exePath)
        assertEquals(bundlePath.parent.toFile(), commandLine.workDirectory)
        assertEquals(listOf(bundlePath.toString(), "serve", "--port", "8765"), commandLine.parametersList.list)
    }

    @Test
    fun `sync config carries the required settings and the tokens path`() {
        val config = config()

        assertEquals("/project/app/src/main/java", config.output)
        assertEquals("com.example.tokens", config.packageName)
        assertEquals(tokensJson.toString(), config.tokensJson)
    }

    @Test
    fun `optional settings are null or empty when blank`() {
        val config = config()

        assertNull(config.fileKey)
        assertNull(config.prefix)
        assertNull(config.excludeMode)
        assertNull(config.layout)
        assertTrue(config.onUnresolved.isEmpty())
    }

    @Test
    fun `optional settings are included when set`() {
        val config = config(
            baseState().copy(
                classPrefix = "DS",
                excludeModePattern = "ios",
                legacyLayout = true,
            ),
            fileKey = " abc123 ",
        )

        assertEquals("abc123", config.fileKey)
        assertEquals("DS", config.prefix)
        assertEquals("ios", config.excludeMode)
        assertEquals("legacy", config.layout)
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `repository path is required`() {
        config(baseState().copy(repoPath = ""))
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `output directory is required`() {
        config(baseState().copy(outputDir = ""))
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `package name is required`() {
        config(baseState().copy(packageName = ""))
    }

    @Test
    fun `on-unresolved overrides become a reason to action map`() {
        val config = config(baseState().copy(onUnresolvedOverrides = "unsupported-value=warn, missing-alias-target=silent"))

        assertEquals(
            mapOf("unsupported-value" to "warn", "missing-alias-target" to "silent"),
            config.onUnresolved,
        )
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `on-unresolved override without an action is rejected`() {
        config(baseState().copy(onUnresolvedOverrides = "unsupported-value"))
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `on-unresolved override with an unknown reason is rejected`() {
        config(baseState().copy(onUnresolvedOverrides = "not-a-reason=warn"))
    }

    @Test(expected = GeneratorCommandBuilder.InvalidConfigurationException::class)
    fun `on-unresolved override with an unknown action is rejected`() {
        config(baseState().copy(onUnresolvedOverrides = "unsupported-value=ignore"))
    }

    @Test
    fun `lenient parse round-trips through format for the wizard dialog`() {
        val pairs = GeneratorCommandBuilder.parseOnUnresolvedOverridesLenient(
            "unsupported-value=warn, missing-alias-target=silent",
        )
        assertEquals(listOf("unsupported-value" to "warn", "missing-alias-target" to "silent"), pairs)
        assertEquals(
            "unsupported-value=warn missing-alias-target=silent",
            GeneratorCommandBuilder.formatOnUnresolvedOverrides(pairs),
        )
    }

    @Test
    fun `lenient parse silently drops unparsable or unknown entries instead of throwing`() {
        val pairs = GeneratorCommandBuilder.parseOnUnresolvedOverridesLenient(
            "unsupported-value=warn not-a-pair not-a-reason=warn unsupported-value=ignore",
        )
        assertEquals(listOf("unsupported-value" to "warn"), pairs)
    }

    @Test
    fun `lenient parse of blank text yields no pairs`() {
        assertTrue(GeneratorCommandBuilder.parseOnUnresolvedOverridesLenient("  ").isEmpty())
    }

    private fun List<String>.containsInOrder(flag: String, value: String): Boolean {
        val index = indexOf(flag)
        return index >= 0 && index + 1 < size && this[index + 1] == value
    }
}
