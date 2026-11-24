// The autofill service's decisions that need no Android object (android.md §8, D304): the user name and password
// fields of a structure, who asks, and the requests the shell keeps for the provider window under a random token.
// Pure Kotlin, so the JVM tests run it as the app does. Nothing here reads, logs or stores a field's value.
package io.github.allisson.blindvault

/** A node of the `AssistStructure`, as `FillService` copies it; `id` is its autofill ID, `null` when it has none. */
class StructureNode<T>(
    val id: T?,
    /** `autofillType` is `AUTOFILL_TYPE_TEXT`. */
    val textInput: Boolean,
    val focused: Boolean,
    val hints: List<String>,
    /** The HTML `type` attribute, lowercase, or `null`. */
    val htmlType: String?,
    /** The HTML `autocomplete` attribute, or `null`. */
    val htmlAutocomplete: String?,
    val inputType: Int,
    val webDomain: String?,
    val webScheme: String?,
    val children: List<StructureNode<T>>,
)

/** A text input with an autofill ID, with the web domain and scheme of the nearest node that sets a domain. */
class FieldNode<T>(
    val id: T,
    val focused: Boolean,
    val hints: List<String>,
    val htmlType: String?,
    val htmlAutocomplete: String?,
    val inputType: Int,
    val webDomain: String?,
    val webScheme: String?,
)

/** The fields to fill, at least one of them, and the domain they share. */
class FoundFields<T>(val userName: T?, val password: T?, val webDomain: String?, val webScheme: String?)

// android.text.InputType, copied: its constants are not on the JVM the tests run on.
private const val TYPE_MASK_CLASS = 0x0000000f
private const val TYPE_MASK_VARIATION = 0x00000ff0
private const val TYPE_CLASS_TEXT = 0x00000001
private const val VARIATION_NORMAL = 0x00000000
private const val VARIATION_EMAIL_ADDRESS = 0x00000020
private const val VARIATION_PASSWORD = 0x00000080
private const val VARIATION_VISIBLE_PASSWORD = 0x00000090
private const val VARIATION_WEB_EMAIL_ADDRESS = 0x000000d0
private const val VARIATION_WEB_PASSWORD = 0x000000e0

private val PASSWORD_VARIATIONS = setOf(VARIATION_PASSWORD, VARIATION_VISIBLE_PASSWORD, VARIATION_WEB_PASSWORD)
private val TEXT_VARIATIONS = setOf(VARIATION_NORMAL, VARIATION_EMAIL_ADDRESS, VARIATION_WEB_EMAIL_ADDRESS)
private val USER_NAME_HINTS = setOf("username", "emailaddress", "email")

/** The text inputs with an autofill ID, in the structure's order, each with its inherited domain (§8 "Domain"). */
fun <T> flatten(roots: List<StructureNode<T>>): List<FieldNode<T>> {
    val fields = mutableListOf<FieldNode<T>>()
    fun walk(node: StructureNode<T>, domain: String?, scheme: String?) {
        val (d, s) = if (node.webDomain != null) node.webDomain to node.webScheme else domain to scheme
        val id = node.id
        if (node.textInput && id != null) {
            fields += FieldNode(id, node.focused, node.hints, node.htmlType, node.htmlAutocomplete, node.inputType, d, s)
        }
        node.children.forEach { walk(it, d, s) }
    }
    roots.forEach { walk(it, null, null) }
    return fields
}

private fun autocomplete(field: FieldNode<*>): List<String> =
    field.htmlAutocomplete?.lowercase()?.split(Regex("\\s+"))?.filter { it.isNotEmpty() } ?: emptyList()

private fun textClass(field: FieldNode<*>) = field.inputType and TYPE_MASK_CLASS == TYPE_CLASS_TEXT

/** A password field, never a `new-password` one (§8 "Fields"). */
private fun isPassword(field: FieldNode<*>): Boolean {
    if ("new-password" in autocomplete(field)) return false
    return field.hints.any { it.equals("password", ignoreCase = true) } ||
        field.htmlType == "password" ||
        (textClass(field) && field.inputType and TYPE_MASK_VARIATION in PASSWORD_VARIATIONS)
}

