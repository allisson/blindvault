// The credential provider's decisions that need no Android object (android.md §7.3 to §7.7, D301, D303): who
// asks, what the provider window is told about the request, what it may answer, whether an app is bound to
// a domain by its `assetlinks.json`, and the response JSON written for Credential Manager. Pure Kotlin on org.json, so the JVM tests run it as the app does. The shell
// never sees a key: a signed response passes through it toward the caller that asked.
package io.github.allisson.blindvault

import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

/** The most UTF-8 bytes of the WebAuthn options JSON the window is given (§7.7). */
const val REQUEST_JSON_MAX = 64 * 1024

/** A SHA-256 digest: the `clientDataHash` of a privileged browser. */
const val CLIENT_DATA_HASH_LENGTH = 32

enum class RequestKind(val wire: String) {
    GET("get"),
    CREATE("create"),

    /** A password of a Login item (§7.6, D303). */
    PASSWORD("password"),
}

/** The public-key DOM exceptions the window may ask for (§7.1 "Ending"). */
enum class DomError(val wire: String) {
    NOT_ALLOWED("NotAllowedError"),
    INVALID_STATE("InvalidStateError"),
}

/** Who asks (§7.3). */
sealed interface Caller {
    /** A privileged browser, and the origin it set: the site's. */
    data class Browser(val origin: String, val packageName: String) : Caller

    /** No origin set: a native app, with the SHA-256 of each signing certificate, lowercase hex. */
    data class App(val packageName: String, val certSha256: List<String>) : Caller

    /** An origin set by a caller outside the allowlist, or an allowlist `getOrigin` refused: nothing is served. */
    data object Refused : Caller
}

/**
 * The caller, from `CallingAppInfo.getOrigin(allowlist)` as `getOrigin`. An origin it returns is the
 * privileged browser's; `IllegalStateException`, an origin set by a caller outside the allowlist, and
 * `IllegalArgumentException`, a bad allowlist, refuse; `null` is an app, unless the caller did set an
 * origin (`originPopulated`), which is refused. An app that does not have exactly one current signer is
 * refused too: its `android:apk-key-hash` origin would name one of them (§7.3, D303).
 */
fun callerOf(
    packageName: String,
    signingCertificates: List<ByteArray>,
    originPopulated: Boolean,
    getOrigin: () -> String?,
): Caller {
    val origin = try {
        getOrigin()
    } catch (e: IllegalStateException) {
        return Caller.Refused
    } catch (e: IllegalArgumentException) {
        return Caller.Refused
    }
    if (origin != null) {
        val site = origin.removeSuffix("/")
        return if (site.isEmpty()) Caller.Refused else Caller.Browser(site, packageName)
    }
    if (originPopulated) return Caller.Refused
    if (signingCertificates.size != 1) return Caller.Refused
    return Caller.App(packageName, signingCertificates.map { sha256Hex(it) })
}

/**
 * Who gets entries and credentials: a privileged browser or an app, never a refused caller (§7.2, D303). Whether
 * an app is bound to a domain is checked in the window (§7.4), not here.
 */
fun servesCaller(caller: Caller): Boolean = caller !== Caller.Refused

/** The request the window is told about. */
class ProviderRequest(
    val kind: RequestKind,
    val caller: Caller,
    /** The WebAuthn options JSON of a passkey request; `null` for a password (§7.7). */
    val requestJson: String?,
    /** 32 bytes, from a privileged browser only. */
    val clientDataHash: ByteArray?,
)

/**
 * The request for the window, `null` when the caller is refused, the options JSON of a passkey request is
 * missing or over its bound, or a browser passed no `clientDataHash` of 32 bytes: the activity then answers
 * `NotAllowedError` without loading the window. An app's `clientDataJSON` is the window's own, so it gets no
 * hash. A password request has neither options JSON nor hash: both are ignored, whoever asks (§7.7).
 */
fun providerRequestOf(kind: RequestKind, caller: Caller, requestJson: String?, clientDataHash: ByteArray?): ProviderRequest? {
    if (caller === Caller.Refused) return null
    if (kind == RequestKind.PASSWORD) return ProviderRequest(kind, caller, null, null)
    if (requestJson == null || requestJson.toByteArray(Charsets.UTF_8).size > REQUEST_JSON_MAX) return null
    val hash = if (caller is Caller.Browser) {
        if (clientDataHash == null || clientDataHash.size != CLIENT_DATA_HASH_LENGTH) return null
        clientDataHash
    } else {
        null
    }
    return ProviderRequest(kind, caller, requestJson, hash)
}

