// The main window (android.md §3, §4, §9, D290, D293, D294): a WebView running apps/web's Android build,
// served from the APK at https://appassets.androidplatform.net with the headers of headers.json, so
// the app runs under its real CSP. The bridge is `addWebMessageListener`, open to that origin in the
// main frame only; the shell holds no vault key and logs nothing of what crosses it.
package io.github.allisson.blindvault

import android.Manifest
import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Bundle
import android.view.WindowManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.widget.FrameLayout
import android.widget.TextView
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewFeature
import org.json.JSONObject

private const val OPEN_REQUEST = 1
private const val CAMERA_REQUEST = 3

class MainActivity : Activity() {
    private lateinit var web: WebView
    private lateinit var keystore: ShellKeystore
    private lateinit var clipboard: ShellClipboard
    private lateinit var files: FileSaver

    /** The window's frame, from its last message: where answers and `lifecycle` go. */
    private var window: JavaScriptReplyProxy? = null
    private val visibility = Visibility()
    private var pendingCamera: PermissionRequest? = null
    private var pendingChooser: ValueCallback<Array<Uri>>? = null

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF) post(Answer.lifecycle(Lifecycle.SCREEN_OFF))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) {
            setContentView(TextView(this).apply { setText(R.string.webview_too_old) })
            return
        }
        keystore = ShellKeystore(this)
        clipboard = ShellClipboard(applicationContext)
        files = FileSaver(this, ::answer)

        web = newShellWebView(this, chromeClient()) { reply, data ->
            window = reply
            when (val parsed = Bridge.parse(data ?: return@newShellWebView, BridgeWindow.MAIN)) {
                is Parsed.Dropped -> Unit
                is Parsed.Refused -> answer(parsed.id, Outcome.Error(ShellError.INVALID))
                is Parsed.Accepted -> handle(parsed.id, parsed.request)
            }
        }

        registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
        setContentView(FrameLayout(this).apply {
            fitsSystemWindows = true
            addView(web)
        })
        web.loadUrl("$ORIGIN/index.html")
    }

    /** The camera for the app's origin and the file chooser: what only the main window needs (§3). */
    private fun chromeClient() = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) {
            if (!grantsCamera(request.origin.toString(), request.resources)) return request.deny()
            if (checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) {
                request.grant(request.resources)
            } else {
                pendingCamera?.deny()
                pendingCamera = request
                requestPermissions(arrayOf(Manifest.permission.CAMERA), CAMERA_REQUEST)
            }
        }

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            pendingChooser?.onReceiveValue(null)
            pendingChooser = callback
            val intent = Intent(Intent.ACTION_OPEN_DOCUMENT).addCategory(Intent.CATEGORY_OPENABLE).setType("*/*")
            val types = mediaTypesOf(params.acceptTypes)
            if (types.isNotEmpty()) intent.putExtra(Intent.EXTRA_MIME_TYPES, types.toTypedArray())
            if (params.mode == FileChooserParams.MODE_OPEN_MULTIPLE) intent.putExtra(Intent.EXTRA_ALLOW_MULTIPLE, true)
            try {
                startActivityForResult(intent, OPEN_REQUEST)
            } catch (e: ActivityNotFoundException) {
                pendingChooser = null
                callback.onReceiveValue(null)
            }
            return true
        }
    }

    private fun handle(id: Long, request: Request) {
        val reply = { outcome: Outcome -> answer(id, outcome) }
        when (request) {
            is Request.KeystoreStatus -> reply(keystore.status(request.localConfigId))
            is Request.KeystoreSeal -> keystore.seal(request.localConfigId, request.secret, reply)
            is Request.KeystoreOpen -> keystore.open(request.localConfigId, request.iv, request.sealed, reply)
            is Request.KeystoreDelete -> reply(keystore.delete(request.localConfigId))
            is Request.ClipboardCopy -> {
                clipboard.copy(request.text, request.clearSeconds)
                reply(Outcome.Ok())
            }
            Request.ClipboardClear -> {
                clipboard.clear()
                reply(Outcome.Ok())
            }
            is Request.FileSave -> files.save(id, request.name, request.mediaType)
            is Request.FileChunk -> files.chunk(id, request.data)
            Request.FileEnd -> files.end(id)
            Request.FileAbort -> {
                files.abort()
                reply(Outcome.Ok())
            }
            Request.BuildInfo -> reply(shellBuildInfo(this))
            Request.LifecycleWatch -> reply(Outcome.Ok(JSONObject().put("state", if (visibility.hidden) "hidden" else "shown")))
            // The provider types come from the provider window only (§9): the parser has refused them.
            Request.ProviderRequest, is Request.ProviderResult -> reply(Outcome.Error(ShellError.INVALID))
        }
    }

    private fun answer(id: Long, outcome: Outcome) = post(Answer.of(id, outcome))

    /** Posts to the window on the main thread; before its first message there is no window to reach. */
    private fun post(text: String) {
        runOnUiThread { window?.postMessage(text) }
    }

    override fun onStart() {
        super.onStart()
        post(Answer.lifecycle(visibility.started()))
    }

    override fun onStop() {
        visibility.stopped()?.let { post(Answer.lifecycle(it)) }
        super.onStop()
    }

    /** The shell's pickers, opening and saving a file, keep the window shown while open (D294). */
    @Deprecated("Activity's own result API: the shell uses no androidx.activity")
    override fun startActivityForResult(intent: Intent, requestCode: Int) {
        val picker = requestCode == OPEN_REQUEST || requestCode == SAVE_REQUEST
        if (picker) visibility.pickerOpened()
        try {
            super.startActivityForResult(intent, requestCode)
        } catch (e: RuntimeException) {
            if (picker) visibility.pickerClosed()
            throw e
        }
    }

    @Deprecated("Activity's own result API: the shell uses no androidx.activity")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        if (requestCode == OPEN_REQUEST || requestCode == SAVE_REQUEST) visibility.pickerClosed()
        when (requestCode) {
            OPEN_REQUEST -> {
                val callback = pendingChooser ?: return
                pendingChooser = null
                callback.onReceiveValue(if (resultCode == RESULT_OK) chosen(data) else null)
            }
            SAVE_REQUEST -> files.picked(resultCode, data)
            else -> super.onActivityResult(requestCode, resultCode, data)
        }
    }

    private fun chosen(data: Intent?): Array<Uri>? {
        val clip = data?.clipData
        if (clip != null) return Array(clip.itemCount) { clip.getItemAt(it).uri }
        return data?.data?.let { arrayOf(it) }
    }

    override fun onRequestPermissionsResult(requestCode: Int, permissions: Array<out String>, grantResults: IntArray) {
        if (requestCode != CAMERA_REQUEST) return super.onRequestPermissionsResult(requestCode, permissions, grantResults)
        val request = pendingCamera ?: return
        pendingCamera = null
        if (grantResults.firstOrNull() == PackageManager.PERMISSION_GRANTED) request.grant(request.resources) else request.deny()
    }

    override fun onDestroy() {
        if (::web.isInitialized) {
            unregisterReceiver(screenOff)
            files.shutdown()
            pendingChooser?.onReceiveValue(null)
            pendingCamera?.deny()
            web.destroy()
        }
        super.onDestroy()
    }
}
