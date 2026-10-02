package com.dex.figmatokens

import com.dex.figmatokens.bridge.BridgeEvent
import com.dex.figmatokens.bridge.BridgeProtocol
import com.dex.figmatokens.bridge.BridgeState
import com.dex.figmatokens.bridge.PluginConnection
import com.dex.figmatokens.bridge.Readiness
import com.dex.figmatokens.bridge.ReadinessEvaluator
import com.dex.figmatokens.bridge.SyncRequestConfig
import com.google.gson.JsonParser
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

class BridgeProtocolTest {

    @Test
    fun `parses a listening status with connected plugins`() {
        val event = BridgeProtocol.parse(
            """{"type":"status","bridge":"listening","port":8765,"plugins":[{"id":1,"fileKey":"K","fileName":"Design System"},{"id":2}]}""",
        ) as BridgeEvent.Status

        assertTrue(event.listening)
        assertEquals(8765, event.port)
        assertEquals(listOf(PluginConnection("K", "Design System"), PluginConnection(null, null)), event.plugins)
    }

    @Test
    fun `parses a bridge start failure`() {
        val event = BridgeProtocol.parse("""{"type":"status","bridge":"error","message":"Port 8765 is already in use"}""")
            as BridgeEvent.Status

        assertFalse(event.listening)
        assertEquals("Port 8765 is already in use", event.error)
    }

    @Test
    fun `parses log result and error events`() {
        assertEquals(
            BridgeEvent.Log("1", "error", "boom"),
            BridgeProtocol.parse("""{"type":"log","id":"1","level":"error","text":"boom"}"""),
        )
        assertEquals(
            BridgeEvent.Result("1", 0, false, true),
            BridgeProtocol.parse("""{"type":"result","id":"1","exitCode":0,"tokensChanged":false,"skipped":true,"version":"c1-x"}"""),
        )
        assertEquals(
            BridgeEvent.Failed("1", "no-plugin", "No Figma plugin connected."),
            BridgeProtocol.parse("""{"type":"error","id":"1","code":"no-plugin","message":"No Figma plugin connected."}"""),
        )
    }

    @Test
    fun `non protocol lines are ignored`() {
        assertNull(BridgeProtocol.parse("npm warn something"))
        assertNull(BridgeProtocol.parse("""{"type":"unknown"}"""))
        assertNull(BridgeProtocol.parse(""))
    }

    @Test
    fun `sync command serializes only the set options`() {
        val json = JsonParser.parseString(
            BridgeProtocol.syncCommand(
                "7",
                SyncRequestConfig(null, "/out", "com.x", "/t.json", null, null, "ios", mapOf("unsupported-value" to "warn")),
                dryRun = true,
            ),
        ).asJsonObject
        val config = json.getAsJsonObject("config")

        assertEquals("sync", json.get("cmd").asString)
        assertEquals("7", json.get("id").asString)
        assertTrue(json.get("dryRun").asBoolean)
        assertFalse(json.get("skipIfUnchanged").asBoolean)
        assertFalse(json.get("useLocal").asBoolean)
        assertEquals("com.x", config.get("package").asString)
        assertEquals("ios", config.get("excludeMode").asString)
        assertEquals("warn", config.getAsJsonObject("onUnresolved").get("unsupported-value").asString)
        assertFalse(config.has("fileKey"))
        assertFalse(config.has("layout"))
    }

    private val file = PluginConnection("K", "Design System")

    @Test
    fun `ready when any plugin is connected and nothing is selected`() {
        val readiness = ReadinessEvaluator.evaluate(BridgeState.Listening(8765, listOf(file)), null)
        assertEquals(Readiness.Ready(file), readiness)
    }

    @Test
    fun `waiting when the bridge listens but no plugin is connected`() {
        assertEquals(Readiness.WaitingForPlugin, ReadinessEvaluator.evaluate(BridgeState.Listening(8765, emptyList()), null))
    }

    @Test
    fun `a selected file key picks that file, unknown keys fall back to the first`() {
        val state = BridgeState.Listening(8765, listOf(PluginConnection("OTHER", "Other"), file))
        assertEquals(Readiness.Ready(file), ReadinessEvaluator.evaluate(state, " K "))
        assertEquals(Readiness.Ready(PluginConnection("OTHER", "Other")), ReadinessEvaluator.evaluate(state, "GONE"))
    }

    @Test
    fun `not ready while the bridge is down, starting or failed`() {
        assertFalse(ReadinessEvaluator.evaluate(BridgeState.Stopped(), null).isReady)
        assertFalse(ReadinessEvaluator.evaluate(BridgeState.Starting, null).isReady)
        val failed = ReadinessEvaluator.evaluate(BridgeState.Failed("Port in use"), null)
        assertEquals("Port in use", ReadinessEvaluator.describe(failed))
    }
}
