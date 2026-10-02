package com.dex.figmatokens.node

import com.intellij.openapi.util.SystemInfo

/**
 * Suggests (but never runs) an OS package-manager command to install Node.js, for display when
 * npm/node cannot be found. This plugin never executes system-level installs itself — commands
 * are shown so the user can run them in their own terminal (some need an interactive `sudo`
 * password, which this plugin has no way to prompt for).
 */
object NodeInstaller {

    /** Manual-install fallback link shown when no specific suggestion applies. */
    const val MANUAL_DOWNLOAD_URL: String = "https://nodejs.org/"

    /** A one-line suggestion appropriate for this OS, or `null` if none is known. */
    fun suggestedCommand(): String? = when {
        SystemInfo.isMac -> "brew install node"
        SystemInfo.isWindows -> "winget install -e --id OpenJS.NodeJS.LTS"
        SystemInfo.isLinux -> "sudo apt-get install -y nodejs npm   # or: sudo dnf install -y nodejs npm / sudo pacman -S nodejs npm"
        else -> null
    }
}