private fun isHintedUserName(field: FieldNode<*>): Boolean =
    field.hints.any { it.lowercase() in USER_NAME_HINTS } || autocomplete(field).any { it == "username" || it == "email" }

private fun isTextOrEmail(field: FieldNode<*>): Boolean =
    if (field.htmlType != null) field.htmlType == "text" || field.htmlType == "email"
    else textClass(field) && field.inputType and TYPE_MASK_VARIATION in TEXT_VARIATIONS

/**
 * The user name and password fields (§8 "Fields"), only among those of the focused field's domain, or of the first
 * candidate's when none is focused, so nothing goes into a frame of another domain; `null` when there is neither a
 * password field nor a user name field named by a hint.
 */
fun <T> findFields(fields: List<FieldNode<T>>): FoundFields<T>? {
    val anchor = fields.firstOrNull { it.focused }
        ?: fields.firstOrNull { isPassword(it) || isHintedUserName(it) }
        ?: return null
    val scope = fields.filter { it.webDomain == anchor.webDomain && it.webScheme == anchor.webScheme }
    val first = scope.indexOfFirst { isPassword(it) }
    val hinted = scope.firstOrNull { !isPassword(it) && isHintedUserName(it) }
    if (first < 0 && hinted == null) return null
    val userName = hinted ?: scope.subList(0, first).lastOrNull { isTextOrEmail(it) }
    return FoundFields(userName?.id, scope.getOrNull(first)?.id, anchor.webDomain, anchor.webScheme)
}

/** A web host with an optional port, lowercase: what `https://<webDomain>` may be. */
private val WEB_HOST = Regex("^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*(:[0-9]{1,5})?$")

/**
 * Who asks the autofill service (§8 "Who asks"). `getOrigin` is `CallingAppInfo.getOrigin(allowlist)` for the
 * package and its certificates with the given origin: it returns it for an allowlisted browser, throws
 * `IllegalStateException` for any other package, and `IllegalArgumentException` for a bad allowlist. An allowlisted
 * browser is the site only on `https` with a domain; otherwise it gets nothing. Any other package is an app, the
 * domain it reports ignored. BlindVault itself, a package the service cannot see (`signers` `null`), or one without
 * exactly one signer, gets nothing.
 */
fun autofillCallerOf(
    packageName: String,
    ownPackage: String,
    signers: List<ByteArray>?,
    webScheme: String?,
    webDomain: String?,
    getOrigin: (String) -> String?,
): Caller {
    if (packageName == ownPackage || signers == null || signers.size != 1) return Caller.Refused
    val domain = webDomain?.lowercase()?.takeIf { it.length <= 259 && WEB_HOST.matches(it) }
    val asked = "https://${domain ?: "blindvault.invalid"}"
    val origin = try {
        getOrigin(asked)
    } catch (e: IllegalStateException) {
        null
    } catch (e: IllegalArgumentException) {
        return Caller.Refused
    }
    if (origin == null) return Caller.App(packageName, signers.map { sha256Hex(it) })
    if (!webScheme.equals("https", ignoreCase = true) || domain == null) return Caller.Refused
    return Caller.Browser(asked, packageName)
}

/** An autofill request the window serves: who asks and the fields to fill. */
class PendingAutofill<T>(val caller: Caller, val userName: T?, val password: T?)

/**
 * The autofill requests waiting for the window, each under a random token of 32 bytes the authentication intent
 * carries in its data, which a fill-in cannot replace (D304). Each is taken once; past `max`, the oldest is dropped.
 */
class AutofillRequests<T>(private val max: Int, private val random: () -> ByteArray) {
    private val pending = LinkedHashMap<String, PendingAutofill<T>>()

    @Synchronized
    fun put(request: PendingAutofill<T>): String {
        val token = base64url(random())
        pending[token] = request
        while (pending.size > max) pending.remove(pending.keys.first())
        return token
    }

    @Synchronized
    fun take(token: String): PendingAutofill<T>? = pending.remove(token)
}
