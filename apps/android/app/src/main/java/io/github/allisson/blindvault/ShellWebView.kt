// The WebView both windows share (android.md §3, D282, D297): apps/web's Android build served from the APK
// at https://appassets.androidplatform.net with the headers of headers.json, under its real CSP, with
// no autofill, the navigation rules of §3 and the bridge open to that origin in the main frame only. What
// differs between the windows, the permissions and the file chooser, is the caller's `WebChromeClient`.
package io.github.allisson.blindvault

import android.app.Activity
import android.content.ActivityNotFoundException
import android.content.Context
import android.content.ContextWrapper
import android.content.Intent
import android.content.pm.ApplicationInfo
import android.content.pm.PackageManager
import android.content.res.Configuration
import android.graphics.drawable.ColorDrawable
import android.view.View
import android.view.WindowInsetsController
import android.webkit.WebChromeClient
import android.webkit.WebResourceRequest
import android.webkit.WebResourceResponse
import android.webkit.WebSettings
import android.webkit.WebView
import android.webkit.WebViewClient
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewAssetLoader
import androidx.webkit.WebViewCompat
import org.json.JSONObject
import java.io.ByteArrayInputStream

private const val SURFACE_LIGHT = 0xFFFAFAFA.toInt()
private const val SURFACE_DARK = 0xFF09090B.toInt()

/**
 * Dark system bar icons over the light theme, light ones over the dark, on the window's background in the
 * page's surface color, `--bv-surface` of apps/web's index.css (D314). The window handles a `uiMode` change
 * itself so the vault stays open, so the theme's attributes are not applied again: each window calls this at
 * creation and on every configuration change.
 */
fun Activity.followSystemBars() {
    val night = resources.configuration.uiMode and Configuration.UI_MODE_NIGHT_MASK == Configuration.UI_MODE_NIGHT_YES
    val light = WindowInsetsController.APPEARANCE_LIGHT_STATUS_BARS or WindowInsetsController.APPEARANCE_LIGHT_NAVIGATION_BARS
    // `decorView` creates the decor first: `window.insetsController` throws before `setContentView`.
    window.decorView.windowInsetsController?.setSystemBarsAppearance(if (night) 0 else light, light)
    window.setBackgroundDrawable(ColorDrawable(if (night) SURFACE_DARK else SURFACE_LIGHT))
}

/** `assets/web/`, apps/web's Android build, with the headers of every response. */
private class AppAssets(activity: Activity, private val headers: Map<String, String>) : WebViewAssetLoader.PathHandler {
    private val assets = WebViewAssetLoader.AssetsPathHandler(activity)

    override fun handle(path: String): WebResourceResponse? =
        assets.handle("web/$path")?.apply { responseHeaders = headers }
}

/**
 * A WebView set up as §3 says. `onMessage` gets each message of the main frame of the app's origin, with
 * the frame's reply proxy and the message's text, `null` when it is not a string; anything else never
 * reaches it.
 */
fun newShellWebView(
    activity: Activity,
    chrome: WebChromeClient,
    onMessage: (reply: JavaScriptReplyProxy, data: String?) -> Unit,
): WebView {
    WebView.setWebContentsDebuggingEnabled(activity.applicationInfo.flags and ApplicationInfo.FLAG_DEBUGGABLE != 0)
    val headers = parseHeaders(activity.assets.open("web/headers.json").bufferedReader().use { it.readText() })
    val loader = WebViewAssetLoader.Builder().addPathHandler("/", AppAssets(activity, headers)).build()

    // No autofill service sees a field of the app: it would offer to save the local password and
    // the items' secrets, which autocomplete="off" does not stop. The WebView asks its context for
    // the autofill manager and skips autofill without one; importantForAutofill alone does not
    // reach the fields it reports itself (D297).
    val web = WebView(object : ContextWrapper(activity) {
        override fun getSystemService(name: String): Any? =
            if (hidesService(name)) null else super.getSystemService(name)
    })
    web.importantForAutofill = View.IMPORTANT_FOR_AUTOFILL_NO_EXCLUDE_DESCENDANTS
    web.settings.apply {
        javaScriptEnabled = true
        domStorageEnabled = true
        allowFileAccess = false
        allowContentAccess = false
        mixedContentMode = WebSettings.MIXED_CONTENT_NEVER_ALLOW
        setSupportMultipleWindows(false)
        javaScriptCanOpenWindowsAutomatically = false
    }
    web.webViewClient = object : WebViewClient() {
        override fun shouldInterceptRequest(view: WebView, request: WebResourceRequest): WebResourceResponse =
            loader.shouldInterceptRequest(request.url)
                ?: WebResourceResponse("text/plain", "utf-8", 404, "Not Found", headers, ByteArrayInputStream(ByteArray(0)))

        override fun shouldOverrideUrlLoading(view: WebView, request: WebResourceRequest): Boolean =
            when (navigationOf(request.url.scheme, request.url.host)) {
                Navigation.STAY -> false
                Navigation.EXTERNAL -> {
                    try {
                        activity.startActivity(Intent(Intent.ACTION_VIEW, request.url).addCategory(Intent.CATEGORY_BROWSABLE))
                    } catch (e: ActivityNotFoundException) {
                        // No browser: the link opens nothing.
                    }
                    true
                }
                Navigation.DROP -> true
            }
    }
    web.webChromeClient = chrome
    WebViewCompat.addWebMessageListener(web, "blindvaultShell", setOf(ORIGIN)) { _, message, origin, isMainFrame, reply ->
        if (!isMainFrame || origin.toString().trimEnd('/') != ORIGIN) return@addWebMessageListener
        onMessage(reply, message.data)
    }
    return web
}

/** The version and the signing certificate's SHA-256, from PackageManager (§10). */
fun shellBuildInfo(context: Context): Outcome {
    val info = context.packageManager.getPackageInfo(context.packageName, PackageManager.GET_SIGNING_CERTIFICATES)
    val signers = info.signingInfo?.apkContentsSigners
    if (signers == null || signers.size != 1) return Outcome.Error(ShellError.FAILED)
    return Outcome.Ok(
        JSONObject()
            .put("versionName", info.versionName)
            .put("versionCode", info.longVersionCode)
            .put("certSha256", sha256Hex(signers[0].toByteArray())),
    )
}
