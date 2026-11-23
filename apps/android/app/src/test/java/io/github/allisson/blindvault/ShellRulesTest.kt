package io.github.allisson.blindvault

import android.hardware.biometrics.BiometricPrompt
import android.webkit.PermissionRequest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

// android.md §3 and §5: navigation, the camera, the file chooser's types, headers.json, the
// Keystore key's alias and the BiometricPrompt's errors.
class ShellRulesTest {
    @Test
    fun keepsTheWindowOnTheAppsOrigin() {
        assertEquals(Navigation.STAY, navigationOf("https", "appassets.androidplatform.net"))
        assertEquals(Navigation.EXTERNAL, navigationOf("https", "github.com"))
        assertEquals(Navigation.EXTERNAL, navigationOf("https", "appassets.androidplatform.net.example"))
        for ((scheme, host) in listOf(
            "http" to "appassets.androidplatform.net",
            "http" to "github.com",
            "javascript" to null,
            "intent" to "scan",
            "file" to null,
            "content" to "media",
            "data" to null,
            null to null,
            "https" to null,
            "https" to "",
        )) assertEquals("$scheme $host", Navigation.DROP, navigationOf(scheme, host))
    }

    @Test
    fun grantsOnlyTheCameraOnlyToTheAppsOrigin() {
        val video = arrayOf(PermissionRequest.RESOURCE_VIDEO_CAPTURE)
        assertTrue(grantsCamera("https://appassets.androidplatform.net/", video))
        assertTrue(grantsCamera("https://appassets.androidplatform.net", video))
        assertFalse(grantsCamera("https://example.com/", video))
        assertFalse(grantsCamera("http://appassets.androidplatform.net/", video))
        assertFalse(grantsCamera("https://appassets.androidplatform.net/", arrayOf(PermissionRequest.RESOURCE_AUDIO_CAPTURE)))
        assertFalse(grantsCamera("https://appassets.androidplatform.net/", video + PermissionRequest.RESOURCE_AUDIO_CAPTURE))
        assertFalse(grantsCamera("https://appassets.androidplatform.net/", emptyArray()))
    }

    @Test
    fun filtersTheChooserByMediaTypeOnlyWhenEveryTypeIsOne() {
        assertEquals(listOf("application/json", "text/csv"), mediaTypesOf(arrayOf("application/json, text/csv")))
        assertEquals(listOf("image/*"), mediaTypesOf(arrayOf("image/*")))
        // An extension has no media type to filter on: every file is offered.
        assertEquals(emptyList<String>(), mediaTypesOf(arrayOf(".bvault")))
        assertEquals(emptyList<String>(), mediaTypesOf(arrayOf("application/json", ".csv")))
        assertEquals(emptyList<String>(), mediaTypesOf(arrayOf("")))
        assertEquals(emptyList<String>(), mediaTypesOf(emptyArray()))
    }

    @Test
    fun readsHeadersJson() {
        assertEquals(
            mapOf("Content-Security-Policy" to "default-src 'self'", "Cache-Control" to "no-cache"),
            parseHeaders("""{"Content-Security-Policy": "default-src 'self'", "Cache-Control": "no-cache"}"""),
        )
        for (bad in listOf("[]", """{"a": 1}""", """{"a": null}""", """{"": "x"}""", "{}")) {
            try {
                parseHeaders(bad)
                throw AssertionError("accepted $bad")
            } catch (e: IllegalArgumentException) {
                // refused
            }
        }
    }

    @Test
    fun namesTheKeystoreKeyByLocalConfigId() {
        assertEquals(
            "blindvault-kek-000102030405060708090a0b0c0d0eff",
            keystoreAlias(byteArrayOf(0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, -1)),
        )
    }

    @Test
    fun mapsTheBiometricPromptsErrors() {
        for (code in listOf(
            BiometricPrompt.BIOMETRIC_ERROR_USER_CANCELED,
            BiometricPrompt.BIOMETRIC_ERROR_CANCELED,
            BiometricPrompt.BIOMETRIC_ERROR_TIMEOUT,
        )) assertEquals(ShellError.CANCELLED, biometricError(code))
        for (code in listOf(
            BiometricPrompt.BIOMETRIC_ERROR_NO_BIOMETRICS,
            BiometricPrompt.BIOMETRIC_ERROR_HW_NOT_PRESENT,
            BiometricPrompt.BIOMETRIC_ERROR_HW_UNAVAILABLE,
            BiometricPrompt.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED,
        )) assertEquals(ShellError.UNAVAILABLE, biometricError(code))
        for (code in listOf(
            BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT,
            BiometricPrompt.BIOMETRIC_ERROR_LOCKOUT_PERMANENT,
            BiometricPrompt.BIOMETRIC_ERROR_UNABLE_TO_PROCESS,
            BiometricPrompt.BIOMETRIC_ERROR_VENDOR,
            999,
        )) assertEquals(ShellError.FAILED, biometricError(code))
    }

    @Test
    fun reportsAStopAsHiddenAndAStartAsShown() {
        val visibility = Visibility()
        assertFalse(visibility.hidden)
        assertEquals(Lifecycle.HIDDEN, visibility.stopped())
        assertTrue(visibility.hidden)
        assertEquals(Lifecycle.SHOWN, visibility.started())
        assertFalse(visibility.hidden)
    }

    @Test
    fun keepsTheWindowShownBehindTheShellsOwnPicker() {
        val visibility = Visibility()
        visibility.pickerOpened()
        assertEquals(null, visibility.stopped())
        assertFalse(visibility.hidden)
        visibility.pickerClosed()
        assertEquals(Lifecycle.SHOWN, visibility.started())
        // Once the picker answered, a stop hides the window again.
        assertEquals(Lifecycle.HIDDEN, visibility.stopped())
        assertTrue(visibility.hidden)
    }

    @Test
    fun aPickerOpenedWhileHiddenDoesNotShowTheWindow() {
        val visibility = Visibility()
        visibility.stopped()
        visibility.pickerOpened()
        assertTrue(visibility.hidden)
    }

    @Test
    fun hexesACertificatesSha256() {
        assertEquals(
            "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
            sha256Hex("abc".toByteArray()),
        )
    }
}
