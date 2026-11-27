// The Keystore KEK's key (android.md §5, D271, D290, D292): an AES-256-GCM key per Local Config, in
// StrongBox where present and the TEE otherwise, that needs a strong biometric on every use and is
// destroyed when a biometric is enrolled. It encrypts the window's random Keystore secret and decrypts
// it again behind the BiometricPrompt; the secret's bytes are wiped once answered and never stored or
// logged. Best effort only: the base64url `String` of the answer and of the `keystore-seal` message
// cannot be wiped, and stays in memory until collected (android.md §5, D309).
package io.github.allisson.blindvault

import android.app.Activity
import android.hardware.biometrics.BiometricManager
import android.hardware.biometrics.BiometricManager.Authenticators.BIOMETRIC_STRONG
import android.hardware.biometrics.BiometricPrompt
import android.os.CancellationSignal
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyInfo
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.security.keystore.StrongBoxUnavailableException
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.SecretKeyFactory
import javax.crypto.spec.GCMParameterSpec

private const val PROVIDER = "AndroidKeyStore"
private const val TRANSFORMATION = "AES/GCM/NoPadding"
private const val TAG_BITS = 128

class ShellKeystore(private val activity: Activity) {
    private fun store(): KeyStore = KeyStore.getInstance(PROVIDER).apply { load(null) }

    private fun key(alias: String): SecretKey? = store().getKey(alias, null) as SecretKey?

    /** A strong biometric is enrolled, so the key can be created and used. */
    private fun available(): Boolean =
        activity.getSystemService(BiometricManager::class.java).canAuthenticate(BIOMETRIC_STRONG) ==
            BiometricManager.BIOMETRIC_SUCCESS

    private fun strongBox(key: SecretKey): Boolean {
        val info = SecretKeyFactory.getInstance(key.algorithm, PROVIDER).getKeySpec(key, KeyInfo::class.java) as KeyInfo
        return info.securityLevel == KeyProperties.SECURITY_LEVEL_STRONGBOX
    }

    private fun spec(alias: String, strongBox: Boolean) =
        KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setKeySize(256)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setUserAuthenticationRequired(true)
            .setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
            .setInvalidatedByBiometricEnrollment(true)
            .setIsStrongBoxBacked(strongBox)
            .build()

    /** A new key under `alias`, replacing any other; StrongBox first, then the TEE. */
    private fun create(alias: String): SecretKey {
        store().deleteEntry(alias)
        val generator = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, PROVIDER)
        return try {
            generator.init(spec(alias, true))
            generator.generateKey()
        } catch (e: StrongBoxUnavailableException) {
            generator.init(spec(alias, false))
            generator.generateKey()
        }
    }

    fun status(localConfigId: ByteArray): Outcome {
        val fields = JSONObject().put("available", available())
        try {
            key(keystoreAlias(localConfigId))?.let { fields.put("strongBox", strongBox(it)) }
        } catch (e: Exception) {
            // A key Android can no longer describe: the status says only whether one can be made.
        }
        return Outcome.Ok(fields)
    }

    /** `keystore-seal`: a new key encrypts the secret behind the prompt; any failure deletes the key. */
    fun seal(localConfigId: ByteArray, secret: ByteArray, done: (Outcome) -> Unit) {
        val alias = keystoreAlias(localConfigId)
        var created = false
        val finish = { outcome: Outcome ->
            secret.fill(0)
            if (created && outcome !is Outcome.Ok) store().deleteEntry(alias)
            done(outcome)
        }
        if (!available()) return finish(Outcome.Error(ShellError.UNAVAILABLE))
        val (key, cipher) = try {
            val key = create(alias)
            created = true
            key to Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, key) }
        } catch (e: Exception) {
            return finish(Outcome.Error(ShellError.FAILED))
        }
        prompt(R.string.keystore_seal_title, cipher, finish) { c ->
            val sealed = c.doFinal(secret)
            Outcome.Ok(
                JSONObject()
                    .put("iv", base64url(c.iv))
                    .put("sealed", base64url(sealed))
                    .put("strongBox", strongBox(key)),
            )
        }
    }

    /** `keystore-open`: the secret again, behind the prompt. A missing key opens nothing, as an invalidated one. */
    fun open(localConfigId: ByteArray, iv: ByteArray, sealed: ByteArray, done: (Outcome) -> Unit) {
        val cipher = try {
            val key = key(keystoreAlias(localConfigId)) ?: return done(Outcome.Error(ShellError.INVALIDATED))
            Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(TAG_BITS, iv)) }
        } catch (e: KeyPermanentlyInvalidatedException) {
            return done(Outcome.Error(ShellError.INVALIDATED))
        } catch (e: Exception) {
            return done(Outcome.Error(ShellError.FAILED))
        }
        if (!available()) return done(Outcome.Error(ShellError.UNAVAILABLE))
        prompt(R.string.keystore_open_title, cipher, done) { c ->
            val secret = c.doFinal(sealed)
            try {
                Outcome.Ok(JSONObject().put("secret", base64url(secret)))
            } finally {
                secret.fill(0)
            }
        }
    }

    fun delete(localConfigId: ByteArray): Outcome {
        store().deleteEntry(keystoreAlias(localConfigId))
        return Outcome.Ok()
    }

    /** One BiometricPrompt bound to `cipher`; `done` is called once. */
    private fun prompt(title: Int, cipher: Cipher, done: (Outcome) -> Unit, use: (Cipher) -> Outcome) {
        var answered = false
        val once = { outcome: Outcome ->
            if (!answered) {
                answered = true
                done(outcome)
            }
        }
        val executor = activity.mainExecutor
        BiometricPrompt.Builder(activity)
            .setTitle(activity.getString(title))
            .setAllowedAuthenticators(BIOMETRIC_STRONG)
            .setNegativeButton(activity.getString(android.R.string.cancel), executor) { _, _ ->
                once(Outcome.Error(ShellError.CANCELLED))
            }
            .build()
            .authenticate(
                BiometricPrompt.CryptoObject(cipher),
                CancellationSignal(),
                executor,
                object : BiometricPrompt.AuthenticationCallback() {
                    override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                        val c = result.cryptoObject?.cipher
                        once(
                            if (c == null) {
                                Outcome.Error(ShellError.FAILED)
                            } else {
                                try {
                                    use(c)
                                } catch (e: Exception) {
                                    Outcome.Error(ShellError.FAILED)
                                }
                            },
                        )
                    }

                    override fun onAuthenticationError(code: Int, message: CharSequence) {
                        once(Outcome.Error(biometricError(code)))
                    }
                },
            )
    }
}
