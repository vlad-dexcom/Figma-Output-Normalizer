package com.dex.figmatokens.actions

import com.dex.figmatokens.ui.FigmaTokensToolWindowFactory
import com.intellij.openapi.actionSystem.ActionUpdateThread
import com.intellij.openapi.actionSystem.AnAction
import com.intellij.openapi.actionSystem.AnActionEvent
import com.intellij.openapi.project.DumbAware

/** Runs the generator with the settings currently shown in the tool window. */
open class GenerateTokensAction(private val dryRun: Boolean = false) : AnAction(), DumbAware {

    override fun actionPerformed(event: AnActionEvent) {
        val project = event.project ?: return
        FigmaTokensToolWindowFactory.withPanel(project) { panel -> panel.generate(dryRun) }
    }

    override fun update(event: AnActionEvent) {
        event.presentation.isEnabled = event.project != null
    }

    override fun getActionUpdateThread(): ActionUpdateThread = ActionUpdateThread.BGT
}

/** Same as [GenerateTokensAction], but forces `--dry-run`. */
class DryRunTokensAction : GenerateTokensAction(dryRun = true)
