package io.github.allisson.blindvault

import org.json.JSONArray
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

// android.md §7.4 (D303): which domains the shell fetches, and whether an `assetlinks.json` binds an app.
// The fetch itself needs the network and is not run here.
class AssetLinksTest {
    @Test
    fun takesALowercaseAsciiHostNameWithADot() {
        for (domain in listOf("example.com", "a-b.example.co.uk", "a.b", "x1.example.com", "example.123abc", "a".repeat(63) + ".com")) {
            assertEquals(domain, assetLinksDomain(domain))
        }
        val longest = listOf("a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(61)).joinToString(".")
        assertEquals(253, longest.length)
        assertEquals(longest, assetLinksDomain(longest))
    }

    @Test
    fun refusesWhatIsNotALowercaseAsciiHostNameWithADot() {
        val tooLong = listOf("a".repeat(63), "b".repeat(63), "c".repeat(63), "d".repeat(62)).joinToString(".")
        assertEquals(254, tooLong.length)
        for (domain in listOf(
            "Example.com", "EXAMPLE.COM", "example.Com",
            "1.2.3.4", "127.0.0.1", "example.123",
            "localhost", "com", "",
            "example.com.", ".example.com", "example..com", ".",
            "-a.example.com", "a-.example.com", "example.-com", "example.com-",
            "a".repeat(64) + ".com", "example." + "a".repeat(64),
            tooLong,
            "exämple.com", "例え.jp", "xn--e1afmkfd.xn--p1aié",
            "exa_mple.com", "example.com:443", "example.com/x", "example.com/", "user@example.com", "exa mple.com",
            "example.com\n", "\nexample.com", "example.com?x", "example.com#x", "[::1]", "a.b ",
        )) {
            assertNull(domain, assetLinksDomain(domain))
        }
    }

    private val sha = "ab".repeat(32)
    private val other = "cd".repeat(32)
    private val relation = "delegate_permission/common.get_login_creds"

    private fun statement(
        relations: List<Any?> = listOf(relation),
        namespace: Any? = "android_app",
        packageName: Any? = "org.example.app",
        fingerprints: List<Any?> = listOf(sha.uppercase().chunked(2).joinToString(":")),
    ) = JSONObject()
        .put("relation", JSONArray(relations))
        .put(
            "target",
            JSONObject()
                .put("namespace", namespace ?: JSONObject.NULL)
                .put("package_name", packageName ?: JSONObject.NULL)
                .put("sha256_cert_fingerprints", JSONArray(fingerprints)),
        )

    private fun binds(vararg statements: Any, certs: List<String> = listOf(sha)) =
        bindsApp(JSONArray(statements.toList()).toString(), "org.example.app", certs)

    @Test
    fun anAppIsBoundByAMatchingStatement() {
        assertTrue(binds(statement()))
        assertTrue(binds(statement(packageName = "org.other"), statement()))
        assertTrue(binds(statement(relations = listOf("delegate_permission/common.handle_all_urls", relation))))
    }

    @Test
    fun comparesFingerprintsWithoutColonsAndCase() {
        assertTrue(binds(statement(fingerprints = listOf(sha))))
        assertTrue(binds(statement(fingerprints = listOf(sha.uppercase()))))
        assertTrue(binds(statement(fingerprints = listOf(sha.chunked(2).joinToString(":")))))
        assertTrue(binds(statement(fingerprints = listOf(other, sha.uppercase().chunked(2).joinToString(":")))))
        assertFalse(binds(statement(fingerprints = listOf(other))))
        assertFalse(binds(statement(fingerprints = emptyList())))
    }

    @Test
    fun anAppIsNotBoundByAnotherRelationNamespaceOrPackage() {
        assertFalse(binds(statement(relations = listOf("delegate_permission/common.handle_all_urls"))))
        assertFalse(binds(statement(relations = emptyList())))
        assertFalse(binds(statement(namespace = "web")))
        assertFalse(binds(statement(namespace = "Android_App")))
        assertFalse(binds(statement(packageName = "org.example.app2")))
        assertFalse(binds(statement(packageName = "ORG.EXAMPLE.APP")))
        assertFalse(binds())
    }

    @Test
    fun everySignerMustBeListed() {
        val two = listOf(sha, other)
        assertFalse(binds(statement(), certs = two))
        assertTrue(binds(statement(fingerprints = listOf(sha, other)), certs = two))
        assertTrue(binds(statement(fingerprints = listOf(other.uppercase(), sha, "ef".repeat(32))), certs = two))
        // Each signer in a statement of its own does not count: one statement lists them all.
        assertFalse(binds(statement(fingerprints = listOf(sha)), statement(fingerprints = listOf(other)), certs = two))
        // No signer to match binds nothing.
        assertFalse(binds(statement(), certs = emptyList()))
    }

    @Test
    fun anythingButAnArrayOfStatementsBindsNothing() {
        val text = statement().toString()
        for (json in listOf("", "not json", "{}", text, "\"x\"", "7", "null", "[", "[{", "]", "{\"a\":[$text]}")) {
            assertFalse(json, bindsApp(json, "org.example.app", listOf(sha)))
        }
    }

    @Test
    fun skipsGarbageWithoutThrowing() {
        val bad = listOf<Any>(
            7, "x", true, JSONObject.NULL, JSONArray(), JSONObject(),
            JSONObject().put("relation", "x").put("target", "y"),
            JSONObject().put("relation", JSONArray(listOf(7, JSONObject.NULL, JSONObject()))).put("target", JSONObject()),
            JSONObject().put("relation", JSONArray(listOf(relation))),
            JSONObject().put("relation", JSONArray(listOf(relation))).put("target", JSONArray()),
            JSONObject().put("relation", JSONArray(listOf(relation))).put("target", JSONObject().put("namespace", "android_app")),
            statement(fingerprints = listOf(7, JSONObject.NULL, JSONObject(), JSONArray())),
            statement(packageName = 7),
            statement(namespace = 7),
        )
        assertFalse(binds(*bad.toTypedArray()))
        assertTrue(binds(*(bad + statement()).toTypedArray()))
        assertTrue(binds(statement(fingerprints = listOf(7, JSONObject.NULL, sha))))
    }

    private val body = JSONArray(listOf(statement())).toString()
    private fun classify(status: Int, type: String?, text: String?) = bindingOf(status, type, text, "org.example.app", listOf(sha))

    @Test
    fun aRedirectBindsNothingAndIsSaidSo() {
        for (status in listOf(300, 301, 302, 303, 307, 308, 399)) {
            assertEquals("$status", Binding.REDIRECT, classify(status, "application/json", body))
            assertEquals("$status", Binding.REDIRECT, classify(status, null, null))
        }
    }

    @Test
    fun anotherStatusIsUnbound() {
        for (status in listOf(100, 201, 204, 299, 400, 403, 404, 410, 500, 503, 0, -1)) {
            assertEquals("$status", Binding.UNBOUND, classify(status, "application/json", body))
        }
    }

    @Test
    fun aJsonBodyThatNamesTheAppIsBound() {
        assertEquals(Binding.BOUND, classify(200, "application/json", body))
        assertEquals(Binding.BOUND, classify(200, "application/json; charset=utf-8", body))
        assertEquals(Binding.BOUND, classify(200, " Application/JSON ;charset=UTF-8", body))
    }

    @Test
    fun anotherMediaTypeOrABodyThatDoesNotNameTheAppIsUnbound() {
        for (type in listOf("text/html", "text/plain", "application/jsonp", "application/json5", "application/ld+json", "json", "", null)) {
            assertEquals("$type", Binding.UNBOUND, classify(200, type, body))
        }
        assertEquals(Binding.UNBOUND, classify(200, "application/json", "[]"))
        assertEquals(Binding.UNBOUND, classify(200, "application/json", "not json"))
        assertEquals(Binding.UNBOUND, classify(200, "application/json", "{}"))
        assertEquals(Binding.UNBOUND, classify(200, "application/json", JSONArray(listOf(statement(packageName = "x"))).toString()))
    }

    @Test
    fun noBodyIsTheNetworks() {
        assertEquals(Binding.NETWORK, classify(200, "application/json", null))
        assertEquals(Binding.NETWORK, classify(200, "application/json; charset=utf-8", null))
        // The status and media type decide first.
        assertEquals(Binding.UNBOUND, classify(404, "application/json", null))
        assertEquals(Binding.UNBOUND, classify(200, "text/html", null))
    }

    @Test
    fun theWireNamesAreThoseOfTheDocument() {
        assertEquals(listOf("bound", "unbound", "redirect", "network"), Binding.entries.map { it.wire })
    }
}
