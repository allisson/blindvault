// The shell's side of the bridge (android.md §9, D290, D293): JSON text from the window, one object
// `{v: 1, type, id, ...}` per message. `type` comes from a closed list and every key is checked by
// type and range; anything else is refused with `invalid`, never acted on. A message without an
// `id` the window could match is dropped, since no answer would reach a request. Each type comes from
// the windows the §9 table names: the file types from the main window only, the provider types from
// the provider window only. Pure Kotlin on org.json, so the JVM tests run it as the app does.
package io.github.allisson.blindvault

import org.json.JSONException
import org.json.JSONObject
import java.util.Base64

const val ORIGIN = "https://appassets.androidplatform.net"
const val ORIGIN_HOST = "appassets.androidplatform.net"
const val BRIDGE_VERSION = 1

/** `crypto/sodium.ts` `ID_LENGTH`: `localConfigId`. */
const val ID_LENGTH = 16
const val KEYSTORE_SECRET_LENGTH = 32
const val KEYSTORE_IV_LENGTH = 12
const val KEYSTORE_SEALED_LENGTH = 48

/** Local Config's range for `clipboardClearSeconds`. */
val CLIPBOARD_CLEAR_SECONDS = 10..120

/** The longest text one copy carries. */
const val CLIPBOARD_TEXT_MAX = 1024 * 1024

/** The most bytes of one `file-chunk`, decoded (§6.2). */
const val FILE_CHUNK_BYTES = 1024 * 1024

const val FILE_NAME_MAX = 255

/** JavaScript's `Number.MAX_SAFE_INTEGER`: the window's ids are numbers. */
private const val MAX_SAFE_INTEGER = 9007199254740991L

private val MEDIA_TYPE = Regex("^[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}/[A-Za-z0-9][A-Za-z0-9!#$&^_.+-]{0,126}$")
private val BASE64URL = Regex("^[A-Za-z0-9_-]*$")
private val BASE64 = Regex("^[A-Za-z0-9+/]*={0,2}$")

/** A request the window may send, its keys checked. */
sealed interface Request {
    class KeystoreStatus(val localConfigId: ByteArray) : Request
    class KeystoreSeal(val localConfigId: ByteArray, val secret: ByteArray) : Request
    class KeystoreOpen(val localConfigId: ByteArray, val iv: ByteArray, val sealed: ByteArray) : Request
    class KeystoreDelete(val localConfigId: ByteArray) : Request
    class ClipboardCopy(val text: String, val clearSeconds: Int) : Request
    data object ClipboardClear : Request
    class FileSave(val name: String, val mediaType: String) : Request
    class FileChunk(val data: ByteArray) : Request
    data object FileEnd : Request
    data object FileAbort : Request
    data object BuildInfo : Request
    data object LifecycleWatch : Request

    /** `provider-request` (§7.7): no key; the shell answers from the request Credential Manager passed. */
    data object ProviderRequest : Request

    /** `provider-assetlinks` (§7.4, D303): `domain` is one `assetLinksDomain` accepted. */
    class ProviderAssetLinks(val domain: String) : Request

    /** `provider-result` (§7.7): an object, checked against the pending request by `parseCallerAnswer`. */
    class ProviderResult(val result: JSONObject) : Request
}

/** The window a message came from (§9 "Senders"). */
enum class BridgeWindow { MAIN, PROVIDER }

sealed interface Parsed {
    /** No `id` to answer. */
    data object Dropped : Parsed

    /** Answered `invalid`; `type` is the message's, when it named one, so the provider window can end on it. */
    data class Refused(val id: Long, val type: String? = null) : Parsed

    class Accepted(val id: Long, val request: Request) : Parsed
}

enum class ShellError(val wire: String) {
    INVALID("invalid"),
    CANCELLED("cancelled"),
    INVALIDATED("invalidated"),
    UNAVAILABLE("unavailable"),
    FAILED("failed"),
}

enum class Lifecycle(val wire: String) {
    HIDDEN("hidden"),
    SHOWN("shown"),
    SCREEN_OFF("screen-off"),
}

/** What the shell answers a request: `ok` with its fields, or an error. */
sealed interface Outcome {
    class Ok(val fields: JSONObject = JSONObject()) : Outcome
    class Error(val error: ShellError) : Outcome
}

private class Invalid : Exception()

private val BOTH = BridgeWindow.entries.toSet()

private class Type(
    val keys: Set<String>,
    val windows: Set<BridgeWindow> = BOTH,
    val build: (JSONObject) -> Request,
)

private val ENVELOPE = setOf("v", "type", "id")
private val MAIN_ONLY = setOf(BridgeWindow.MAIN)
private val PROVIDER_ONLY = setOf(BridgeWindow.PROVIDER)

