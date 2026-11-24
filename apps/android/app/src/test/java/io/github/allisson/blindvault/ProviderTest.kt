package io.github.allisson.blindvault

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.Base64

// android.md §7.3 and §7.7 (D301): who asks, what the window is told, what the window may answer, and the
// response JSON the shell writes for Credential Manager.
class ProviderTest {
    private val browser = Caller.Browser("https://example.com", "com.android.chrome")
    private val app = Caller.App("org.example.app", listOf("ab".repeat(32)))

    private fun b64url(bytes: ByteArray) = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

    private fun field(length: Int, fill: Int = 1) = b64url(ByteArray(length) { fill.toByte() })

    private fun created(app: Boolean = false) = JSONObject()
        .put("kind", "created")
        .put("id", field(32))
        .put("attestationObject", field(120, 2))
        .put("authenticatorData", field(100, 3))
        .put("publicKey", field(91, 4))
        .put("publicKeyAlgorithm", -7)
        .also { if (app) it.put("clientDataJSON", field(130, 5)) }

    private fun asserted(app: Boolean = false) = JSONObject()
        .put("kind", "asserted")
        .put("id", field(32))
        .put("authenticatorData", field(37, 3))
        .put("signature", field(70, 6))
        .put("userHandle", field(32, 7))
        .also { if (app) it.put("clientDataJSON", field(130, 5)) }

    private fun parse(result: JSONObject, kind: RequestKind, caller: Caller) = parseCallerAnswer(result, kind, caller)

    private fun refused(result: JSONObject, kind: RequestKind, caller: Caller) =
        assertNull(result.toString(), parse(result, kind, caller))

    // Caller

    private val certs = listOf(byteArrayOf(1, 2, 3), byteArrayOf(4, 5))

    @Test
    fun aBrowserThatSetAnOriginInTheAllowlistIsTrusted() {
        assertEquals(
            Caller.Browser("https://example.com", "com.android.chrome"),
            callerOf("com.android.chrome", certs, true) { "https://example.com" },
        )
        // The origin is trusted as `getOrigin` returns it, even when the flag says nothing was set.
        assertEquals(
            Caller.Browser("https://example.com", "com.android.chrome"),
            callerOf("com.android.chrome", certs, false) { "https://example.com" },
        )
    }

    @Test
    fun stripsOneTrailingSlashFromTheOrigin() {
        assertEquals(
            Caller.Browser("https://example.com", "p"),
            callerOf("p", certs, true) { "https://example.com/" },
        )
        assertEquals(
            Caller.Browser("https://example.com:8443", "p"),
            callerOf("p", certs, true) { "https://example.com:8443/" },
        )
    }

    @Test
    fun refusesAnOriginSetByACallerOutsideTheAllowlist() {
        assertEquals(Caller.Refused, callerOf("p", certs, true) { throw IllegalStateException("not privileged") })
    }

    @Test
    fun refusesABadAllowlist() {
        assertEquals(Caller.Refused, callerOf("p", certs, true) { throw IllegalArgumentException("bad json") })
        assertEquals(Caller.Refused, callerOf("p", certs, false) { throw IllegalArgumentException("bad json") })
    }

    @Test
    fun refusesAnOriginPopulatedWithNoOrigin() {
        assertEquals(Caller.Refused, callerOf("p", certs, true) { null })
    }

    @Test
    fun refusesAnEmptyOrigin() {
        assertEquals(Caller.Refused, callerOf("p", certs, true) { "" })
        assertEquals(Caller.Refused, callerOf("p", certs, true) { "/" })
    }

    @Test
    fun aCallerWithNoOriginIsAnAppWithItsCertificatesSha256() {
        val caller = callerOf("org.example.app", certs, false) { null }
        assertEquals(
            Caller.App("org.example.app", listOf(sha256Hex(byteArrayOf(1, 2, 3)), sha256Hex(byteArrayOf(4, 5)))),
            caller,
        )
        caller as Caller.App
        for (hash in caller.certSha256) assertTrue(hash, Regex("^[0-9a-f]{64}$").matches(hash))
    }