/** The answer to `provider-request` (§7.7): `requestJson` is absent for a password. */
fun providerRequestFields(request: ProviderRequest): JSONObject {
    val caller = JSONObject()
    when (val c = request.caller) {
        is Caller.Browser -> caller.put("kind", "browser").put("origin", c.origin).put("packageName", c.packageName)
        is Caller.App -> caller.put("kind", "app").put("packageName", c.packageName).put("certSha256", JSONArray(c.certSha256))
        Caller.Refused -> throw IllegalArgumentException("a refused caller gets no request")
    }
    val fields = JSONObject()
        .put("kind", request.kind.wire)
        .put("caller", caller)
    request.requestJson?.let { fields.put("requestJson", it) }
    request.clientDataHash?.let { fields.put("clientDataHash", base64url(it)) }
    return fields
}

/** What the activity answers Credential Manager, from the window's `provider-result` or its own failure. */
sealed interface CallerAnswer {
    /** Byte fields are canonical base64url without padding, within their bounds. */
    class Created(
        val id: String,
        val attestationObject: String,
        val authenticatorData: String,
        val publicKey: String,
        val publicKeyAlgorithm: Int,
        val clientDataJson: String?,
    ) : CallerAnswer

    class Asserted(
        val id: String,
        val authenticatorData: String,
        val signature: String,
        val userHandle: String,
        val clientDataJson: String?,
    ) : CallerAnswer

    /** The user name and password of the login the user picked, for a `GetCredentialResponse` (§7.6, D303). */
    class Password(val userName: String, val password: String) : CallerAnswer

    /** The public-key DOM exception of that name. */
    data class Dom(val error: DomError) : CallerAnswer

    /** A cancellation exception: it ends the caller's call. */
    data object Cancelled : CallerAnswer

    /** "Use another authenticator": `RESULT_CANCELED`, and Android shows its sheet again. */
    data object UseAnother : CallerAnswer

    /** The shell could not read the request Credential Manager passed. Never from the window. */
    data object Unknown : CallerAnswer
}

// Byte bounds of §7.7, decoded.
private val ID_BYTES = 1..1023
private val USER_HANDLE_BYTES = 1..64
private val SIGNATURE_BYTES = 1..80
private val AUTHENTICATOR_DATA_BYTES = 37..1024
private val ATTESTATION_OBJECT_BYTES = 1..2048
private val PUBLIC_KEY_BYTES = 1..512
private val CLIENT_DATA_JSON_BYTES = 1..4096

/** ES256 and EdDSA, the algorithms the window signs with (§7.5). */
private val ALGORITHMS = setOf(-7L, -8L)

private const val CLIENT_DATA_JSON = "clientDataJSON"

/** The characters of a `password` result's `userName` and `password` (§7.7). */
private const val CREDENTIAL_TEXT_MAX = 16384

/**
 * The packages of Google's privileged list that are not browsers (`privileged-apps.txt`): trusted for
 * passkeys as listed, but never for the `webDomain` autofill reads, which only a browser sets for a site
 * (android.md §8, D309).
 */
val NOT_BROWSERS = setOf(
    "com.google.android.gms",
    "com.fido.fido2client",
    "com.oplus.credential",
    "com.citrix.Receiver",
    "io.github.jqssun.helium",
)

/** The allowlist's JSON without the entries of `NOT_BROWSERS`, in the same structure `getOrigin` takes. */
fun browsersOnly(allowlist: String): String {
    val json = JSONObject(allowlist)
    val apps = json.getJSONArray("apps")
    val kept = JSONArray()
    for (i in 0 until apps.length()) {
        val app = apps.getJSONObject(i)
        if (app.getJSONObject("info").getString("package_name") !in NOT_BROWSERS) kept.put(app)
    }
    return json.put("apps", kept).toString()
}

/** The `rpId` a passkey request's `requestJson` names: `rpId` for a get, `rp.id` for a create; `null` without one. */
fun requestRpId(kind: RequestKind, requestJson: String?): String? {
    val json = try {
        JSONObject(requestJson ?: return null)
    } catch (e: JSONException) {
        return null
    }
    val rpId = when (kind) {
        RequestKind.GET -> json.opt("rpId")
        RequestKind.CREATE -> json.optJSONObject("rp")?.opt("id")
        RequestKind.PASSWORD -> null
    }
    return (rpId as? String)?.takeIf { it.isNotEmpty() }
}

/**
 * Whether an app's credential may go out (§7.4, AND-1): for a passkey, the `rpId` its request names is one of
 * the domains this request got `bound` for; for a password, whose result names no domain, any of them. A
 * browser's origin is the site's: nothing to check.
 */
private fun appBound(kind: RequestKind, caller: Caller, bound: Set<String>, requestJson: String?): Boolean {
    if (caller !is Caller.App) return true
    if (kind == RequestKind.PASSWORD) return bound.isNotEmpty()
    val rpId = requestRpId(kind, requestJson) ?: return false
    return rpId.lowercase() in bound
}

