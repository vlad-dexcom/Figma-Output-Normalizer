package com.dex.figmatokens.ui

import com.dex.figmatokens.run.GeneratorLog
import com.dex.figmatokens.run.LogLevel
import com.intellij.execution.filters.TextConsoleBuilderFactory
import com.intellij.execution.ui.ConsoleView
import com.intellij.execution.ui.ConsoleViewContentType
import com.intellij.openapi.Disposable
import com.intellij.openapi.application.ApplicationManager
import com.intellij.openapi.project.Project
import com.intellij.openapi.util.Disposer
import javax.swing.JComponent

/** Tool-window console that renders generator output with severity colouring. */
class GeneratorConsole(project: Project, parent: Disposable) : GeneratorLog {

    private val console: ConsoleView =
        TextConsoleBuilderFactory.getInstance().createBuilder(project).console

    init {
        Disposer.register(parent, console)
    }

    val component: JComponent get() = console.component

    override fun clear() {
        runOnEdt { console.clear() }
    }

    override fun append(line: String, level: LogLevel) {
        runOnEdt { console.print(line + "\n", contentType(level)) }
    }

    private fun contentType(level: LogLevel): ConsoleViewContentType = when (level) {
        LogLevel.ERROR -> ConsoleViewContentType.ERROR_OUTPUT
        LogLevel.WARNING -> ConsoleViewContentType.LOG_WARNING_OUTPUT
        LogLevel.SYSTEM -> ConsoleViewContentType.SYSTEM_OUTPUT
        LogLevel.INFO -> ConsoleViewContentType.NORMAL_OUTPUT
    }

    private fun runOnEdt(action: () -> Unit) {
        val application = ApplicationManager.getApplication()
        if (application.isDispatchThread) action() else application.invokeLater(action)
    }
}
