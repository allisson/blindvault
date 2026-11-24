package io.github.allisson.blindvault

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.io.File

// android.md §7.3 (D301): the privileged-browser allowlist the build ships is Google's file, its `release`
// signatures only, pinned by the SHA-256 recorded beside it. Gradle runs the tests from `app/`.
class AllowlistTest {
    private val asset = File("src/main/assets/privileged-apps.json")
    private val record = File("../privileged-apps.txt")

    private fun apps() = JSONObject(asset.readText()).getJSONArray("apps").let { a -> List(a.length()) { a.getJSONObject(it) } }

    private fun recorded(key: String): String =
        record.readLines().single { it.startsWith("$key: ") }.removePrefix("$key: ")

    @Test
    fun parsesAsGooglesStructure() {
        val json = JSONObject(asset.readText())
        assertEquals(setOf("apps"), json.keys().asSequence().toSet())
        assertTrue(apps().isNotEmpty())
        for (app in apps()) {
            assertEquals(setOf("type", "info"), app.keys().asSequence().toSet())
            val info = app.getJSONObject("info")
            assertEquals(setOf("package_name", "signatures"), info.keys().asSequence().toSet())
            assertTrue(info.getString("package_name").isNotEmpty())
            assertTrue(info.getJSONArray("signatures").length() > 0)
        }
    }

    @Test
    fun everyEntryIsAnAndroidAppWithReleaseSignaturesOnly() {
        for (app in apps()) {
            assertEquals("android", app.getString("type"))
            val signatures = app.getJSONObject("info").getJSONArray("signatures")
            for (i in 0 until signatures.length()) {
                val signature = signatures.getJSONObject(i)
                assertEquals(setOf("build", "cert_fingerprint_sha256"), signature.keys().asSequence().toSet())
                assertEquals("release", signature.getString("build"))
                assertTrue(Regex("^([0-9A-F]{2}:){31}[0-9A-F]{2}$").matches(signature.getString("cert_fingerprint_sha256")))
            }
        }
    }

    @Test
    fun holdsChromeAndFirefox() {
        val packages = apps().map { it.getJSONObject("info").getString("package_name") }
        assertTrue(packages.contains("com.android.chrome"))
        assertTrue(packages.contains("org.mozilla.firefox"))
        assertEquals(packages.size, packages.toSet().size)
    }

    @Test
    fun matchesTheSha256RecordedBesideIt() {
        assertEquals(recorded("file-sha256"), sha256Hex(asset.readBytes()))
        assertTrue(Regex("^[0-9a-f]{64}$").matches(recorded("upstream-sha256")))
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(recorded("upstream-last-modified")))
        assertTrue(Regex("^\\d{4}-\\d{2}-\\d{2}$").matches(recorded("fetched")))
        assertEquals("https://www.gstatic.com/gpm-passkeys-privileged-apps/apps.json", recorded("source"))
    }

    @Test
    fun endsWithOneNewline() {
        val text = asset.readText()
        assertTrue(text.endsWith("}\n") && !text.endsWith("\n\n"))
    }
}