/**
 * `provider-result`'s `result` checked against the pending request and its caller (§7.7): the kind, each
 * key, every byte field canonical and bounded, `clientDataJSON` present for an app only. `bound` holds the
 * domains this request got a `bound` answer to `provider-assetlinks` for (§7.4): an app gets a passkey only
 * for the `rpId` its `requestJson` names, when bound, and a password only once a domain is bound. A
 * `password` result belongs to a password request, which takes no `created`, `asserted` or `error`. `null`
 * for anything else; the activity then answers `invalid` and ends with a cancellation.
 */
fun parseCallerAnswer(
    result: JSONObject,
    kind: RequestKind,
    caller: Caller,
    bound: Set<String>,
    requestJson: String?,
): CallerAnswer? {
    if (caller === Caller.Refused) return null
    val keys = result.keys().asSequence().toSet()
    val app = caller is Caller.App
    val allowed = appBound(kind, caller, bound, requestJson)
    val clientData = if (app) setOf(CLIENT_DATA_JSON) else emptySet()
    return when (result.opt("kind") as? String) {
        "created" -> {
            if (kind != RequestKind.CREATE || !allowed) return null
            if (keys != setOf("kind", "id", "attestationObject", "authenticatorData", "publicKey", "publicKeyAlgorithm") + clientData) return null
            CallerAnswer.Created(
                id = field(result, "id", ID_BYTES) ?: return null,
                attestationObject = field(result, "attestationObject", ATTESTATION_OBJECT_BYTES) ?: return null,
                authenticatorData = field(result, "authenticatorData", AUTHENTICATOR_DATA_BYTES) ?: return null,
                publicKey = field(result, "publicKey", PUBLIC_KEY_BYTES) ?: return null,
                publicKeyAlgorithm = integer(result.opt("publicKeyAlgorithm"))?.takeIf { it in ALGORITHMS }?.toInt() ?: return null,
                clientDataJson = if (app) field(result, CLIENT_DATA_JSON, CLIENT_DATA_JSON_BYTES) ?: return null else null,
            )
        }
        "asserted" -> {
            if (kind != RequestKind.GET || !allowed) return null
            if (keys != setOf("kind", "id", "authenticatorData", "signature", "userHandle") + clientData) return null
            CallerAnswer.Asserted(
                id = field(result, "id", ID_BYTES) ?: return null,
                authenticatorData = field(result, "authenticatorData", AUTHENTICATOR_DATA_BYTES) ?: return null,
                signature = field(result, "signature", SIGNATURE_BYTES) ?: return null,
                userHandle = field(result, "userHandle", USER_HANDLE_BYTES) ?: return null,
                clientDataJson = if (app) field(result, CLIENT_DATA_JSON, CLIENT_DATA_JSON_BYTES) ?: return null else null,
            )
        }
        "password" -> {
            if (kind != RequestKind.PASSWORD || !allowed) return null
            if (keys != setOf("kind", "userName", "password")) return null
            CallerAnswer.Password(
                userName = credentialText(result, "userName") ?: return null,
                password = credentialText(result, "password") ?: return null,
            )
        }
        "error" -> {
            if (kind == RequestKind.PASSWORD || keys != setOf("kind", "name")) return null
            when (result.opt("name") as? String) {
                DomError.NOT_ALLOWED.wire -> CallerAnswer.Dom(DomError.NOT_ALLOWED)
                // A create only: a get has no excluded credential to name.
                DomError.INVALID_STATE.wire -> if (kind == RequestKind.CREATE) CallerAnswer.Dom(DomError.INVALID_STATE) else null
                else -> null
            }
        }
        "cancelled" -> if (keys == setOf("kind")) CallerAnswer.Cancelled else null
        "browser" -> if (keys == setOf("kind")) CallerAnswer.UseAnother else null
        else -> null
    }
}

/** The text of a user name or password: 1 to 16384 characters. */
private fun credentialText(result: JSONObject, key: String): String? =
    (result.opt(key) as? String)?.takeIf { it.length in 1..CREDENTIAL_TEXT_MAX }

/** The text of a byte field when it is canonical base64url without padding and within `bytes`. */
private fun field(result: JSONObject, key: String, bytes: IntRange): String? {
    val text = result.opt(key) as? String ?: return null
    return if (decodeBase64url(text, bytes.first, bytes.last) != null) text else null
}

private val DOMAIN_LABEL = "[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?"
private val ASSETLINKS_DOMAIN = Regex("$DOMAIN_LABEL(\\.$DOMAIN_LABEL)+")
private const val DOMAIN_MAX = 253
private val ALL_DIGITS = Regex("[0-9]+")

