package com.dex.figmatokens.bridge

import com.google.gson.JsonObject
import com.google.gson.JsonParser

/** The port the Figma plugin's manifest allows (`devAllowedDomains`); not user-configurable. */
const val BRIDGE_PORT: Int = 8765

/** One Figma plugin instance connected to the bridge. Both fields are null until its hello arrives. */
data class PluginConnection(val fileKey: String?, val fileName: String?)

/** What the bridge process reports on stdout, one JSON object per line. */
sealed interface BridgeEvent {
    /** [error] is set when the bridge could not start listening (e.g. the port is taken). */
    data class Status(
        val listening: Boolean,
        val port: Int?,
        val plugins: List<PluginConnection>,
        val error: String?,
    ) : BridgeEvent

    data class Log(val id: String?, val level: String, val text: String) : BridgeEvent
    data class Result(val id: String, val exitCode: Int, val tokensChanged: Boolean, val version: String?) : BridgeEvent
    data class Failed(val id: String?, val code: String, val message: String) : BridgeEvent
}

/** What a sync needs, mirroring the bridge's `SyncConfig`. */
data class SyncRequestConfig(
    val fileKey: String?,
    val output: String,
    val packageName: String,
    val tokensJson: String,
    val layout: String?,
    val prefix: String?,
    val excludeMode: String?,
    val onUnresolved: Map<String, String>,
)

/** JSON-lines protocol of `tokens-sync serve` (see the Figma-Output-Normalizer repo's `bridge/src/serve.ts`). */
object BridgeProtocol {

    /** Returns `null` for lines that aren't protocol messages (e.g. stray output), never throws. */
    fun parse(line: String): BridgeEvent? {
        val obj = try {
            JsonParser.parseString(line.trim()).takeIf { it.isJsonObject }?.asJsonObject ?: return null
        } catch (e: Exception) {
            return null
        }
        return when (obj.str("type")) {
            "status" -> BridgeEvent.Status(
                listening = obj.str("bridge") == "listening",
                port = obj.get("port")?.takeIf { it.isJsonPrimitive }?.asInt,
                plugins = obj.getAsJsonArray("plugins")?.mapNotNull { element ->
                    element.takeIf { it.isJsonObject }?.asJsonObject?.let {
                        PluginConnection(it.str("fileKey"), it.str("fileName"))
                    }
                }.orEmpty(),
                error = obj.str("message"),
            )
            "log" -> BridgeEvent.Log(obj.str("id"), obj.str("level") ?: "info", obj.str("text").orEmpty())
            "result" -> obj.str("id")?.let {
                BridgeEvent.Result(
                    id = it,
                    exitCode = obj.get("exitCode")?.asInt ?: -1,
                    tokensChanged = obj.get("tokensChanged")?.asBoolean ?: true,
                    version = obj.str("version"),
                )
            }
            "error" -> BridgeEvent.Failed(obj.str("id"), obj.str("code") ?: "failed", obj.str("message").orEmpty())
            else -> null
        }
    }

    fun syncCommand(id: String, config: SyncRequestConfig, dryRun: Boolean, timeoutMs: Long = 30_000): String {
        val cfg = JsonObject().apply {
            config.fileKey?.let { addProperty("fileKey", it) }
            addProperty("output", config.output)
            addProperty("package", config.packageName)
            addProperty("tokensJson", config.tokensJson)
            config.layout?.let { addProperty("layout", it) }
            config.prefix?.let { addProperty("prefix", it) }
            config.excludeMode?.let { addProperty("excludeMode", it) }
            if (config.onUnresolved.isNotEmpty()) {
                add("onUnresolved", JsonObject().also { o -> config.onUnresolved.forEach { (k, v) -> o.addProperty(k, v) } })
            }
        }
        return JsonObject().apply {
            addProperty("cmd", "sync")
            addProperty("id", id)
            add("config", cfg)
            addProperty("dryRun", dryRun)
            addProperty("timeoutMs", timeoutMs)
        }.toString()
    }

    fun shutdownCommand(): String = JsonObject().apply { addProperty("cmd", "shutdown") }.toString()

    private fun JsonObject.str(key: String): String? =
        get(key)?.takeIf { it.isJsonPrimitive }?.asString
}
