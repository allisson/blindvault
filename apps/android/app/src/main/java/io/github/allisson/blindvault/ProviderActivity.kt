// The provider window (android.md §7.1, §8, §9, D301, D303, D304): `ProviderActivity` runs apps/web's provider.html
// in the same WebView as the main window's, for one passkey or password request Credential Manager passed, or one
// autofill request the autofill service keeps under the token of the intent's data, from a privileged browser or
// an app. The window unlocks, asks
// the user and answers with `provider-result`; the shell checks it against the request and its caller,
// answers Credential Manager and finishes. Exactly one answer per activity: Back, the window stopped or
// destroyed without one, or a newer request, answers a cancellation. An app gets a credential only after the window's `provider-assetlinks` was answered
// `bound` (§7.4). The shell holds no key and logs
// nothing of the request or the response.
package io.github.allisson.blindvault

import android.app.Activity
import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent
import android.content.IntentFilter
import android.os.Bundle
import android.view.WindowManager
import android.view.autofill.AutofillId
import android.view.autofill.AutofillManager
import android.webkit.PermissionRequest
import android.webkit.ValueCallback
import android.webkit.WebChromeClient
import android.webkit.WebView
import android.window.OnBackInvokedDispatcher
import android.widget.FrameLayout
import android.net.Uri
import androidx.credentials.CreatePublicKeyCredentialRequest
import androidx.credentials.CreatePublicKeyCredentialResponse
import androidx.credentials.GetCredentialResponse
import androidx.credentials.GetPasswordOption
import androidx.credentials.GetPublicKeyCredentialOption
import androidx.credentials.PasswordCredential
import androidx.credentials.PublicKeyCredential
import androidx.credentials.exceptions.CreateCredentialCancellationException
import androidx.credentials.exceptions.CreateCredentialUnknownException
import androidx.credentials.exceptions.GetCredentialCancellationException
import androidx.credentials.exceptions.GetCredentialUnknownException
import androidx.credentials.exceptions.domerrors.InvalidStateError
import androidx.credentials.exceptions.domerrors.NotAllowedError
import androidx.credentials.exceptions.publickeycredential.CreatePublicKeyCredentialDomException
import androidx.credentials.exceptions.publickeycredential.GetPublicKeyCredentialDomException
import androidx.credentials.provider.PendingIntentHandler
import androidx.webkit.JavaScriptReplyProxy
import androidx.webkit.WebViewFeature
import org.json.JSONObject

/** The entry's PendingIntent names its kind, `get`, `create` or `password`, so the activity knows which request to read. */
const val EXTRA_REQUEST_KIND = "io.github.allisson.blindvault.REQUEST_KIND"

class ProviderActivity : Activity() {
    private var web: WebView? = null
    private lateinit var keystore: ShellKeystore
    private lateinit var clipboard: ShellClipboard

    private var kind = RequestKind.GET
    private var request: ProviderRequest? = null

    /** An autofill request (§8): its fields, filled on a `password` result; `null` for Credential Manager's. */
    private var autofill: PendingAutofill<AutofillId>? = null

    /** `provider-request` answered: it is answered once. */
    private var requested = false

    /** Credential Manager answered: exactly one answer per activity. */
    private var ended = false

    /** `provider-assetlinks` fetches started: the window gets `MAX_ASSETLINKS_FETCHES`. */
    private var fetches = 0

    /** The domains this request got a `bound` answer for: an app's credential is checked against them (§7.4, AND-1). */
    private val bound = mutableSetOf<String>()

    /** The window's frame, from its last message: where answers and `lifecycle` go. */
    private var frame: JavaScriptReplyProxy? = null
    private val visibility = Visibility()