    @Test
    fun inThisChangeOnlyABrowserIsServed() {
        assertTrue(servesCaller(browser))
        assertFalse(servesCaller(app))
        assertFalse(servesCaller(Caller.Refused))
    }

    // provider-request

    private val hash = ByteArray(32) { it.toByte() }

    @Test
    fun answersTheWindowAGetFromABrowser() {
        val request = providerRequestOf(RequestKind.GET, browser, """{"challenge":"x"}""", hash)!!
        val fields = providerRequestFields(request)
        assertEquals(setOf("kind", "caller", "requestJson", "clientDataHash"), fields.keys().asSequence().toSet())
        assertEquals("get", fields.getString("kind"))
        assertEquals("""{"challenge":"x"}""", fields.getString("requestJson"))
        assertEquals(b64url(hash), fields.getString("clientDataHash"))
        val caller = fields.getJSONObject("caller")
        assertEquals(setOf("kind", "origin", "packageName"), caller.keys().asSequence().toSet())
        assertEquals("browser", caller.getString("kind"))
        assertEquals("https://example.com", caller.getString("origin"))
        assertEquals("com.android.chrome", caller.getString("packageName"))
    }

    @Test
    fun answersTheWindowACreateAndAnAppWithNoClientDataHash() {
        val create = providerRequestFields(providerRequestOf(RequestKind.CREATE, browser, "{}", hash)!!)
        assertEquals("create", create.getString("kind"))
        val fromApp = providerRequestFields(providerRequestOf(RequestKind.GET, app, "{}", null)!!)
        assertEquals(setOf("kind", "caller", "requestJson"), fromApp.keys().asSequence().toSet())
        val caller = fromApp.getJSONObject("caller")
        assertEquals(setOf("kind", "packageName", "certSha256"), caller.keys().asSequence().toSet())
        assertEquals("app", caller.getString("kind"))
        assertEquals("org.example.app", caller.getString("packageName"))
        assertEquals(JSONArray(listOf("ab".repeat(32))).toString(), caller.getJSONArray("certSha256").toString())
    }

    @Test
    fun anAppGetsNoClientDataHashEvenIfOneIsPassed() {
        val request = providerRequestOf(RequestKind.GET, app, "{}", hash)!!
        assertNull(request.clientDataHash)
        assertFalse(providerRequestFields(request).has("clientDataHash"))
    }

    @Test
    fun refusesABrowserRequestWithoutAClientDataHashOf32Bytes() {
        assertNull(providerRequestOf(RequestKind.GET, browser, "{}", null))
        assertNull(providerRequestOf(RequestKind.GET, browser, "{}", ByteArray(31)))
        assertNull(providerRequestOf(RequestKind.GET, browser, "{}", ByteArray(33)))
        assertNull(providerRequestOf(RequestKind.CREATE, browser, "{}", ByteArray(0)))
    }

    @Test
    fun refusesARefusedCaller() {
        assertNull(providerRequestOf(RequestKind.GET, Caller.Refused, "{}", hash))
    }

    @Test
    fun boundsTheRequestJsonAt64KibOfUtf8() {
        assertNotNull(providerRequestOf(RequestKind.GET, browser, "x".repeat(REQUEST_JSON_MAX), hash))
        assertNull(providerRequestOf(RequestKind.GET, browser, "x".repeat(REQUEST_JSON_MAX + 1), hash))
        // Bytes, not characters: 32,769 two-byte characters are 65,538 bytes.
        assertNotNull(providerRequestOf(RequestKind.GET, browser, "é".repeat(REQUEST_JSON_MAX / 2), hash))
        assertNull(providerRequestOf(RequestKind.GET, browser, "é".repeat(REQUEST_JSON_MAX / 2 + 1), hash))
    }

    // provider-result: what the window may answer

