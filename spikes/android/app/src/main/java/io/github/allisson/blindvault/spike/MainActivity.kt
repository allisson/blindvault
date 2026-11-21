// The throwaway WebView shell of the Phase 10 spike (D281, docs/spikes/README.md §7): the apps/web
// build served from the APK at https://appassets.androidplatform.net with the headers of its
// `_headers` file, and a message bridge open to that origin only. Holds no vault data.
package io.github.allisson.blindvault.spike

import android.Manifest
import android.app.Activity
import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.os.PersistableBundle
import android.util.Base64
import android.view.ViewGroup
import android.webkit.ConsoleMessage
import android.webkit.PermissionRequest
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.Button
import android.widget.LinearLayout
import androidx.webkit.ServiceWorkerClientCompat
import androidx.webkit.ServiceWorkerControllerCompat
import androidx.webkit.WebSettingsCompat
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import androidx.webkit.WebViewFeature
import org.json.JSONArray
import org.json.JSONObject
import java.io.ByteArrayInputStream
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

private const val ORIGIN = "https://appassets.androidplatform.net"
private const val SPIKE = "$ORIGIN/spike/spike.html"
private const val APP = "$ORIGIN/index.html"
private const val SIGNAL = "http://127.0.0.1:5320"

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var keystore: SpikeKeystore
    private val log = JSONArray()
    private val io = Executors.newSingleThreadExecutor()
    private var pendingCamera: PermissionRequest? = null

    private fun note(kind: String, text: String) {
        synchronized(log) {
            if (log.length() < 500) log.put(JSONObject().put("at", System.currentTimeMillis()).put("kind", kind).put("text", text))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        WebView.setWebContentsDebuggingEnabled(true)
        keystore = SpikeKeystore(this)

        val headers = JSONObject(assets.open("headers.json").bufferedReader().readText())
        val loader = WebViewAssetLoader.Builder()
            .addPathHandler("/", WebHandler(headers))
            .build()

        web = WebView(this)
        web.settings.apply {
            javaScriptEnabled = true
            domStorageEnabled = true
            allowFileAccess = false
            allowContentAccess = false
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
            WebSettingsCompat.setWebAuthenticationSupport(web.settings, webAuthMode(getPreferences(MODE_PRIVATE).getString("webauthn", "app")))
        }

        web.webViewClient = object : WebViewClient() {
            override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse? =
                loader.shouldInterceptRequest(request.url)

            override fun onReceivedError(view: WebView, request: WebResourceRequest, error: WebResourceError) =
                note("load-error", "${request.url} ${error.errorCode} ${error.description}")

            override fun onReceivedHttpError(view: WebView, request: WebResourceRequest, response: WebResourceResponse) =
                note("http-error", "${request.url} ${response.statusCode}")
        }
        if (WebViewFeature.isFeatureSupported(WebViewFeature.SERVICE_WORKER_BASIC_USAGE)) {
            ServiceWorkerControllerCompat.getInstance().setServiceWorkerClient(object : ServiceWorkerClientCompat() {
                override fun shouldInterceptRequest(request: WebResourceRequest): WebResourceResponse? =
                    loader.shouldInterceptRequest(request.url)
            })
        }
        web.webChromeClient = object : WebChromeClient() {
            override fun onConsoleMessage(m: ConsoleMessage): Boolean {
                if (m.messageLevel() == ConsoleMessage.MessageLevel.ERROR || m.messageLevel() == ConsoleMessage.MessageLevel.WARNING) {
                    note("console-${m.messageLevel().name.lowercase()}", "${m.message()} (${m.sourceId()}:${m.lineNumber()})")
                }
                return false
            }

            override fun onPermissionRequest(request: PermissionRequest) {
                note("permission", "${request.origin} ${request.resources.joinToString()}")
                if (request.origin.toString().trimEnd('/') != ORIGIN || request.resources.any { it != PermissionRequest.RESOURCE_VIDEO_CAPTURE }) {
                    request.deny()
                    return
                }
                if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                    request.grant(request.resources)
                } else {
                    pendingCamera = request
                    requestPermissions(arrayOf(Manifest.permission.CAMERA), 1)
                }
            }
        }

        if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            WebViewCompat.addWebMessageListener(web, "spikeBridge", setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
                if (!isMainFrame || origin.toString().trimEnd('/') != ORIGIN) return@addWebMessageListener
                val msg = JSONObject(message.data ?: "{}")
                val id = msg.optString("id")
                val respond = { out: JSONObject -> runOnUiThread { reply.postMessage(out.put("id", id).toString()) } }
                try {
                    handle(msg, respond)
                } catch (e: Exception) {
                    respond(JSONObject().put("error", e.toString()))
                }
            }
        } else {
            note("bridge", "WEB_MESSAGE_LISTENER unsupported")
        }

        val bar = LinearLayout(this).apply {
            addView(Button(context).apply { text = "Spike"; setOnClickListener { web.loadUrl(SPIKE) } })
            addView(Button(context).apply { text = "App"; setOnClickListener { web.loadUrl(APP) } })
            addView(Button(context).apply { text = "Reload"; setOnClickListener { web.reload() } })
        }
        setContentView(LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            fitsSystemWindows = true
            addView(bar)
            addView(web, LinearLayout.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, 0, 1f))
        })
        web.loadUrl(SPIKE)
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        val request = pendingCamera ?: return
        pendingCamera = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) request.grant(request.resources) else request.deny()
        note("permission", "CAMERA runtime ${grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED}")
    }

    private fun webAuthMode(mode: String?): Int = when (mode) {
        "browser" -> WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_BROWSER
        "none" -> WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_NONE
        else -> WebSettingsCompat.WEB_AUTHENTICATION_SUPPORT_FOR_APP
    }

    private fun handle(msg: JSONObject, respond: (JSONObject) -> Unit) {
        when (msg.getString("op")) {
            "info" -> {
                val pkg = WebViewCompat.getCurrentWebViewPackage(this)
                val info = packageManager.getPackageInfo(packageName, 0)
                respond(JSONObject()
                    .put("package", packageName)
                    .put("versionCode", info.longVersionCode)
                    .put("versionName", info.versionName)
                    .put("webView", "${pkg?.packageName} ${pkg?.versionName}")
                    .put("device", "${Build.MANUFACTURER} ${Build.MODEL}")
                    .put("sdkInt", Build.VERSION.SDK_INT)
                    .put("strongBoxFeature", packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE))
                    .put("webAuthenticationFeature", WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION))
                    .put("webAuthenticationMode", getPreferences(MODE_PRIVATE).getString("webauthn", "app")))
            }
            "log" -> respond(JSONObject().put("log", synchronized(log) { JSONArray(log.toString()) }))
            "log-clear" -> {
                synchronized(log) { while (log.length() > 0) log.remove(0) }
                respond(JSONObject().put("ok", true))
            }
            "webauthn-mode" -> {
                val mode = msg.getString("mode")
                getPreferences(MODE_PRIVATE).edit().putString("webauthn", mode).apply()
                if (WebViewFeature.isFeatureSupported(WebViewFeature.WEB_AUTHENTICATION)) {
                    WebSettingsCompat.setWebAuthenticationSupport(web.settings, webAuthMode(mode))
                }
                respond(JSONObject().put("mode", mode))
            }
            "keystore-create" -> respond(keystore.create())
            "keystore-wrap" -> keystore.wrap(Base64.decode(msg.getString("data"), Base64.NO_WRAP), respond)
            "keystore-unwrap" -> keystore.unwrap(
                Base64.decode(msg.getString("iv"), Base64.NO_WRAP),
                Base64.decode(msg.getString("ct"), Base64.NO_WRAP),
                respond,
            )
            "signal" -> io.execute {
                val out = try {
                    val conn = URL(SIGNAL + msg.getString("path")).openConnection() as HttpURLConnection
                    conn.connectTimeout = 3000
                    conn.readTimeout = 3000
                    if (msg.has("body")) {
                        conn.requestMethod = "POST"
                        conn.doOutput = true
                        conn.outputStream.use { it.write(msg.getString("body").toByteArray()) }
                    }
                    JSONObject().put("status", conn.responseCode).put("body", conn.inputStream.bufferedReader().readText())
                } catch (e: Exception) {
                    JSONObject().put("error", e.toString())
                }
                respond(out)
            }
            "clipboard-set" -> {
                val clip = ClipData.newPlainText("spike", msg.getString("text"))
                clip.description.extras = PersistableBundle().apply { putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true) }
                clipboard().setPrimaryClip(clip)
                respond(JSONObject().put("ok", true))
            }
            "clipboard-clear" -> {
                clipboard().clearPrimaryClip()
                respond(JSONObject().put("ok", true))
            }
            "clipboard-read" -> {
                val text = clipboard().primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0)?.text?.toString()
                respond(JSONObject().put("hasClip", clipboard().hasPrimaryClip()).put("text", text ?: JSONObject.NULL))
            }
            else -> respond(JSONObject().put("error", "unknown op"))
        }
    }

    private fun clipboard() = getSystemService(ClipboardManager::class.java)

    // Serves assets/web/<path> with the headers apps/web's `_headers` sets on `/*` (build.mjs writes
    // them to assets/headers.json), so the CSP applies as on the web.
    private inner class WebHandler(private val headers: JSONObject) : WebViewAssetLoader.PathHandler {
        private val types = mapOf(
            "html" to "text/html", "js" to "text/javascript", "mjs" to "text/javascript", "css" to "text/css",
            "wasm" to "application/wasm", "json" to "application/json", "webmanifest" to "application/manifest+json",
            "svg" to "image/svg+xml", "png" to "image/png", "txt" to "text/plain", "ico" to "image/x-icon",
        )

        override fun handle(path: String): WebResourceResponse {
            val file = path.ifEmpty { "index.html" }
            val type = types[file.substringAfterLast('.', "")] ?: "application/octet-stream"
            val map = headers.keys().asSequence().associateWith { headers.getString(it) }
            return try {
                val bytes = assets.open("web/$file").use { it.readBytes() }
                WebResourceResponse(type, null, 200, "OK", map, ByteArrayInputStream(bytes))
            } catch (e: java.io.IOException) {
                note("not-found", path)
                WebResourceResponse("text/plain", null, 404, "Not Found", map, ByteArrayInputStream(ByteArray(0)))
            }
        }
    }
}