private val TYPES: Map<String, Type> = mapOf(
    "keystore-status" to Type(setOf("localConfigId")) { Request.KeystoreStatus(localConfigId(it)) },
    "keystore-seal" to Type(setOf("localConfigId", "secret")) {
        Request.KeystoreSeal(localConfigId(it), bytes(it, "secret", KEYSTORE_SECRET_LENGTH))
    },
    "keystore-open" to Type(setOf("localConfigId", "iv", "sealed")) {
        Request.KeystoreOpen(
            localConfigId(it),
            bytes(it, "iv", KEYSTORE_IV_LENGTH),
            bytes(it, "sealed", KEYSTORE_SEALED_LENGTH),
        )
    },
    "keystore-delete" to Type(setOf("localConfigId")) { Request.KeystoreDelete(localConfigId(it)) },
    "clipboard-copy" to Type(setOf("text", "clearSeconds")) {
        val text = string(it, "text")
        if (text.isEmpty() || text.length > CLIPBOARD_TEXT_MAX) throw Invalid()
        val seconds = integer(it.opt("clearSeconds")) ?: throw Invalid()
        if (seconds !in CLIPBOARD_CLEAR_SECONDS.first..CLIPBOARD_CLEAR_SECONDS.last) throw Invalid()
        Request.ClipboardCopy(text, seconds.toInt())
    },
    "clipboard-clear" to Type(emptySet()) { Request.ClipboardClear },
    "file-save" to Type(setOf("name", "mediaType"), MAIN_ONLY) {
        val name = string(it, "name")
        if (name.isEmpty() || name.length > FILE_NAME_MAX || name.any { c -> c < ' ' || c == '\u007f' || c == '/' }) {
            throw Invalid()
        }
        val mediaType = string(it, "mediaType")
        if (!MEDIA_TYPE.matches(mediaType)) throw Invalid()
        Request.FileSave(name, mediaType)
    },
    "file-chunk" to Type(setOf("data"), MAIN_ONLY) {
        val text = string(it, "data")
        if (!BASE64.matches(text)) throw Invalid()
        val data = try {
            Base64.getDecoder().decode(text)
        } catch (e: IllegalArgumentException) {
            throw Invalid()
        }
        if (data.isEmpty() || data.size > FILE_CHUNK_BYTES || Base64.getEncoder().encodeToString(data) != text) {
            throw Invalid()
        }
        Request.FileChunk(data)
    },
    "file-end" to Type(emptySet(), MAIN_ONLY) { Request.FileEnd },
    "file-abort" to Type(emptySet(), MAIN_ONLY) { Request.FileAbort },
    "build-info" to Type(emptySet()) { Request.BuildInfo },
    "lifecycle-watch" to Type(emptySet()) { Request.LifecycleWatch },
    "provider-request" to Type(emptySet(), PROVIDER_ONLY) { Request.ProviderRequest },
    "provider-assetlinks" to Type(setOf("domain"), PROVIDER_ONLY) {
        Request.ProviderAssetLinks(assetLinksDomain(string(it, "domain")) ?: throw Invalid())
    },
    "provider-result" to Type(setOf("result"), PROVIDER_ONLY) {
        Request.ProviderResult(it.opt("result") as? JSONObject ?: throw Invalid())
    },
)

/** A whole JSON number as the window writes one, `null` for anything else (a fraction, a string). */
internal fun integer(value: Any?): Long? = when (value) {
    is Int -> value.toLong()
    is Long -> value
    else -> null
}

private fun string(m: JSONObject, key: String): String = m.opt(key) as? String ?: throw Invalid()

/** Canonical base64url without padding, of `min` to `max` bytes; `null` for anything else. */
fun decodeBase64url(text: String, min: Int, max: Int): ByteArray? {
    if (!BASE64URL.matches(text) || text.length % 4 == 1) return null
    val bytes = try {
        Base64.getUrlDecoder().decode(text)
    } catch (e: IllegalArgumentException) {
        return null
    }
    // Unused bits set give another text for the same bytes: refused, so each value has one form.
    if (bytes.size < min || bytes.size > max || base64url(bytes) != text) return null
    return bytes
}

/** Canonical base64url without padding, of exactly `length` bytes. */
private fun bytes(m: JSONObject, key: String, length: Int): ByteArray =
    decodeBase64url(string(m, key), length, length) ?: throw Invalid()

private fun localConfigId(m: JSONObject) = bytes(m, "localConfigId", ID_LENGTH)

fun base64url(bytes: ByteArray): String = Base64.getUrlEncoder().withoutPadding().encodeToString(bytes)

object Bridge {
    fun parse(text: String, from: BridgeWindow): Parsed {
        val message = try {
            JSONObject(text)
        } catch (e: JSONException) {
            return Parsed.Dropped
        }
        val id = integer(message.opt("id"))
        if (id == null || id < 1 || id > MAX_SAFE_INTEGER) return Parsed.Dropped
        return try {
            Parsed.Accepted(id, request(message, from))
        } catch (e: Invalid) {
            Parsed.Refused(id, message.opt("type") as? String)
        }
    }

    private fun request(message: JSONObject, from: BridgeWindow): Request {
        if (integer(message.opt("v")) != BRIDGE_VERSION.toLong()) throw Invalid()
        val type = TYPES[message.opt("type") as? String ?: throw Invalid()] ?: throw Invalid()
        if (from !in type.windows) throw Invalid()
        val keys = message.keys().asSequence().toSet()
        if (keys != ENVELOPE + type.keys) throw Invalid()
        return type.build(message)
    }
}

object Answer {
    fun ok(id: Long, fields: JSONObject = JSONObject()): String =
        fields.put("v", BRIDGE_VERSION).put("id", id).put("ok", true).toString()

    fun error(id: Long, error: ShellError): String =
        JSONObject().put("v", BRIDGE_VERSION).put("id", id).put("ok", false).put("error", error.wire).toString()

    fun of(id: Long, outcome: Outcome): String = when (outcome) {
        is Outcome.Ok -> ok(id, outcome.fields)
        is Outcome.Error -> error(id, outcome.error)
    }

    fun lifecycle(state: Lifecycle): String =
        JSONObject().put("v", BRIDGE_VERSION).put("type", "lifecycle").put("state", state.wire).toString()
}