    @Test
    fun acceptsACreatedAndAnAssertedResult() {
        val c = parse(created(), RequestKind.CREATE, browser) as CallerAnswer.Created
        assertEquals(field(32), c.id)
        assertEquals(field(120, 2), c.attestationObject)
        assertEquals(field(100, 3), c.authenticatorData)
        assertEquals(field(91, 4), c.publicKey)
        assertEquals(-7, c.publicKeyAlgorithm)
        assertNull(c.clientDataJson)
        val withClientData = parse(created(app = true), RequestKind.CREATE, app) as CallerAnswer.Created
        assertEquals(field(130, 5), withClientData.clientDataJson)
        val a = parse(asserted(), RequestKind.GET, browser) as CallerAnswer.Asserted
        assertEquals(field(70, 6), a.signature)
        assertEquals(field(32, 7), a.userHandle)
        assertNull(a.clientDataJson)
        val appAsserted = parse(asserted(app = true), RequestKind.GET, app) as CallerAnswer.Asserted
        assertEquals(field(130, 5), appAsserted.clientDataJson)
        assertEquals(-8, (parse(created().put("publicKeyAlgorithm", -8), RequestKind.CREATE, browser) as CallerAnswer.Created).publicKeyAlgorithm)
    }

    @Test
    fun acceptsErrorCancelledAndBrowserForBothKinds() {
        for (kind in RequestKind.entries) {
            assertEquals(
                CallerAnswer.Dom(DomError.NOT_ALLOWED),
                parse(JSONObject().put("kind", "error").put("name", "NotAllowedError"), kind, browser),
            )
            assertEquals(CallerAnswer.Cancelled, parse(JSONObject().put("kind", "cancelled"), kind, browser))
            assertEquals(CallerAnswer.UseAnother, parse(JSONObject().put("kind", "browser"), kind, browser))
        }
        assertEquals(
            CallerAnswer.Dom(DomError.INVALID_STATE),
            parse(JSONObject().put("kind", "error").put("name", "InvalidStateError"), RequestKind.CREATE, browser),
        )
    }

    @Test
    fun checksTheKindAgainstThePendingRequest() {
        refused(created(), RequestKind.GET, browser)
        refused(asserted(), RequestKind.CREATE, browser)
        refused(JSONObject().put("kind", "error").put("name", "InvalidStateError"), RequestKind.GET, browser)
    }

    @Test
    fun refusesAnUnknownOrMistypedKindOrErrorName() {
        refused(JSONObject(), RequestKind.GET, browser)
        for (kind in listOf<Any?>("Created", "created ", "", "error2", "lifecycle", 7, true, null, JSONObject())) {
            refused(JSONObject().put("kind", kind ?: JSONObject.NULL), RequestKind.CREATE, browser)
        }
        for (name in listOf<Any?>("SecurityError", "notallowederror", "", "AbortError", "UnknownError", 7, null)) {
            refused(JSONObject().put("kind", "error").put("name", name ?: JSONObject.NULL), RequestKind.CREATE, browser)
        }
        refused(JSONObject().put("kind", "error"), RequestKind.GET, browser)
    }

    @Test
    fun refusesKeysTheKindDoesNotTake() {
        refused(JSONObject().put("kind", "cancelled").put("name", "NotAllowedError"), RequestKind.GET, browser)
        refused(JSONObject().put("kind", "browser").put("id", field(32)), RequestKind.GET, browser)
        refused(JSONObject().put("kind", "error").put("name", "NotAllowedError").put("message", "x"), RequestKind.GET, browser)
        refused(created().put("extra", 1), RequestKind.CREATE, browser)
        refused(asserted().put("attestationObject", field(10)), RequestKind.GET, browser)
        refused(created().put("signature", field(10)), RequestKind.CREATE, browser)
        refused(asserted().put("publicKey", field(10)), RequestKind.GET, browser)
        refused(created(app = true).put("extra", JSONObject.NULL), RequestKind.CREATE, app)
    }

    @Test
    fun refusesAMissingField() {
        for (key in created().keys().asSequence().filter { it != "kind" }.toList()) {
            refused(created().apply { remove(key) }, RequestKind.CREATE, browser)
        }
        for (key in asserted().keys().asSequence().filter { it != "kind" }.toList()) {
            refused(asserted().apply { remove(key) }, RequestKind.GET, browser)
        }
    }

