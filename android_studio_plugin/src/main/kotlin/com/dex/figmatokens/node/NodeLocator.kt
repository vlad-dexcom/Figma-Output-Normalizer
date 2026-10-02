package com.dex.figmatokens.node

import com.intellij.execution.configurations.GeneralCommandLine
import com.intellij.execution.util.ExecUtil
import com.intellij.openapi.util.SystemInfo
import java.io.File

/** A validated `npm` executable, used to build the standalone generator bundle. */
data class NpmExecutable(val path: String, val version: String)

/** A validated `node` executable, used to run the prebuilt generator bundle. */
data class NodeExecutable(val path: String, val version: String)

object NodeLocator {

    private val EXTRA_NPM_LOCATIONS: List<String> = when {
        SystemInfo.isWindows -> listOf(
            "C:\\Program Files\\nodejs\\npm.cmd",
            "C:\\Program Files (x86)\\nodejs\\npm.cmd",
        )
        else -> listOf(
            "/opt/homebrew/bin/npm",
            "/usr/local/bin/npm",
            "/usr/bin/npm",
        )
    }

    private val EXTRA_NODE_LOCATIONS: List<String> = when {
        SystemInfo.isWindows -> listOf(
            "C:\\Program Files\\nodejs\\node.exe",
            "C:\\Program Files (x86)\\nodejs\\node.exe",
        )
        else -> listOf(
            "/opt/homebrew/bin/node",
            "/usr/local/bin/node",
            "/usr/bin/node",
        )
    }

    @Volatile
    private var cachedNpm: NpmExecutable? = null

    @Volatile
    private var cachedNode: NodeExecutable? = null

    /**
     * Finds a usable `npm`: an explicit [override] first, then `PATH`, then well-known install
     * locations (including nvm-style user installs are picked up via `PATH`). Returns `null` when
     * nothing suitable is available. Only needed for building the generator bundle.
     */
    fun locate(override: String? = null, useCache: Boolean = true): NpmExecutable? {
        if (!override.isNullOrBlank()) {
            return validate(override)
        }
        if (useCache) {
            cachedNpm?.let { return it }
        }
        val candidates = listOfNotNull(resolveOnPath("npm")) + EXTRA_NPM_LOCATIONS
        val found = candidates.asSequence().mapNotNull { validate(it) }.firstOrNull()
        if (found != null && useCache) {
            cachedNpm = found
        }
        return found
    }

    /**
     * Finds a usable `node` runtime: an explicit [override] first, then `PATH`, then well-known
     * install locations. Used to run the prebuilt generator bundle.
     */
    fun locateNode(override: String? = null, useCache: Boolean = true): NodeExecutable? {
        if (!override.isNullOrBlank()) {
            return validateNode(override)
        }
        if (useCache) {
            cachedNode?.let { return it }
        }
        val candidates = listOfNotNull(resolveOnPath("node")) + EXTRA_NODE_LOCATIONS
        val found = candidates.asSequence().mapNotNull { validateNode(it) }.firstOrNull()
        if (found != null && useCache) {
            cachedNode = found
        }
        return found
    }

    /** `node` normally lives next to `npm`; derives a `node` override from a configured npm path. */
    fun nodeOverrideFromNpmPath(npmPath: String): String? {
        val npm = npmPath.trim().takeIf { it.isNotEmpty() } ?: return null
        val dir = File(npm).parentFile ?: return null
        val candidate = File(dir, if (SystemInfo.isWindows) "node.exe" else "node")
        return candidate.path.takeIf { candidate.isFile }
    }

    fun clearCache() {
        cachedNpm = null
        cachedNode = null
    }

    private fun resolveOnPath(name: String): String? =
        runCatching { com.intellij.openapi.util.io.FileUtil.toSystemIndependentName(findExecutable(name) ?: return null) }
            .getOrNull()

    private fun findExecutable(name: String): String? {
        val pathEnv = System.getenv("PATH") ?: return null
        val exeName = if (SystemInfo.isWindows) {
            if (name == "npm") "$name.cmd" else "$name.exe"
        } else {
            name
        }
        return pathEnv.split(File.pathSeparator)
            .asSequence()
            .filter { it.isNotBlank() }
            .map { File(it, exeName) }
            .firstOrNull { it.isFile && it.canExecute() }
            ?.absolutePath
    }

    /** Runs `<path> --version`; returns `null` when it is missing or not executable. */
    fun validate(path: String): NpmExecutable? = runCatching {
        val commandLine = GeneralCommandLine(path, "--version").withCharset(Charsets.UTF_8)
        val output = ExecUtil.execAndGetOutput(commandLine, TIMEOUT_MS)
        if (output.exitCode != 0) return null
        NpmExecutable(path, output.stdout.trim())
    }.getOrNull()

    /** Runs `<path> --version`; returns `null` when it is missing or not executable. */
    fun validateNode(path: String): NodeExecutable? = runCatching {
        val commandLine = GeneralCommandLine(path, "--version").withCharset(Charsets.UTF_8)
        val output = ExecUtil.execAndGetOutput(commandLine, TIMEOUT_MS)
        if (output.exitCode != 0) return null
        NodeExecutable(path, output.stdout.trim())
    }.getOrNull()

    private const val TIMEOUT_MS = 10_000
}

