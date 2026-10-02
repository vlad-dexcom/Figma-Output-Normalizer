package com.dex.figmatokens

import com.dex.figmatokens.run.LogLevel
import com.dex.figmatokens.run.LogLineClassifier
import org.junit.Assert.assertEquals
import org.junit.Test

class LogLineClassifierTest {

    @Test
    fun `stdout lines are info`() {
        assertEquals(LogLevel.INFO, LogLineClassifier.levelOf("Wrote 42 files", fromStderr = false))
    }

    @Test
    fun `stderr lines are error`() {
        assertEquals(LogLevel.ERROR, LogLineClassifier.levelOf("Cannot resolve alias foo", fromStderr = true))
    }

    @Test
    fun `plain console warn lines on stdout are still info`() {
        // The CLI has no structured [WARN]/[INFO] prefixes; severity is decided by stream only.
        assertEquals(LogLevel.INFO, LogLineClassifier.levelOf("warning: unused token", fromStderr = false))
    }
}