    @Test
    fun boundsEveryByteField() {
        val bounds = mapOf(
            "id" to (1..1023),
            "userHandle" to (1..64),
            "signature" to (1..80),
            "authenticatorData" to (37..1024),
            "attestationObject" to (1..2048),
            "publicKey" to (1..512),
            "clientDataJSON" to (1..4096),
        )
        for ((key, range) in bounds) {
            for ((base, kind, caller) in listOf(
                Triple({ created(true) }, RequestKind.CREATE, app),
                Triple({ asserted(true) }, RequestKind.GET, app),
            )) {
                if (!base().has(key)) continue
                assertNotNull("$key min", parse(base().put(key, field(range.first)), kind, caller))
                assertNotNull("$key max", parse(base().put(key, field(range.last)), kind, caller))
                refused(base().put(key, field(range.last + 1)), kind, caller)
                if (range.first > 1) refused(base().put(key, field(range.first - 1)), kind, caller)
                refused(base().put(key, ""), kind, caller)
            }
        }
    }

    @Test
    fun refusesBytesNotInCanonicalBase64urlWithoutPadding() {
        val bad = listOf(
            field(32) + "=", // padding
            field(31) + "==",
            "AAAAAAAAAAAAAAAAAAAAAB", // unused bits set
            Base64.getEncoder().withoutPadding().encodeToString(ByteArray(32) { -5 }), // standard alphabet
            "AAAA AAAA",
            "AAAAA", // 5 characters: no byte count
            "AA\nAA",
        )
        for (key in listOf("id", "attestationObject", "authenticatorData", "publicKey")) {
            for (text in bad) refused(created().put(key, text), RequestKind.CREATE, browser)
        }
        for (key in listOf("id", "authenticatorData", "signature", "userHandle")) {
            for (text in bad) refused(asserted().put(key, text), RequestKind.GET, browser)
        }
        for (text in bad) refused(created(app = true).put("clientDataJSON", text), RequestKind.CREATE, app)
    }

    @Test
    fun refusesAByteFieldOfAnotherType() {
        for (value in listOf<Any>(7, true, 1.5, JSONArray(), JSONObject(), JSONObject.NULL)) {
            refused(created().put("id", value), RequestKind.CREATE, browser)
            refused(asserted().put("signature", value), RequestKind.GET, browser)
            refused(asserted().put("userHandle", value), RequestKind.GET, browser)
        }
    }

    @Test
    fun acceptsOnlyTheAlgorithmsEs256AndEdDsa() {
        for (algorithm in listOf<Any>(-257, -35, 0, 7, -9, -6, -7.5, -7.0, "-7", "ES256", true, JSONObject.NULL, Long.MAX_VALUE)) {
            refused(created().put("publicKeyAlgorithm", algorithm), RequestKind.CREATE, browser)
        }
        refused(created().apply { remove("publicKeyAlgorithm") }, RequestKind.CREATE, browser)
    }

    @Test
    fun clientDataJsonBelongsToAnAppOnly() {
        refused(created().put("clientDataJSON", field(130)), RequestKind.CREATE, browser)
        refused(asserted().put("clientDataJSON", field(130)), RequestKind.GET, browser)
        refused(created(app = false), RequestKind.CREATE, app)
        refused(asserted(app = false), RequestKind.GET, app)
    }

    @Test
    fun aRefusedCallerGetsNoResultAtAll() {
        refused(created(), RequestKind.CREATE, Caller.Refused)
        refused(asserted(), RequestKind.GET, Caller.Refused)
        refused(JSONObject().put("kind", "cancelled"), RequestKind.GET, Caller.Refused)
    }

    // The response JSON for Credential Manager

    private fun keys(json: JSONObject) = json.keys().asSequence().toSet()

    /** The value with every object's keys sorted: JSON equality, whatever order `JSONObject` keeps. */
    private fun canonical(value: Any?): String = when (value) {
        is JSONObject -> value.keys().asSequence().sorted().joinToString(",", "{", "}") { "\"$it\":" + canonical(value.get(it)) }
        is JSONArray -> List(value.length()) { canonical(value.get(it)) }.joinToString(",", "[", "]")
        is String -> JSONObject.quote(value)
        else -> value.toString()
    }