/**
 * `domain` when the shell may fetch its `assetlinks.json` (§7.4, D303): a lowercase ASCII host name with a
 * dot, at most 253 characters, no trailing dot, and not an IP address (a last label of digits only). `null`
 * for anything else: the bridge then answers `invalid`.
 */
fun assetLinksDomain(text: String): String? {
    if (text.length > DOMAIN_MAX || !ASSETLINKS_DOMAIN.matches(text)) return null
    if (ALL_DIGITS.matches(text.substringAfterLast('.'))) return null
    return text
}

private const val GET_LOGIN_CREDS = "delegate_permission/common.get_login_creds"

/** The strings of a JSON array, anything else in it skipped; empty when `value` is no array. */
private fun strings(value: Any?): List<String> {
    val array = value as? JSONArray ?: return emptyList()
    return (0 until array.length()).mapNotNull { array.opt(it) as? String }
}

/**
 * Whether the `assetlinks.json` text binds the app (§7.4): a statement with the relation
 * `delegate_permission/common.get_login_creds` whose `android_app` target names `packageName` and lists
 * every one of `certSha256` (lowercase hex) among its `sha256_cert_fingerprints`, written with colons or not.
 * Anything that is not a JSON array of such statements binds nothing, and never throws.
 */
fun bindsApp(json: String, packageName: String, certSha256: List<String>): Boolean {
    if (certSha256.isEmpty()) return false
    val statements = try {
        JSONArray(json)
    } catch (e: JSONException) {
        return false
    }
    return (0 until statements.length()).any { i ->
        val statement = statements.opt(i) as? JSONObject ?: return@any false
        val target = statement.opt("target") as? JSONObject ?: return@any false
        GET_LOGIN_CREDS in strings(statement.opt("relation")) &&
            target.opt("namespace") == "android_app" &&
            target.opt("package_name") == packageName &&
            strings(target.opt("sha256_cert_fingerprints")).map { it.replace(":", "").lowercase() }.containsAll(certSha256)
    }
}

/** What the window is told of an app's binding to a domain (§7.4). */
enum class Binding(val wire: String) {
    BOUND("bound"),
    UNBOUND("unbound"),
    REDIRECT("redirect"),
    NETWORK("network"),
}

/** Whether a `Content-Type` header names `application/json`, whatever its parameters or case. */
fun isJsonMediaType(contentType: String?): Boolean =
    contentType != null && contentType.substringBefore(';').trim().equals("application/json", ignoreCase = true)

/**
 * The binding from the response of the `assetlinks.json` fetch (§7.4): a `3xx` is a redirect, another status
 * or media type binds nothing, and a `null` body, which the fetcher passes when the size or the read failed,
 * is the network's. The fetcher fetches no body for a status other than `200`.
 */
fun bindingOf(status: Int, contentType: String?, body: String?, packageName: String, certSha256: List<String>): Binding = when {
    status in 300..399 -> Binding.REDIRECT
    status != 200 -> Binding.UNBOUND
    !isJsonMediaType(contentType) -> Binding.UNBOUND
    body == null -> Binding.NETWORK
    bindsApp(body, packageName, certSha256) -> Binding.BOUND
    else -> Binding.UNBOUND
}

private val TRANSPORTS = listOf("internal", "hybrid")

private fun credential(id: String, response: JSONObject, extensions: JSONObject): String =
    JSONObject()
        .put("id", id)
        .put("rawId", id)
        .put("type", "public-key")
        .put("authenticatorAttachment", "platform")
        .put("response", response)
        .put("clientExtensionResults", extensions)
        .toString()

/** The registration response JSON (§7.7): `credProps.rk` true, `transports` `["internal", "hybrid"]`. */
fun responseJson(answer: CallerAnswer.Created): String {
    val response = JSONObject()
        .put("attestationObject", answer.attestationObject)
        .put("authenticatorData", answer.authenticatorData)
        .put("transports", JSONArray(TRANSPORTS))
        .put("publicKey", answer.publicKey)
        .put("publicKeyAlgorithm", answer.publicKeyAlgorithm)
    answer.clientDataJson?.let { response.put(CLIENT_DATA_JSON, it) }
    return credential(answer.id, response, JSONObject().put("credProps", JSONObject().put("rk", true)))
}

/** The authentication response JSON (§7.7). */
fun responseJson(answer: CallerAnswer.Asserted): String {
    val response = JSONObject()
        .put("authenticatorData", answer.authenticatorData)
        .put("signature", answer.signature)
        .put("userHandle", answer.userHandle)
    answer.clientDataJson?.let { response.put(CLIENT_DATA_JSON, it) }
    return credential(answer.id, response, JSONObject())
}
