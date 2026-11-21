// Measure 4 (D281): an AES-256-GCM Keystore key, in StrongBox where present, that needs a strong
// biometric on every use (timeout 0) and is invalidated when a new biometric is enrolled. It wraps
// and unwraps 32 throwaway bytes from the page; nothing it handles is kept or logged.
package io.github.allisson.blindvault.spike

import android.app.Activity
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

private const val ALIAS = "spike-wrap"

class SpikeKeystore(private val activity: Activity) {
    private fun store() = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }

    private fun spec(strongBox: Boolean) = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setKeySize(256)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
        .setUserAuthenticationRequired(true)
        .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
        .setInvalidatedByBiometricEnrollment(true)
        .setIsStrongBoxBacked(strongBox)
        .build()

    fun create(): JSONObject {
        store().deleteEntry(ALIAS)
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        var strongBoxError: String? = null
        try {
            gen.init(spec(true))
            gen.generateKey()
        } catch (e: StrongBoxUnavailableException) {
            strongBoxError = e.toString()
            gen.init(spec(false))
            gen.generateKey()
        }
        val key = store().getKey(ALIAS, null) as SecretKey
        val info = SecretKeyFactory.getInstance(key.algorithm, "AndroidKeyStore").getKeySpec(key, KeyInfo::class.java) as KeyInfo
        return JSONObject()
            .put("securityLevel", when (info.securityLevel) {
                KeyProperties.SECURITY_LEVEL_STRONGBOX -> "strongbox"
                KeyProperties.SECURITY_LEVEL_TRUSTED_ENVIRONMENT -> "tee"
                KeyProperties.SECURITY_LEVEL_SOFTWARE -> "software"
                else -> "other:${info.securityLevel}"
            })
            .put("strongBoxError", strongBoxError ?: JSONObject.NULL)
            .put("userAuthenticationRequired", info.isUserAuthenticationRequired)
            .put("authenticationValiditySeconds", info.userAuthenticationValidityDurationSeconds)
            .put("invalidatedByBiometricEnrollment", info.isInvalidatedByBiometricEnrollment)
    }

    private fun cipher(mode: Int, iv: ByteArray?): Cipher {
        val key = store().getKey(ALIAS, null) as SecretKey? ?: throw IllegalStateException("no key: create it first")
        return Cipher.getInstance("AES/GCM/NoPadding").apply {
            if (iv == null) init(mode, key) else init(mode, key, GCMParameterSpec(128, iv))
        }
    }

    // Initialising the cipher is where an invalidated key fails, before any prompt.
    private fun withPrompt(mode: Int, iv: ByteArray?, title: String, respond: (JSONObject) -> Unit, use: (Cipher) -> JSONObject) {
        val c = try {
            cipher(mode, iv)
        } catch (e: KeyPermanentlyInvalidatedException) {
            respond(JSONObject().put("invalidated", true).put("error", e.toString()))
            return
        }
        val started = System.currentTimeMillis()
        activity.runOnUiThread {
            BiometricPrompt.Builder(activity)
                .setTitle(title)
                .setSubtitle("BlindVault spike (D281)")
                .setAllowedAuthenticators(BIOMETRIC_STRONG)
                .setNegativeButton("Cancel", activity.mainExecutor) { _, _ -> respond(JSONObject().put("error", "cancelled")) }
                .build()
                .authenticate(BiometricPrompt.CryptoObject(c), CancellationSignal(), activity.mainExecutor, object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val out = try {
                            use(result.cryptoObject!!.cipher!!)
                        } catch (e: Exception) {
                            JSONObject().put("error", e.toString())
                        }
                        respond(out.put("prompted", true).put("authenticationType", result.authenticationType).put("ms", System.currentTimeMillis() - started))
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        respond(JSONObject().put("error", "biometric $code $message"))
                    }
                })
        }
    }

    fun wrap(data: ByteArray, respond: (JSONObject) -> Unit) =
        withPrompt(Cipher.ENCRYPT_MODE, null, "Wrap 32 bytes", respond) { c ->
            val ct = c.doFinal(data)
            data.fill(0)
            JSONObject().put("iv", Base64.encodeToString(c.iv, Base64.NO_WRAP)).put("ct", Base64.encodeToString(ct, Base64.NO_WRAP))
        }

    fun unwrap(iv: ByteArray, ct: ByteArray, respond: (JSONObject) -> Unit) =
        withPrompt(Cipher.DECRYPT_MODE, iv, "Unwrap 32 bytes", respond) { c ->
            val pt = c.doFinal(ct)
            val out = JSONObject().put("data", Base64.encodeToString(pt, Base64.NO_WRAP))
            pt.fill(0)
            out
        }
}
