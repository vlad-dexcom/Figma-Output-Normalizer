package com.dex.figmatokens

import com.dex.figmatokens.node.CodegenRepoResolver
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Assert.assertFalse
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import java.nio.file.Files

class CodegenRepoResolverTest {

    @get:Rule
    val tempFolder = TemporaryFolder()

    @Test(expected = CodegenRepoResolver.InvalidRepoException::class)
    fun `blank path is rejected`() {
        CodegenRepoResolver.resolve(" ")
    }

    @Test(expected = CodegenRepoResolver.InvalidRepoException::class)
    fun `missing path is rejected`() {
        CodegenRepoResolver.resolve(tempFolder.root.resolve("does-not-exist").absolutePath)
    }

    @Test(expected = CodegenRepoResolver.InvalidRepoException::class)
    fun `a file is rejected, not just a directory`() {
        val file = tempFolder.newFile("not-a-dir")
        CodegenRepoResolver.resolve(file.absolutePath)
    }

    @Test(expected = CodegenRepoResolver.InvalidRepoException::class)
    fun `directory without bridge package json is rejected`() {
        CodegenRepoResolver.resolve(tempFolder.root.absolutePath)
    }

    @Test(expected = CodegenRepoResolver.InvalidRepoException::class)
    fun `package json without the workspace name is rejected`() {
        writePackageJson(tempFolder, """{"name": "@some-other/workspace"}""")
        CodegenRepoResolver.resolve(tempFolder.root.absolutePath)
    }

    @Test
    fun `a valid checkout resolves to its normalized root`() {
        writePackageJson(tempFolder, """{"name": "@figma-exporter/bridge"}""")
        val resolved = CodegenRepoResolver.resolve(tempFolder.root.absolutePath)
        assertEquals(tempFolder.root.toPath().toAbsolutePath().normalize(), resolved)
        assertEquals("@figma-exporter/bridge", CodegenRepoResolver.WORKSPACE_NAME)
    }

    @Test
    fun `dependenciesInstalled reflects the presence of node_modules`() {
        writePackageJson(tempFolder, """{"name": "${CodegenRepoResolver.WORKSPACE_NAME}"}""")
        val root = tempFolder.root.toPath()
        assertFalse(CodegenRepoResolver.dependenciesInstalled(root))

        Files.createDirectory(root.resolve("node_modules"))
        assertTrue(CodegenRepoResolver.dependenciesInstalled(root))
    }

    @Test
    fun `dependenciesInstalled is false when package-lock is newer than the install marker`() {
        writePackageJson(tempFolder, """{"name": "${CodegenRepoResolver.WORKSPACE_NAME}"}""")
        val root = tempFolder.root.toPath()
        val nodeModules = Files.createDirectory(root.resolve("node_modules"))
        val marker = Files.createFile(nodeModules.resolve(".package-lock.json"))
        val lockfile = Files.createFile(root.resolve("package-lock.json"))

        Files.setLastModifiedTime(marker, java.nio.file.attribute.FileTime.fromMillis(1_000))
        Files.setLastModifiedTime(lockfile, java.nio.file.attribute.FileTime.fromMillis(2_000))
        assertFalse(CodegenRepoResolver.dependenciesInstalled(root))

        Files.setLastModifiedTime(marker, java.nio.file.attribute.FileTime.fromMillis(3_000))
        assertTrue(CodegenRepoResolver.dependenciesInstalled(root))
    }

    @Test
    fun `bundleBuilt reflects the presence of the standalone bundle file`() {
        writePackageJson(tempFolder, """{"name": "${CodegenRepoResolver.WORKSPACE_NAME}"}""")
        val root = tempFolder.root.toPath()
        assertFalse(CodegenRepoResolver.bundleBuilt(root))

        val bundlePath = CodegenRepoResolver.bundlePath(root)
        Files.createDirectories(bundlePath.parent)
        Files.createFile(bundlePath)
        assertTrue(CodegenRepoResolver.bundleBuilt(root))
    }

    @Test
    fun `problemWith returns null for a valid checkout and a message otherwise`() {
        assertNotNull(CodegenRepoResolver.problemWith(""))

        writePackageJson(tempFolder, """{"name": "${CodegenRepoResolver.WORKSPACE_NAME}"}""")
        assertNull(CodegenRepoResolver.problemWith(tempFolder.root.absolutePath))
    }

    private fun writePackageJson(folder: TemporaryFolder, contents: String) {
        val dir = folder.newFolder("bridge")
        dir.resolve("package.json").writeText(contents)
    }
}
