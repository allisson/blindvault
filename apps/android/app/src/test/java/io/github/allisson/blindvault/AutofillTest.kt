package io.github.allisson.blindvault

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertSame
import org.junit.Test
import java.io.File

// android.md §8 (D304): the fields found in a structure, who asks the autofill service, and the requests the
// shell keeps for the provider window.
class AutofillTest {
    private val text = 0x01
    private val password = 0x81
    private val webPassword = 0xe1
    private val visiblePassword = 0x91
    private val email = 0x21
    private val numberPassword = 0x12

    private fun node(
        id: String?,
        textInput: Boolean = true,
        focused: Boolean = false,
        hints: List<String> = emptyList(),
        htmlType: String? = null,
        autocomplete: String? = null,
        inputType: Int = 0,
        webDomain: String? = null,
        webScheme: String? = null,
        children: List<StructureNode<String>> = emptyList(),
    ) = StructureNode(id, textInput, focused, hints, htmlType, autocomplete, inputType, webDomain, webScheme, children)

    private fun find(vararg nodes: StructureNode<String>) = findFields(flatten(nodes.toList()))

    // Fields

    @Test
    fun aPasswordAndTheTextFieldBeforeIt() {
        val found = find(node("search", inputType = text), node("user", inputType = text), node("pass", inputType = password))!!
        assertEquals("user", found.userName)
        assertEquals("pass", found.password)
    }

    @Test
    fun aHintedUserNameWinsOverTheFieldBeforeThePassword() {
        val found = find(
            node("mail", hints = listOf("emailAddress"), inputType = email),
            node("other", inputType = text),
            node("pass", inputType = password),
        )!!
        assertEquals("mail", found.userName)
        assertEquals("pass", found.password)
    }

    @Test
    fun everyPasswordSignalCounts() {
        assertEquals("p", find(node("p", hints = listOf("password")))!!.password)
        assertEquals("p", find(node("p", htmlType = "password"))!!.password)
        assertEquals("p", find(node("p", inputType = password))!!.password)
        assertEquals("p", find(node("p", inputType = webPassword))!!.password)
        assertEquals("p", find(node("p", inputType = visiblePassword))!!.password)
    }

    @Test
    fun aNumberPasswordIsNotOne() {
        assertNull(find(node("u", inputType = text), node("pin", inputType = numberPassword)))
    }

    @Test
    fun aNewPasswordIsNeverFilled() {
        assertNull(find(node("u", inputType = text), node("new", htmlType = "password", autocomplete = "new-password")))
        val change = find(
            node("current", htmlType = "password", autocomplete = "current-password"),
            node("new", htmlType = "password", autocomplete = "section-a new-password"),
        )!!
        assertEquals("current", change.password)
    }

    @Test
    fun aHintedUserNameAloneIsASignInInTwoSteps() {
        val found = find(node("u", htmlType = "email", autocomplete = "username"))!!
        assertEquals("u", found.userName)
        assertNull(found.password)
    }

    @Test
    fun nothingWithoutAPasswordOrAHintedUserName() {
        assertNull(find())
        assertNull(find(node("a", inputType = text), node("b", htmlType = "text")))
        // Not a text input: a password node that takes no text is not a field.
        assertNull(find(node("p", textInput = false, inputType = password)))
        // No autofill ID: nothing to fill.
        assertNull(find(node(null, inputType = password)))
    }

    @Test
    fun theUserNameFallbackIsATextOrEmailField() {
        val found = find(node("check", htmlType = "checkbox"), node("pass", htmlType = "password"))!!
        assertNull(found.userName)
        assertEquals("pass", found.password)
    }

    // Domain

    @Test
    fun aNodeTakesTheDomainOfTheNearestNodeThatSetsOne() {
        val fields = flatten(
            listOf(
                node(
                    null, textInput = false, webDomain = "example.com", webScheme = "https",
                    children = listOf(
                        node("u", inputType = text),
                        node(null, textInput = false, webDomain = "frame.example.net", webScheme = "https", children = listOf(node("p", inputType = password))),
                    ),
                ),
            ),
        )
        assertEquals(listOf("u", "p"), fields.map { it.id })
        assertEquals(listOf("example.com", "frame.example.net"), fields.map { it.webDomain })
    }

    @Test
    fun nothingIsFilledIntoAFrameOfAnotherDomain() {
        val page = node(
            null, textInput = false, webDomain = "example.com", webScheme = "https",
            children = listOf(
                node("u", focused = true, inputType = text),
                node(null, textInput = false, webDomain = "evil.example", webScheme = "https", children = listOf(node("p", inputType = password))),
            ),
        )
        assertNull(find(page))
        val framed = node(
            null, textInput = false, webDomain = "example.com", webScheme = "https",
            children = listOf(
                node("u", inputType = text),
                node(null, textInput = false, webDomain = "login.example.com", webScheme = "https", children = listOf(node("p", focused = true, inputType = password))),
            ),
        )
        val found = find(framed)!!
        assertNull(found.userName)
        assertEquals("p", found.password)
        assertEquals("login.example.com", found.webDomain)
        assertEquals("https", found.webScheme)
    }

