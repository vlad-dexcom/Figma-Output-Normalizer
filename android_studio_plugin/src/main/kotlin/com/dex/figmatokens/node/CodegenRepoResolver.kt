package com.dex.figmatokens.node

import java.nio.file.Files
import java.nio.file.Path
import kotlin.io.path.exists
import kotlin.io.path.isDirectory
import kotlin.io.path.readText

/**
 * Validates the (mandatory) path to a local checkout of the `Figma-Output-Normalizer` repository.
 * The plugin builds and runs that repo's `bridge` package from it (`tokens-sync`: the local
 * WebSocket bridge to the Figma plugin plus the `codegen/tokens` generator, bundled into one
 * standalone `bridge/dist/tokens-sync.cjs` via `npm run bundle --workspace=<WORKSPACE_NAME>`).
 *
 * There is no generator bundled with this plugin, so every run needs a real checkout configured,
 * with `npm install` already done there.
 */
object CodegenRepoResolver {

    class InvalidRepoException(message: String) : IllegalArgumentException(message)

    /** Relative path that must exist for a directory to be a usable repo checkout. */
    private const val PACKAGE_JSON_PATH = "bridge/package.json"

    /** The workspace package name used to build the bridge (`npm run bundle --workspace=<this>`). */
    const val WORKSPACE_NAME: String = "@figma-exporter/bridge"

    /** Where `npm run bundle --workspace=<WORKSPACE_NAME>` writes the standalone bundle. */
    private const val BUNDLE_RELATIVE_PATH = "bridge/dist/tokens-sync.cjs"

    /** @return the repo root, normalized to an absolute path. */
    fun resolve(path: String?): Path {
        val trimmed = path?.trim()
        if (trimmed.isNullOrEmpty()) {
            throw InvalidRepoException(
                "Generator repository path is required. Point it at a local checkout of " +
                    "Figma-Output-Normalizer with 'npm install' already run there."
            )
        }
        val root = Path.of(trimmed).toAbsolutePath().normalize()
        if (!root.exists()) {
            throw InvalidRepoException("Generator repository does not exist: $root")
        }
        if (!root.isDirectory()) {
            throw InvalidRepoException("Generator repository is not a directory: $root")
        }

        val packageJson = root.resolve(PACKAGE_JSON_PATH)
        if (!packageJson.exists()) {
            throw InvalidRepoException(
                "No '$PACKAGE_JSON_PATH' found under $root. Point this at the root of a " +
                    "Figma-Output-Normalizer checkout (pull the latest: the bridge lives in 'bridge/'), " +
                    "not a sub-folder."
            )
        }
        if (!packageJson.readText().contains(WORKSPACE_NAME)) {
            throw InvalidRepoException(
                "$packageJson does not declare the '$WORKSPACE_NAME' workspace. " +
                    "Is this the right repository checkout?"
            )
        }
        return root
    }

    /**
     * Whether `npm install` has apparently been run at [repoRoot] *and* is still up to date with
     * `package-lock.json`. npm touches `node_modules/.package-lock.json` on every successful
     * install, so if the real lockfile is newer, dependencies (e.g. a package added by a pulled
     * upstream change) are stale and `npm install` needs to run again before bundling — a bare
     * `node_modules` directory existence check would otherwise silently skip that reinstall and
     * esbuild would fail to resolve the newly-added dependency.
     */
    fun dependenciesInstalled(repoRoot: Path): Boolean {
        val nodeModules = repoRoot.resolve("node_modules")
        if (!nodeModules.isDirectory()) return false
        val lockfile = repoRoot.resolve("package-lock.json")
        val installMarker = nodeModules.resolve(".package-lock.json")
        if (!lockfile.exists() || !installMarker.exists()) return true
        return Files.getLastModifiedTime(installMarker) >= Files.getLastModifiedTime(lockfile)
    }

    /** Where the standalone generator bundle lives once built, for a given [repoRoot]. */
    fun bundlePath(repoRoot: Path): Path = repoRoot.resolve(BUNDLE_RELATIVE_PATH)

    /** Whether `npm run bundle --workspace=<WORKSPACE_NAME>` has been run at [repoRoot]. */
    fun bundleBuilt(repoRoot: Path): Boolean = bundlePath(repoRoot).exists()

    /** `null` when [path] is a usable repository checkout, otherwise the reason it is not. */
    fun problemWith(path: String): String? = try {
        resolve(path)
        null
    } catch (e: InvalidRepoException) {
        e.message
    } catch (e: Exception) {
        "Invalid path: ${e.message}"
    }
}
