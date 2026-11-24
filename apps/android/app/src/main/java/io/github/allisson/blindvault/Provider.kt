// The credential provider's decisions that need no Android object (android.md §7.3, §7.7, D301): who asks,
// what the provider window is told about the request, what it may answer, and the response JSON written
// for Credential Manager. Pure Kotlin on org.json, so the JVM tests run it as the app does. The shell
// never sees a key: a signed response passes through it toward the caller that asked.
package io.github.allisson.blindvault

import org.json.JSONArray
import org.json.JSONObject

/** The most UTF-8 bytes of the WebAuthn options JSON the window is given (§7.7). */
const val REQUEST_JSON_MAX = 64 * 1024

/** A SHA-256 digest: the `clientDataHash` of a privileged browser. */
const val CLIENT_DATA_HASH_LENGTH = 32

enum class RequestKind(val wire: String) {
    GET("get"),
    CREATE("create"),
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
 * origin (`originPopulated`), which is refused.
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
    return Caller.App(packageName, signingCertificates.map { sha256Hex(it) })
}

/** Who gets entries and credentials: a privileged browser only, until apps are bound by `assetlinks.json` (D301 "Order"). */
fun servesCaller(caller: Caller): Boolean = caller is Caller.Browser

/** The request the window is told about. */
class ProviderRequest(
    val kind: RequestKind,
    val caller: Caller,
    val requestJson: String,
    /** 32 bytes, from a privileged browser only. */
    val clientDataHash: ByteArray?,
)

/**
 * The request for the window, `null` when the caller is refused, the options JSON is over its bound, or a
 * browser passed no `clientDataHash` of 32 bytes: the activity then answers `NotAllowedError` without
 * loading the window. An app's `clientDataJSON` is the window's own, so it gets no hash.
 */
fun providerRequestOf(kind: RequestKind, caller: Caller, requestJson: String, clientDataHash: ByteArray?): ProviderRequest? {
    if (caller === Caller.Refused) return null
    if (requestJson.toByteArray(Charsets.UTF_8).size > REQUEST_JSON_MAX) return null
    val hash = if (caller is Caller.Browser) {
        if (clientDataHash == null || clientDataHash.size != CLIENT_DATA_HASH_LENGTH) return null
        clientDataHash
    } else {
        null
    }
    return ProviderRequest(kind, caller, requestJson, hash)
}

/** The answer to `provider-request` (§7.7). */
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
        .put("requestJson", request.requestJson)
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

/**
 * `provider-result`'s `result` checked against the pending request and its caller (§7.7): the kind, each
 * key, every byte field canonical and bounded, `clientDataJSON` present for an app only. `null` for
 * anything else; the activity then answers `invalid` and ends with a cancellation.
 */
fun parseCallerAnswer(result: JSONObject, kind: RequestKind, caller: Caller): CallerAnswer? {
    if (caller === Caller.Refused) return null
    val keys = result.keys().asSequence().toSet()
    val app = caller is Caller.App
    val clientData = if (app) setOf(CLIENT_DATA_JSON) else emptySet()
    return when (result.opt("kind") as? String) {
        "created" -> {
            if (kind != RequestKind.CREATE) return null
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
            if (kind != RequestKind.GET) return null
            if (keys != setOf("kind", "id", "authenticatorData", "signature", "userHandle") + clientData) return null
            CallerAnswer.Asserted(
                id = field(result, "id", ID_BYTES) ?: return null,
                authenticatorData = field(result, "authenticatorData", AUTHENTICATOR_DATA_BYTES) ?: return null,
                signature = field(result, "signature", SIGNATURE_BYTES) ?: return null,
                userHandle = field(result, "userHandle", USER_HANDLE_BYTES) ?: return null,
                clientDataJson = if (app) field(result, CLIENT_DATA_JSON, CLIENT_DATA_JSON_BYTES) ?: return null else null,
            )
        }
        "error" -> {
            if (keys != setOf("kind", "name")) return null
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

/** The text of a byte field when it is canonical base64url without padding and within `bytes`. */
private fun field(result: JSONObject, key: String, bytes: IntRange): String? {
    val text = result.opt(key) as? String ?: return null
    return if (decodeBase64url(text, bytes.first, bytes.last) != null) text else null
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
