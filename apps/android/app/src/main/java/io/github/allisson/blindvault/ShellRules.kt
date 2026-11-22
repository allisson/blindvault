// The shell's decisions that need no Android object (android.md §3, §5, §10), kept apart so the JVM
// tests run them.
package io.github.allisson.blindvault

import android.hardware.biometrics.BiometricPrompt
import android.webkit.PermissionRequest
import org.json.JSONException
import org.json.JSONObject
import java.security.MessageDigest

enum class Navigation { STAY, EXTERNAL, DROP }

/** The app's origin stays in the WebView; another `https:` URL opens in the browser; the rest is dropped. */
fun navigationOf(scheme: String?, host: String?): Navigation = when {
    scheme != "https" || host.isNullOrEmpty() -> Navigation.DROP
    host == ORIGIN_HOST -> Navigation.STAY
    else -> Navigation.EXTERNAL
}

/** The camera only, asked by the app's origin only. */
fun grantsCamera(origin: String, resources: Array<String>): Boolean =
    origin.trimEnd('/') == ORIGIN &&
        resources.isNotEmpty() &&
        resources.all { it == PermissionRequest.RESOURCE_VIDEO_CAPTURE }

/**
 * The media types of an input's `accept`, for `ACTION_OPEN_DOCUMENT`; empty, so every file is offered,
 * when one of them is an extension, which has no media type to filter on.
 */
fun mediaTypesOf(accept: Array<String>): List<String> {
    val types = accept.flatMap { it.split(',') }.map { it.trim() }.filter { it.isNotEmpty() }
    return if (types.isNotEmpty() && types.all { '/' in it }) types else emptyList()
}

/** `headers.json` (android.md §2): one object, every value a string. */
fun parseHeaders(text: String): Map<String, String> {
    val json = try {
        JSONObject(text)
    } catch (e: JSONException) {
        throw IllegalArgumentException("headers.json is not an object")
    }
    val headers = json.keys().asSequence().associateWith { name ->
        require(name.isNotEmpty()) { "headers.json has an empty name" }
        json.opt(name) as? String ?: throw IllegalArgumentException("headers.json: $name is not a string")
    }
    require(headers.isNotEmpty()) { "headers.json is empty" }
    return headers
}

private fun hex(bytes: ByteArray): String = bytes.joinToString("") { "%02x".format(it) }

/** The Keystore key of one Local Config (D292). */
fun keystoreAlias(localConfigId: ByteArray): String = "blindvault-kek-${hex(localConfigId)}"

/** The window's answer to a BiometricPrompt error (android.md §5). */
fun biometricError(code: Int): ShellError = when (code) {
    BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED,
    BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
    BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT,
    -> ShellError.CANCELLED
    BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS,
    BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT,
    BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE,
    BiometricPrompt.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED,
    -> ShellError.UNAVAILABLE
    else -> ShellError.FAILED
}

fun sha256Hex(bytes: ByteArray): String = hex(MessageDigest.getInstance("SHA-256").digest(bytes))
