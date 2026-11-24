package io.github.allisson.blindvault

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

// android.md §9 (D290, D293): every type of the main window, and every way a message is dropped or
// refused.
class BridgeTest {
    private val id16 = b64url(ByteArray(16) { it.toByte() })
    private val secret = b64url(ByteArray(32) { 1 })
    private val iv = b64url(ByteArray(12) { 2 })
    private val sealed = b64url(ByteArray(48) { 3 })

    private fun b64url(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun message(type: String, vararg fields: Pair<String, Any?>): String {
        val m = JSONObject().put("v", 1).put("id", 7).put("type", type)
        for ((k, v) in fields) m.put(k, v ?: JSONObject.NULL)
        return m.toString()
    }

    private fun accepted(text: String, from: BridgeWindow = BridgeWindow.MAIN): Request {
        val parsed = Bridge.parse(text, from)
        assertTrue("$text: $parsed", parsed is Parsed.Accepted)
        parsed as Parsed.Accepted
        assertEquals(7L, parsed.id)
        return parsed.request
    }

    private fun refused(text: String, from: BridgeWindow = BridgeWindow.MAIN) {
        val parsed = Bridge.parse(text, from)
        assertTrue("$text: $parsed", parsed is Parsed.Refused && parsed.id == 7L)
    }

    private fun dropped(text: String) = assertEquals(text, Parsed.Dropped, Bridge.parse(text, BridgeWindow.MAIN))

    @Test
    fun acceptsTheKeystoreTypes() {
        val status = accepted(message("keystore-status", "localConfigId" to id16)) as Request.KeystoreStatus
        assertArrayEquals(ByteArray(16) { it.toByte() }, status.localConfigId)
        val seal = accepted(message("keystore-seal", "localConfigId" to id16, "secret" to secret)) as Request.KeystoreSeal
        assertArrayEquals(ByteArray(32) { 1 }, seal.secret)
        val open = accepted(
            message("keystore-open", "localConfigId" to id16, "iv" to iv, "sealed" to sealed),
        ) as Request.KeystoreOpen
        assertArrayEquals(ByteArray(12) { 2 }, open.iv)
        assertArrayEquals(ByteArray(48) { 3 }, open.sealed)
        assertTrue(accepted(message("keystore-delete", "localConfigId" to id16)) is Request.KeystoreDelete)
    }

    @Test
    fun acceptsTheClipboardFileAndShellTypes() {
        val copy = accepted(message("clipboard-copy", "text" to "hunter2", "clearSeconds" to 30)) as Request.ClipboardCopy
        assertEquals("hunter2", copy.text)
        assertEquals(30, copy.clearSeconds)
        assertEquals(Request.ClipboardClear, accepted(message("clipboard-clear")))
        val save = accepted(
            message("file-save", "name" to "blindvault.bvault", "mediaType" to "application/octet-stream"),
        ) as Request.FileSave
        assertEquals("blindvault.bvault", save.name)
        assertEquals("application/octet-stream", save.mediaType)
        val chunk = accepted(message("file-chunk", "data" to "AAEC")) as Request.FileChunk
        assertArrayEquals(byteArrayOf(0, 1, 2), chunk.data)
        assertEquals(Request.FileEnd, accepted(message("file-end")))
        assertEquals(Request.FileAbort, accepted(message("file-abort")))
        assertEquals(Request.BuildInfo, accepted(message("build-info")))
        assertEquals(Request.LifecycleWatch, accepted(message("lifecycle-watch")))
    }

    @Test
    fun acceptsTheBoundsOfEachRange() {
        accepted(message("clipboard-copy", "text" to "x", "clearSeconds" to 10))
        accepted(message("clipboard-copy", "text" to "x".repeat(CLIPBOARD_TEXT_MAX), "clearSeconds" to 120))
        accepted(message("file-save", "name" to "n".repeat(FILE_NAME_MAX), "mediaType" to "text/csv"))
        val full = Base64.getEncoder().encodeToString(ByteArray(FILE_CHUNK_BYTES))
        assertEquals(FILE_CHUNK_BYTES, (accepted(message("file-chunk", "data" to full)) as Request.FileChunk).data.size)
        assertEquals(9007199254740991L, (Bridge.parse("""{"v":1,"id":9007199254740991,"type":"build-info"}""", BridgeWindow.MAIN) as Parsed.Accepted).id)
    }

    @Test
    fun dropsAMessageWithNoIdToAnswer() {
        for (text in listOf(
            "",
            "not json",
            "[1]",
            "\"text\"",
            """{"v":1,"type":"build-info"}""",
            """{"v":1,"id":"7","type":"build-info"}""",
            """{"v":1,"id":null,"type":"build-info"}""",
            """{"v":1,"id":0,"type":"build-info"}""",
            """{"v":1,"id":-7,"type":"build-info"}""",
            """{"v":1,"id":7.5,"type":"build-info"}""",
            """{"v":1,"id":true,"type":"build-info"}""",
            """{"v":1,"id":9007199254740992,"type":"build-info"}""",
        )) dropped(text)
    }

    private val provider = BridgeWindow.PROVIDER
    private val result = JSONObject().put("kind", "cancelled")

    @Test
    fun acceptsTheProviderTypesFromTheProviderWindow() {
        assertEquals(Request.ProviderRequest, accepted(message("provider-request"), provider))
        val parsed = accepted(message("provider-result", "result" to result), provider) as Request.ProviderResult
        assertEquals("cancelled", parsed.result.getString("kind"))
    }

    @Test
    fun refusesTheProviderTypesFromTheMainWindow() {
        refused(message("provider-request"))
        refused(message("provider-result", "result" to result))
    }

    @Test
    fun refusesFileTypesFromTheProviderWindow() {
        refused(message("file-save", "name" to "a", "mediaType" to "text/csv"), provider)
        refused(message("file-chunk", "data" to "AAEC"), provider)
        refused(message("file-end"), provider)
        refused(message("file-abort"), provider)
    }

    @Test
    fun takesTheWindowTypesFromBothWindows() {
        for (from in BridgeWindow.entries) {
            accepted(message("keystore-status", "localConfigId" to id16), from)
            accepted(message("keystore-seal", "localConfigId" to id16, "secret" to secret), from)
            accepted(message("keystore-open", "localConfigId" to id16, "iv" to iv, "sealed" to sealed), from)
            accepted(message("keystore-delete", "localConfigId" to id16), from)
            accepted(message("clipboard-copy", "text" to "x", "clearSeconds" to 30), from)
            accepted(message("clipboard-clear"), from)
            accepted(message("build-info"), from)
            accepted(message("lifecycle-watch"), from)
        }
    }

    @Test
    fun refusesAProviderRequestWithAKey() {
        refused(message("provider-request", "kind" to "get"), provider)
        refused(message("provider-request", "result" to result), provider)
    }

    @Test
    fun refusesAMalformedProviderResult() {
        refused(message("provider-result"), provider)
        for (value in listOf<Any?>("cancelled", 7, true, null, JSONArray(), "{}")) {
            refused(message("provider-result", "result" to value), provider)
        }
        refused(message("provider-result", "result" to result, "extra" to 1), provider)
        refused(message("provider-result", "kind" to "cancelled"), provider)
    }

    @Test
    fun aRefusedMessageNamesItsTypeSoTheProviderWindowCanEndOnIt() {
        assertEquals(
            Parsed.Refused(7, "provider-result"),
            Bridge.parse(message("provider-result", "result" to 7), provider),
        )
        assertEquals(Parsed.Refused(7, "provider-request"), Bridge.parse(message("provider-request"), BridgeWindow.MAIN))
        assertEquals(Parsed.Refused(7, null), Bridge.parse("""{"v":1,"id":7,"type":7}""", provider))
        assertEquals(Parsed.Refused(7, null), Bridge.parse("""{"v":1,"id":7}""", provider))
    }

    @Test
    fun refusesAnUnknownVersionOrType() {
        refused("""{"id":7,"type":"build-info"}""")
        for (v in listOf("2", "0", "\"1\"", "true", "1.5", "null")) refused("""{"v":$v,"id":7,"type":"build-info"}""")
        refused("""{"v":1,"id":7}""")
        refused("""{"v":1,"id":7,"type":7}""")
        refused(message("keystore-wipe"))
        refused(message("Build-Info"))
        refused(message("lifecycle", "state" to "hidden"))
        refused(message("provider-result"))
    }

    @Test
    fun refusesAMissingOrUnknownKey() {
        refused(message("build-info", "extra" to 1))
        refused(message("keystore-status"))
        refused(message("keystore-status", "localConfigId" to id16, "secret" to secret))
        refused(message("keystore-seal", "localConfigId" to id16))
        refused(message("keystore-open", "localConfigId" to id16, "iv" to iv))
        refused(message("clipboard-copy", "text" to "x"))
        refused(message("clipboard-clear", "text" to "x"))
        refused(message("file-save", "name" to "a"))
        refused(message("file-chunk"))
        refused(message("file-end", "data" to "AAAA"))
        refused(message("lifecycle-watch", "state" to "shown"))
    }

    @Test
    fun refusesBytesOfTheWrongLengthOrForm() {
        refused(message("keystore-status", "localConfigId" to b64url(ByteArray(15))))
        refused(message("keystore-status", "localConfigId" to b64url(ByteArray(17))))
        refused(message("keystore-status", "localConfigId" to ""))
        refused(message("keystore-status", "localConfigId" to 7))
        refused(message("keystore-status", "localConfigId" to null))
        // Padding, unused bits set, the standard alphabet, a stray character.
        refused(message("keystore-status", "localConfigId" to "AAAAAAAAAAAAAAAAAAAAAA=="))
        refused(message("keystore-status", "localConfigId" to "AAAAAAAAAAAAAAAAAAAAAB"))
        val standard = Base64.getEncoder().withoutPadding().encodeToString(ByteArray(16) { -5 })
        assertTrue(standard.contains('+') || standard.contains('/'))
        refused(message("keystore-status", "localConfigId" to standard))
        refused(message("keystore-status", "localConfigId" to "AAAAAAAAAAAAAAAAAAAA A"))
        refused(message("keystore-seal", "localConfigId" to id16, "secret" to b64url(ByteArray(31))))
        refused(message("keystore-seal", "localConfigId" to id16, "secret" to b64url(ByteArray(33))))
        refused(message("keystore-open", "localConfigId" to id16, "iv" to b64url(ByteArray(11)), "sealed" to sealed))
        refused(message("keystore-open", "localConfigId" to id16, "iv" to iv, "sealed" to b64url(ByteArray(47))))
        refused(message("keystore-delete", "localConfigId" to b64url(ByteArray(32))))
    }

    @Test
    fun refusesAClipboardCopyOutOfRange() {
        for (seconds in listOf<Any>(9, 121, 0, -30, 30.5, "30", true)) {
            refused(message("clipboard-copy", "text" to "x", "clearSeconds" to seconds))
        }
        refused(message("clipboard-copy", "text" to "", "clearSeconds" to 30))
        refused(message("clipboard-copy", "text" to 7, "clearSeconds" to 30))
        refused(message("clipboard-copy", "text" to "x".repeat(CLIPBOARD_TEXT_MAX + 1), "clearSeconds" to 30))
    }

    @Test
    fun refusesAFileSaveWithABadNameOrMediaType() {
        val ok = "application/octet-stream"
        for (name in listOf("", "n".repeat(FILE_NAME_MAX + 1), "a/b", "a\u0000b", "a\nb", "a\u007fb")) {
            refused(message("file-save", "name" to name, "mediaType" to ok))
        }
        refused(message("file-save", "name" to 7, "mediaType" to ok))
        for (type in listOf("", "text", "text/", "/csv", "text/csv; charset=utf-8", "text/c sv", "a/b/c", "x".repeat(128) + "/csv")) {
            refused(message("file-save", "name" to "a", "mediaType" to type))
        }
    }

    @Test
    fun refusesAChunkOutOfRangeOrNotCanonicalBase64() {
        refused(message("file-chunk", "data" to ""))
        val over = Base64.getEncoder().encodeToString(ByteArray(FILE_CHUNK_BYTES + 1))
        refused(message("file-chunk", "data" to over))
        refused(message("file-chunk", "data" to "AAE")) // padding left out
        refused(message("file-chunk", "data" to "AAF=")) // unused bits set
        refused(message("file-chunk", "data" to "-_8=")) // base64url's alphabet
        refused(message("file-chunk", "data" to "AA AA"))
        refused(message("file-chunk", "data" to 7))
    }

    @Test
    fun writesAnswersAndLifecycleMessagesTheWindowTakes() {
        val ok = JSONObject(Answer.ok(7, JSONObject().put("available", true)))
        assertEquals(setOf("v", "id", "ok", "available"), ok.keys().asSequence().toSet())
        assertEquals(1, ok.getInt("v"))
        assertEquals(7L, ok.getLong("id"))
        assertTrue(ok.getBoolean("ok"))
        for (error in ShellError.entries) {
            val e = JSONObject(Answer.error(7, error))
            assertEquals(setOf("v", "id", "ok", "error"), e.keys().asSequence().toSet())
            assertEquals(false, e.getBoolean("ok"))
            assertEquals(error.wire, e.getString("error"))
        }
        assertEquals(
            listOf("invalid", "cancelled", "invalidated", "unavailable", "failed"),
            ShellError.entries.map { it.wire },
        )
        for (state in Lifecycle.entries) {
            val l = JSONObject(Answer.lifecycle(state))
            assertEquals(setOf("v", "type", "state"), l.keys().asSequence().toSet())
            assertEquals("lifecycle", l.getString("type"))
            assertEquals(state.wire, l.getString("state"))
        }
        assertEquals(listOf("hidden", "shown", "screen-off"), Lifecycle.entries.map { it.wire })
    }

    @Test
    fun encodesBytesAsTheWindowDecodesThem() {
        assertEquals("AAEC_-8", base64url(byteArrayOf(0, 1, 2, -1, -17)))
    }
}
