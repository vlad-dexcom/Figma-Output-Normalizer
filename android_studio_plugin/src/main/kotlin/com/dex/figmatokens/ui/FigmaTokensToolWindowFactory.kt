package com.dex.figmatokens.ui

import com.intellij.openapi.project.DumbAware
import com.intellij.openapi.project.Project
import com.intellij.openapi.wm.ToolWindow
import com.intellij.openapi.wm.ToolWindowFactory
import com.intellij.openapi.wm.ToolWindowManager
import com.intellij.ui.content.ContentFactory

class FigmaTokensToolWindowFactory : ToolWindowFactory, DumbAware {

    override fun createToolWindowContent(project: Project, toolWindow: ToolWindow) {
        val panel = FigmaTokensPanel(project, toolWindow.disposable)
        val content = ContentFactory.getInstance().createContent(panel, null, false)
        content.isCloseable = false
        content.putUserData(PANEL_KEY, panel)
        toolWindow.contentManager.addContent(content)
    }

    companion object {
        const val TOOL_WINDOW_ID = "Figma Tokens"

        private val PANEL_KEY = com.intellij.openapi.util.Key.create<FigmaTokensPanel>("dex.figma.panel")

        /** Shows the tool window and hands the panel to [action] once it is realised. */
        fun withPanel(project: Project, action: (FigmaTokensPanel) -> Unit) {
            val toolWindow = ToolWindowManager.getInstance(project).getToolWindow(TOOL_WINDOW_ID) ?: return
            toolWindow.activate {
                val panel = toolWindow.contentManager.contents
                    .firstNotNullOfOrNull { it.getUserData(PANEL_KEY) }
                if (panel != null) action(panel)
            }
        }
    }
}
