// The fetch of an app's binding to a domain (android.md §7.4, D303): `https://<domain>/.well-known/assetlinks.json`
// without redirects or cache, within 10 s for the whole and 256 KiB, then `bindingOf` decides. The domain
// is one `assetLinksDomain` accepted. The request carries no header about the user, nothing is logged and
// nothing is kept: the body is read into memory for the one decision.
package io.github.allisson.blindvault

import java.io.ByteArrayOutputStream
import java.io.IOException
import java.net.URL
import java.util.concurrent.atomic.AtomicBoolean
import java.util.concurrent.atomic.AtomicReference
import javax.net.ssl.HttpsURLConnection

/** The whole fetch, DNS and TLS included (§7.4). */
private const val FETCH_TOTAL_MS = 10_000L

/** Each wait for the server; the whole is bound by `FETCH_TOTAL_MS`. */
private const val FETCH_STEP_MS = 5_000

/** The most bytes of the body: one more is `network` (§7.4). */
private const val ASSETLINKS_MAX = 256 * 1024

/** What the request tells the site of its client: nothing about the device or the user. */
private const val USER_AGENT = "BlindVault"

/**
 * Fetches the binding of `packageName` with `certSha256` to `domain` on a background thread and calls `done`,
 * on that thread and once, with the answer: `network` for any failure to read the answer in time or in size
 * (a watchdog ends the fetch at 10 s even when DNS hangs), else `bindingOf`'s.
 */
fun fetchAssetLinks(domain: String, packageName: String, certSha256: List<String>, done: (Binding) -> Unit) {
    val finished = AtomicBoolean(false)
    val finish = { binding: Binding -> if (finished.compareAndSet(false, true)) done(binding) }
    val open = AtomicReference<HttpsURLConnection?>(null)
    val watchdog = Thread {
        try {
            Thread.sleep(FETCH_TOTAL_MS)
        } catch (e: InterruptedException) {
            return@Thread
        }
        finish(Binding.NETWORK)
        open.get()?.disconnect()
    }
    watchdog.isDaemon = true
    val worker = Thread {
        val deadline = System.nanoTime() + FETCH_TOTAL_MS * 1_000_000L
        val binding = try {
            val connection = URL("https://$domain/.well-known/assetlinks.json").openConnection() as HttpsURLConnection
            open.set(connection)
            connection.instanceFollowRedirects = false
            connection.useCaches = false
            connection.requestMethod = "GET"
            connection.connectTimeout = FETCH_STEP_MS
            connection.readTimeout = FETCH_STEP_MS
            connection.setRequestProperty("User-Agent", USER_AGENT)
            connection.setRequestProperty("Accept", "application/json")
            val status = connection.responseCode
            val type = connection.contentType
            // Only a `200` of `application/json` has a body worth reading.
            val body = if (status == 200 && isJsonMediaType(type)) readBounded(connection, deadline) else null
            if (status == 200 && isJsonMediaType(type) && body == null) Binding.NETWORK
            else bindingOf(status, type, body, packageName, certSha256)
        } catch (e: IOException) {
            Binding.NETWORK
        } catch (e: RuntimeException) {
            Binding.NETWORK
        } finally {
            open.get()?.disconnect()
            watchdog.interrupt()
        }
        finish(binding)
    }
    worker.isDaemon = true
    watchdog.start()
    worker.start()
}

/** The body as UTF-8, `null` when it is over 256 KiB or the deadline passes; `IOException` for a read that fails. */
private fun readBounded(connection: HttpsURLConnection, deadline: Long): String? {
    val out = ByteArrayOutputStream()
    val buffer = ByteArray(8192)
    connection.inputStream.use { stream ->
        while (true) {
            if (System.nanoTime() > deadline) return null
            val n = stream.read(buffer)
            if (n < 0) break
            if (out.size() + n > ASSETLINKS_MAX) return null
            out.write(buffer, 0, n)
        }
    }
    return String(out.toByteArray(), Charsets.UTF_8)
}
