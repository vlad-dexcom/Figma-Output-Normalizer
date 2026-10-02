package com.dex.figmatokens

import com.dex.figmatokens.node.NodeLocator
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertNotNull
import org.junit.After
import org.junit.Test
import java.io.File
import java.nio.file.Files

class NodeLocatorTest {

    @After
    fun tearDown() {
        NodeLocator.clearCache()
    }

    @Test
    fun `validate returns null for a missing executable`() {
        assertNull(NodeLocator.validate("/no/such/npm-binary"))
    }

    @Test
    fun `validate returns null for a non-executable file`() {
        val file = Files.createTempFile("not-npm", "").toFile()
        try {
            file.setExecutable(false)
            assertNull(NodeLocator.validate(file.absolutePath))
        } finally {
            file.delete()
        }
    }

    @Test
    fun `validate returns an NpmExecutable for a working fake npm`() {
        val fakeNpm = createFakeNpm("9.8.1")
        try {
            val result = NodeLocator.validate(fakeNpm.absolutePath)
            assertNotNull(result)
            assertEquals(fakeNpm.absolutePath, result!!.path)
            assertEquals("9.8.1", result.version)
        } finally {
            fakeNpm.delete()
        }
    }

    @Test
    fun `locate honors an explicit override without touching the cache`() {
        val fakeNpm = createFakeNpm("10.1.0")
        try {
            val result = NodeLocator.locate(override = fakeNpm.absolutePath)
            assertNotNull(result)
            assertEquals("10.1.0", result!!.version)
        } finally {
            fakeNpm.delete()
        }
    }

    @Test
    fun `validateNode returns null for a missing executable`() {
        assertNull(NodeLocator.validateNode("/no/such/node-binary"))
    }

    @Test
    fun `validateNode returns a NodeExecutable for a working fake node`() {
        val fakeNode = createFakeNpm("v22.11.0")
        try {
            val result = NodeLocator.validateNode(fakeNode.absolutePath)
            assertNotNull(result)
            assertEquals(fakeNode.absolutePath, result!!.path)
            assertEquals("v22.11.0", result.version)
        } finally {
            fakeNode.delete()
        }
    }

    @Test
    fun `locateNode honors an explicit override without touching the cache`() {
        val fakeNode = createFakeNpm("v20.9.0")
        try {
            val result = NodeLocator.locateNode(override = fakeNode.absolutePath)
            assertNotNull(result)
            assertEquals("v20.9.0", result!!.version)
        } finally {
            fakeNode.delete()
        }
    }

    private fun createFakeNpm(version: String): File {
        val file = Files.createTempFile("fake-npm", ".sh").toFile()
        file.writeText("#!/bin/sh\necho $version\n")
        file.setExecutable(true)
        return file
    }
}