    @Test
    fun writesTheCreatedResponse() {
        val answer = parse(created(), RequestKind.CREATE, browser) as CallerAnswer.Created
        val expected = JSONObject()
            .put("id", field(32))
            .put("rawId", field(32))
            .put("type", "public-key")
            .put("authenticatorAttachment", "platform")
            .put(
                "response",
                JSONObject()
                    .put("attestationObject", field(120, 2))
                    .put("authenticatorData", field(100, 3))
                    .put("transports", JSONArray(listOf("internal", "hybrid")))
                    .put("publicKey", field(91, 4))
                    .put("publicKeyAlgorithm", -7),
            )
            .put("clientExtensionResults", JSONObject().put("credProps", JSONObject().put("rk", true)))
        val json = responseJson(answer)
        assertEquals(json, canonical(expected), canonical(JSONObject(json)))
        assertEquals(
            listOf("internal", "hybrid"),
            JSONObject(json).getJSONObject("response").getJSONArray("transports").let { t -> List(t.length()) { t.getString(it) } },
        )
        assertFalse(json.contains("clientDataJSON"))
    }

    @Test
    fun writesTheCreatedResponseWithClientDataJson() {
        val answer = parse(created(app = true), RequestKind.CREATE, app) as CallerAnswer.Created
        val response = JSONObject(responseJson(answer)).getJSONObject("response")
        assertEquals(field(130, 5), response.getString("clientDataJSON"))
        assertEquals(
            setOf("attestationObject", "authenticatorData", "transports", "publicKey", "publicKeyAlgorithm", "clientDataJSON"),
            keys(response),
        )
    }

    @Test
    fun writesTheAssertedResponse() {
        val answer = parse(asserted(), RequestKind.GET, browser) as CallerAnswer.Asserted
        val expected = JSONObject()
            .put("id", field(32))
            .put("rawId", field(32))
            .put("type", "public-key")
            .put("authenticatorAttachment", "platform")
            .put(
                "response",
                JSONObject()
                    .put("authenticatorData", field(37, 3))
                    .put("signature", field(70, 6))
                    .put("userHandle", field(32, 7)),
            )
            .put("clientExtensionResults", JSONObject())
        val json = responseJson(answer)
        assertEquals(json, canonical(expected), canonical(JSONObject(json)))
        assertFalse(json.contains("clientDataJSON"))
        assertFalse(json.contains("credProps"))
    }

    @Test
    fun writesTheAssertedResponseWithClientDataJson() {
        val answer = parse(asserted(app = true), RequestKind.GET, app) as CallerAnswer.Asserted
        val response = JSONObject(responseJson(answer)).getJSONObject("response")
        assertEquals(field(130, 5), response.getString("clientDataJSON"))
        assertEquals(setOf("authenticatorData", "signature", "userHandle", "clientDataJSON"), keys(response))
    }

    @Test
    fun theResponseHasNoNullAndNoPadding() {
        val texts = listOf(
            responseJson(parse(created(), RequestKind.CREATE, browser) as CallerAnswer.Created),
            responseJson(parse(created(app = true), RequestKind.CREATE, app) as CallerAnswer.Created),
            responseJson(parse(asserted(), RequestKind.GET, browser) as CallerAnswer.Asserted),
            responseJson(parse(asserted(app = true), RequestKind.GET, app) as CallerAnswer.Asserted),
        )
        for (text in texts) {
            assertFalse(text, text.contains("null"))
            assertFalse(text, text.contains("="))
            assertFalse(text, text.contains("+"))
            assertFalse(text, text.contains("/"))
        }
    }

    @Test
    fun theWireNamesAreThoseOfTheDocument() {
        assertEquals(listOf("get", "create"), RequestKind.entries.map { it.wire })
        assertEquals(listOf("NotAllowedError", "InvalidStateError"), DomError.entries.map { it.wire })
    }
}