    private val screenOff = object : BroadcastReceiver() {
        override fun onReceive(context: Context, intent: Intent) {
            if (intent.action == Intent.ACTION_SCREEN_OFF) post(Answer.lifecycle(Lifecycle.SCREEN_OFF))
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        getWindow().setFlags(WindowManager.LayoutParams.FLAG_SECURE, WindowManager.LayoutParams.FLAG_SECURE)
        // One request at a time: a newer one cancels the one still open.
        current?.takeIf { it !== this }?.end(CallerAnswer.Cancelled)
        current = this

        val uri = intent.data
        if (uri != null) {
            // An autofill request (§8, D304): only by its token, taken once; the extras and the appended structure
            // are not read.
            val pending = uri.takeIf { it.scheme == AUTOFILL_SCHEME }?.schemeSpecificPart?.let { autofillRequests.take(it) }
                ?: return end(CallerAnswer.Cancelled)
            autofill = pending
            kind = RequestKind.PASSWORD
            request = providerRequestOf(RequestKind.PASSWORD, pending.caller, null, null) ?: return end(CallerAnswer.Cancelled)
        } else {
            kind = when (intent.getStringExtra(EXTRA_REQUEST_KIND)) {
                RequestKind.GET.wire -> RequestKind.GET
                RequestKind.CREATE.wire -> RequestKind.CREATE
                RequestKind.PASSWORD.wire -> RequestKind.PASSWORD
                // Not an entry of ours: nothing to answer.
                else -> return end(CallerAnswer.UseAnother)
            }
            request = when (val read = readRequest()) {
                null -> return end(CallerAnswer.Unknown)
                else -> read.value ?: return end(CallerAnswer.Dom(DomError.NOT_ALLOWED))
            }
        }
        if (!WebViewFeature.isFeatureSupported(WebViewFeature.WEB_MESSAGE_LISTENER)) return end(CallerAnswer.Unknown)

        keystore = ShellKeystore(this)
        clipboard = ShellClipboard(applicationContext)
        val window = newShellWebView(this, deniedChromeClient()) { reply, data -> onMessage(reply, data) }
        web = window
        registerReceiver(screenOff, IntentFilter(Intent.ACTION_SCREEN_OFF), RECEIVER_NOT_EXPORTED)
        // Back: a cancellation, not the system's RESULT_CANCELED, which would show the sheet again.
        onBackInvokedDispatcher.registerOnBackInvokedCallback(OnBackInvokedDispatcher.PRIORITY_DEFAULT) {
            end(CallerAnswer.Cancelled)
        }
        setContentView(FrameLayout(this).apply {
            fitsSystemWindows = true
            addView(window)
        })
        window.loadUrl("$ORIGIN/provider.html")
    }

    /** The request Credential Manager passed, wrapped: `null` when it cannot be read, its `value` `null` when not allowed. */
    private class Read(val value: ProviderRequest?)

    private fun readRequest(): Read? = when (kind) {
        RequestKind.GET -> {
            val passed = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
            if (passed == null) {
                null
            } else {
                val caller = callerOf(this, passed.callingAppInfo)
                val option = passed.credentialOptions.filterIsInstance<GetPublicKeyCredentialOption>().singleOrNull()
                Read(
                    if (!servesCaller(caller) || option == null) null
                    else providerRequestOf(RequestKind.GET, caller, option.requestJson, option.clientDataHash),
                )
            }
        }
        RequestKind.PASSWORD -> {
            val passed = PendingIntentHandler.retrieveProviderGetCredentialRequest(intent)
            if (passed == null) {
                null
            } else {
                val caller = callerOf(this, passed.callingAppInfo)
                val option = passed.credentialOptions.filterIsInstance<GetPasswordOption>().firstOrNull()
                Read(
                    if (!servesCaller(caller) || option == null) null
                    else providerRequestOf(RequestKind.PASSWORD, caller, null, null),
                )
            }
        }
        RequestKind.CREATE -> {
            val passed = PendingIntentHandler.retrieveProviderCreateCredentialRequest(intent)
            if (passed == null) {
                null
            } else {
                val caller = callerOf(this, passed.callingAppInfo)
                val create = passed.callingRequest as? CreatePublicKeyCredentialRequest
                Read(
                    if (!servesCaller(caller) || create == null) null
                    else providerRequestOf(RequestKind.CREATE, caller, create.requestJson, create.clientDataHash),
                )
            }
        }
    }

    /** No permission and no file chooser: the provider window needs neither the camera nor files. */
    private fun deniedChromeClient() = object : WebChromeClient() {
        override fun onPermissionRequest(request: PermissionRequest) = request.deny()

        override fun onShowFileChooser(
            view: WebView,
            callback: ValueCallback<Array<Uri>>,
            params: FileChooserParams,
        ): Boolean {
            callback.onReceiveValue(null)
            return true
        }
    }

    private fun onMessage(reply: JavaScriptReplyProxy, data: String?) {
        if (ended) return
        frame = reply
        when (val parsed = Bridge.parse(data ?: return, BridgeWindow.PROVIDER)) {
            is Parsed.Dropped -> Unit
            is Parsed.Refused -> {
                answer(parsed.id, Outcome.Error(ShellError.INVALID))
                // A malformed provider message ends the request (§7.7).
                if (parsed.type?.startsWith("provider-") == true) end(CallerAnswer.Cancelled)
            }
            is Parsed.Accepted -> handle(parsed.id, parsed.request)
        }
    }

    private fun handle(id: Long, message: Request) {
        val reply = { outcome: Outcome -> answer(id, outcome) }
        when (message) {
            is Request.KeystoreStatus -> reply(keystore.status(message.localConfigId))
            is Request.KeystoreSeal -> keystore.seal(message.localConfigId, message.secret, reply)
            is Request.KeystoreOpen -> keystore.open(message.localConfigId, message.iv, message.sealed, reply)
            is Request.KeystoreDelete -> reply(keystore.delete(message.localConfigId))
            is Request.ClipboardCopy -> {
                clipboard.copy(message.text, message.clearSeconds)
                reply(Outcome.Ok())
            }
            Request.ClipboardClear -> {
                clipboard.clear()
                reply(Outcome.Ok())
            }
            Request.BuildInfo -> reply(shellBuildInfo(this))
            Request.LifecycleWatch -> reply(Outcome.Ok(JSONObject().put("state", if (visibility.hidden) "hidden" else "shown")))
            Request.ProviderRequest -> providerRequest(id)
            is Request.ProviderAssetLinks -> providerAssetLinks(id, message.domain)
            is Request.ProviderResult -> providerResult(id, message.result)
            // The file types come from the main window only (§9): the parser has refused them.
            is Request.FileSave, is Request.FileChunk, Request.FileEnd, Request.FileAbort -> reply(Outcome.Error(ShellError.INVALID))
        }
    }

    /** Answered once: a second `provider-request` ends the window. */
    private fun providerRequest(id: Long) {
        val asked = request
        if (requested || asked == null) {
            answer(id, Outcome.Error(ShellError.INVALID))
            return end(CallerAnswer.Cancelled)
        }
        requested = true
        answer(id, Outcome.Ok(providerRequestFields(asked)))
    }

    /**
     * `provider-assetlinks`: only an app's window, after `provider-request`, and at most `MAX_ASSETLINKS_FETCHES`
     * times (the next is answered `invalid`). The binding is answered on the main thread, unless the request ended;
     * a `bound` one is what lets an app's credential through (§7.4, D303).
     */
    private fun providerAssetLinks(id: Long, domain: String) {
        val caller = request?.caller as? Caller.App
        if (!requested || caller == null) {
            answer(id, Outcome.Error(ShellError.INVALID))
            return end(CallerAnswer.Cancelled)
        }
        if (fetches >= MAX_ASSETLINKS_FETCHES) return answer(id, Outcome.Error(ShellError.INVALID))
        fetches++
        fetchAssetLinks(domain, caller.packageName, caller.certSha256) { binding ->
            runOnUiThread {
                if (ended) return@runOnUiThread
                if (binding == Binding.BOUND) bound += domain
                answer(id, Outcome.Ok(JSONObject().put("result", binding.wire)))
            }
        }
    }

    /** `provider-result` is checked against the request and its caller; a malformed one ends with a cancellation. */
    private fun providerResult(id: Long, result: JSONObject) {
        val asked = request
        val answered = if (!requested || asked == null) null else parseCallerAnswer(result, asked.kind, asked.caller, bound, asked.requestJson)
        if (answered == null) {
            answer(id, Outcome.Error(ShellError.INVALID))
            return end(CallerAnswer.Cancelled)
        }
        end(answered)
    }

    /** Answers Credential Manager, once, and finishes (§7.1 "Ending"). */
    private fun end(answer: CallerAnswer) {
        if (ended) return
        ended = true
        autofill?.let { return endAutofill(it, answer) }
        val data = Intent()
        val code = when (answer) {
            is CallerAnswer.Created -> {
                PendingIntentHandler.setCreateCredentialResponse(data, CreatePublicKeyCredentialResponse(responseJson(answer)))
                RESULT_OK
            }
            is CallerAnswer.Asserted -> {
                PendingIntentHandler.setGetCredentialResponse(data, GetCredentialResponse(PublicKeyCredential(responseJson(answer))))
                RESULT_OK
            }
            is CallerAnswer.Password -> {
                PendingIntentHandler.setGetCredentialResponse(data, GetCredentialResponse(PasswordCredential(answer.userName, answer.password)))
                RESULT_OK
            }
            is CallerAnswer.Dom -> {
                // A password request takes the get exceptions; the parser refuses a `Dom` for it.
                if (kind != RequestKind.CREATE) {
                    PendingIntentHandler.setGetCredentialException(data, GetPublicKeyCredentialDomException(NotAllowedError()))
                } else {
                    PendingIntentHandler.setCreateCredentialException(
                        data,
                        CreatePublicKeyCredentialDomException(
                            if (answer.error == DomError.INVALID_STATE) InvalidStateError() else NotAllowedError(),
                        ),
                    )
                }
                RESULT_OK
            }
            CallerAnswer.Cancelled -> {
                if (kind != RequestKind.CREATE) {
                    PendingIntentHandler.setGetCredentialException(data, GetCredentialCancellationException())
                } else {
                    PendingIntentHandler.setCreateCredentialException(data, CreateCredentialCancellationException())
                }
                RESULT_OK
            }
            CallerAnswer.Unknown -> {
                if (kind != RequestKind.CREATE) {
                    PendingIntentHandler.setGetCredentialException(data, GetCredentialUnknownException())
                } else {
                    PendingIntentHandler.setCreateCredentialException(data, CreateCredentialUnknownException())
                }
                RESULT_OK
            }
            // "Use another authenticator": Android shows its sheet again.
            CallerAnswer.UseAnother -> RESULT_CANCELED
        }
        if (code == RESULT_OK) setResult(code, data) else setResult(code)
        finish()
    }

    /** Answers the autofill request (§8 "Window"): the filled dataset on a `password` result, otherwise nothing filled. */
    private fun endAutofill(pending: PendingAutofill<AutofillId>, answer: CallerAnswer) {
        if (answer is CallerAnswer.Password) {
            setResult(
                RESULT_OK,
                Intent().putExtra(AutofillManager.EXTRA_AUTHENTICATION_RESULT, filledDataset(this, pending, answer.userName, answer.password)),
            )
        } else {
            setResult(RESULT_CANCELED)
        }
        finish()
    }

    private fun answer(id: Long, outcome: Outcome) = post(Answer.of(id, outcome))

    /** Posts to the window on the main thread; before its first message there is no window to reach. */
    private fun post(text: String) {
        runOnUiThread { frame?.postMessage(text) }
    }

    override fun onStart() {
        super.onStart()
        post(Answer.lifecycle(visibility.started()))
    }

    /** The window leaving the screen locks it and answers a cancellation. */
    override fun onStop() {
        visibility.stopped()?.let { post(Answer.lifecycle(it)) }
        end(CallerAnswer.Cancelled)
        super.onStop()
    }

    override fun onDestroy() {
        end(CallerAnswer.Cancelled)
        if (current === this) current = null
        web?.let {
            unregisterReceiver(screenOff)
            it.destroy()
        }
        super.onDestroy()
    }

    private companion object {
        /** The most `provider-assetlinks` fetches one window may start: an app's search tap tries each URL's host. */
        const val MAX_ASSETLINKS_FETCHES = 16

        /** The activity open now: a newer request cancels it. */
        var current: ProviderActivity? = null
    }
}