    // Who asks

    private val cert = ByteArray(8) { 1 }

    private fun caller(
        packageName: String = "com.android.chrome",
        signers: List<ByteArray>? = listOf(cert),
        scheme: String? = "https",
        domain: String? = "example.com",
        getOrigin: (String) -> String? = { it },
    ) = autofillCallerOf(packageName, "io.github.allisson.blindvault", signers, scheme, domain, getOrigin)

    @Test
    fun anAllowlistedBrowserOnHttpsIsTheSite() {
        assertEquals(Caller.Browser("https://example.com", "com.android.chrome"), caller())
        assertEquals(Caller.Browser("https://example.com:8443", "com.android.chrome"), caller(domain = "Example.COM:8443", scheme = "HTTPS"))
    }

    @Test
    fun anAllowlistedBrowserWithoutHttpsOrADomainGetsNothing() {
        assertSame(Caller.Refused, caller(scheme = "http"))
        assertSame(Caller.Refused, caller(scheme = null))
        assertSame(Caller.Refused, caller(domain = null))
        assertSame(Caller.Refused, caller(domain = "example.com/path"))
        assertSame(Caller.Refused, caller(domain = "exa mple.com"))
    }

    @Test
    fun anyOtherAppIsItselfWhateverDomainItReports() {
        val app = caller(packageName = "org.evil.app") { throw IllegalStateException("not privileged") }
        assertEquals(Caller.App("org.evil.app", listOf(sha256Hex(cert))), app)
        assertEquals(Caller.App("org.evil.app", listOf(sha256Hex(cert))), caller(packageName = "org.evil.app", scheme = null, domain = null) { null })
    }

    @Test
    fun ownPackageNoSignerManySignersOrABadAllowlistGetNothing() {
        assertSame(Caller.Refused, caller(packageName = "io.github.allisson.blindvault"))
        assertSame(Caller.Refused, caller(signers = null))
        assertSame(Caller.Refused, caller(signers = emptyList()))
        assertSame(Caller.Refused, caller(signers = listOf(cert, ByteArray(8) { 2 })))
        assertSame(Caller.Refused, caller { throw IllegalArgumentException("bad allowlist") })
    }

    // Requests kept for the window

    @Test
    fun aRequestIsTakenOnceByItsToken() {
        val requests = AutofillRequests<String>(4) { ByteArray(32).also { java.security.SecureRandom().nextBytes(it) } }
        val pending = PendingAutofill(Caller.App("org.example", listOf("ab")), "u", "p")
        val token = requests.put(pending)
        val other = requests.put(pending)
        assertNotEquals(token, other)
        assertSame(pending, requests.take(token))
        assertNull(requests.take(token))
        assertNull(requests.take("unknown"))
    }

    @Test
    fun theOldestRequestIsDroppedPastTheBound() {
        var n = 0
        val requests = AutofillRequests<String>(2) { ByteArray(32) { (++n).toByte() } }
        val pending = PendingAutofill(Caller.App("org.example", listOf("ab")), null, "p")
        val first = requests.put(pending)
        val second = requests.put(pending)
        val third = requests.put(pending)
        assertNull(requests.take(first))
        assertSame(pending, requests.take(second))
        assertSame(pending, requests.take(third))
    }

    @Test
    fun tokensAreUrlSafeAnd32Bytes() {
        val requests = AutofillRequests<String>(1) { ByteArray(32) { 0xff.toByte() } }
        val token = requests.put(PendingAutofill(Caller.App("a", listOf("ab")), null, "p"))
        assertEquals(43, token.length)
        assertEquals(token, token.filter { it.isLetterOrDigit() || it == '-' || it == '_' })
    }

    // Manifest

    @Test
    fun theAutofillServiceIsBoundBySystemOnly() {
        val manifest = File("src/main/AndroidManifest.xml").readText()
        val service = Regex("""<service\s+android:name="\.FillService"[^>]*>""").find(manifest)!!.value
        assert(service.contains("""android:permission="android.permission.BIND_AUTOFILL_SERVICE"""")) { service }
        assert(manifest.contains("""<action android:name="android.service.autofill.AutofillService" />"""))
    }

    @Test
    fun theServiceCanSeeThePackageThatAsks() {
        // Measured on the A54 (D304): without it, getPackageInfo cannot find the package and no dataset is answered.
        val manifest = File("src/main/AndroidManifest.xml").readText()
        assert(manifest.contains("""<uses-permission android:name="android.permission.QUERY_ALL_PACKAGES" />"""))
    }
}
