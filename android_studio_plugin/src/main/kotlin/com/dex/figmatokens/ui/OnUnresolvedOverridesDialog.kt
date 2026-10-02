package com.dex.figmatokens.ui

import com.dex.figmatokens.run.GeneratorCommandBuilder
import com.intellij.openapi.project.Project
import com.intellij.openapi.ui.DialogWrapper
import com.intellij.util.ui.JBUI
import java.awt.BorderLayout
import java.awt.Dimension
import java.awt.FlowLayout
import java.awt.GridBagConstraints
import java.awt.GridBagLayout
import javax.swing.Box
import javax.swing.JButton
import javax.swing.JComboBox
import javax.swing.JComponent
import javax.swing.JLabel
import javax.swing.JPanel

/**
 * A small builder for the "Unresolved token overrides" field: one row per `reason=action` pair,
 * each a pair of dropdowns (reason, action) restricted to the values the CLI actually accepts, so
 * a user composing an override never has to remember or type the exact `--on-unresolved` syntax.
 *
 * Opened from [FigmaTokensPanel] via a "Build…" button next to the field; [showAndGet] returns the
 * serialized field text (e.g. `"unsupported-value=warn missing-alias-target=silent"`) on OK, or
 * `null` if cancelled.
 */
class OnUnresolvedOverridesDialog(project: Project, initialText: String) : DialogWrapper(project, false) {

    private val rowsPanel = JPanel()
    private val rows = mutableListOf<Row>()

    init {
        title = "Build Unresolved Token Overrides"
        rowsPanel.layout = GridBagLayout()
        val initial = GeneratorCommandBuilder.parseOnUnresolvedOverridesLenient(initialText)
        if (initial.isEmpty()) {
            addRow()
        } else {
            initial.forEach { (reason, action) -> addRow(reason, action) }
        }
        init()
    }

    override fun createCenterPanel(): JComponent {
        val panel = JPanel(BorderLayout(0, JBUI.scale(8)))
        panel.border = JBUI.Borders.empty(4)
        panel.add(
            JLabel("One row per --on-unresolved override. Later rows win if a reason repeats."),
            BorderLayout.NORTH,
        )
        panel.add(rowsPanel, BorderLayout.CENTER)

        val addButton = JButton("+ Add override")
        addButton.addActionListener { addRow(); pack() }
        val bottom = JPanel(FlowLayout(FlowLayout.LEFT, 0, 0))
        bottom.add(addButton)
        panel.add(bottom, BorderLayout.SOUTH)

        panel.preferredSize = Dimension(JBUI.scale(420), panel.preferredSize.height)
        return panel
    }

    /** The composed field text, e.g. `"unsupported-value=warn missing-alias-target=silent"`. */
    fun result(): String =
        GeneratorCommandBuilder.formatOnUnresolvedOverrides(
            rows.map { it.reasonCombo.selectedItem as String to it.actionCombo.selectedItem as String },
        )

    private fun addRow(reason: String = GeneratorCommandBuilder.KNOWN_REASONS.first(), action: String = "warn") {
        val reasonCombo = JComboBox(GeneratorCommandBuilder.KNOWN_REASONS.toTypedArray())
        reasonCombo.selectedItem = reason
        val actionCombo = JComboBox(GeneratorCommandBuilder.KNOWN_ACTIONS.toTypedArray())
        actionCombo.selectedItem = action

        val row = Row(reasonCombo, actionCombo)
        rows += row

        val removeButton = JButton("Remove")
        removeButton.addActionListener { removeRow(row) }
        row.removeButton = removeButton

        rebuildRowsPanel()
    }

    private fun removeRow(row: Row) {
        if (rows.size <= 1) return // always keep at least one row to edit
        rows -= row
        rebuildRowsPanel()
    }

    private fun rebuildRowsPanel() {
        rowsPanel.removeAll()
        rows.forEachIndexed { index, row ->
            val gapY = if (index == 0) 0 else JBUI.scale(4)
            val equalsLabel = JLabel(" = ")
            rowsPanel.add(row.reasonCombo, gbc(0, index, gapY, weight = 1.0))
            rowsPanel.add(equalsLabel, gbc(1, index, gapY, weight = 0.0))
            rowsPanel.add(row.actionCombo, gbc(2, index, gapY, weight = 1.0))
            rowsPanel.add(row.removeButton ?: Box.createHorizontalStrut(0), gbc(3, index, gapY, weight = 0.0))
        }
        rowsPanel.revalidate()
        rowsPanel.repaint()
        window?.pack()
    }

    private fun gbc(x: Int, y: Int, gapY: Int, weight: Double): GridBagConstraints =
        GridBagConstraints().apply {
            gridx = x
            gridy = y
            insets = JBUI.insets(gapY, if (x == 0) 0 else JBUI.scale(4), 0, 0)
            fill = GridBagConstraints.HORIZONTAL
            weightx = weight
        }

    private class Row(val reasonCombo: JComboBox<String>, val actionCombo: JComboBox<String>) {
        var removeButton: JButton? = null
    }

    companion object {
        /** Opens the wizard seeded from [currentText]; returns the new field text, or `null` if cancelled. */
        fun showAndGet(project: Project, currentText: String): String? {
            val dialog = OnUnresolvedOverridesDialog(project, currentText)
            return if (dialog.showAndGet()) dialog.result() else null
        }
    }
}
