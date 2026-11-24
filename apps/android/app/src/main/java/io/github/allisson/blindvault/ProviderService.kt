// The credential provider service (android.md §7.2, D290, D301): it holds no session, so it cannot know
// what the vault holds. It answers each begin call at once, since Android gives each 3 s, with one
// BlindVault entry per passkey or password option, and one create entry for a passkey, for a privileged
// browser or an app (D303: whether an app is bound to the domain is checked in the window); its PendingIntent
// opens ProviderActivity, which unlocks and asks the user. Nothing is read from the vault, logged or stored here.
package io.github.allisson.blindvault

import android.app.PendingIntent
import android.content.Context
import android.content.Intent
import android.os.CancellationSignal
import android.os.OutcomeReceiver
import androidx.credentials.exceptions.ClearCredentialException
import androidx.credentials.exceptions.CreateCredentialException
import androidx.credentials.exceptions.GetCredentialException
import androidx.credentials.provider.BeginCreateCredentialRequest
import androidx.credentials.provider.BeginCreateCredentialResponse
import androidx.credentials.provider.BeginCreatePublicKeyCredentialRequest
import androidx.credentials.provider.BeginGetCredentialRequest
import androidx.credentials.provider.BeginGetCredentialResponse
import androidx.credentials.provider.BeginGetPasswordOption
import androidx.credentials.provider.BeginGetPublicKeyCredentialOption
import androidx.credentials.provider.CreateEntry
import androidx.credentials.provider.CredentialEntry
import androidx.credentials.provider.CredentialProviderService
import androidx.credentials.provider.PasswordCredentialEntry
import androidx.credentials.provider.ProviderClearCredentialStateRequest
import androidx.credentials.provider.PublicKeyCredentialEntry
import java.util.concurrent.atomic.AtomicInteger

private const val ENTRY_NAME = "BlindVault"

/** Each entry's request code: no two PendingIntents are the same, so none replaces another's request. */
private val requestCodes = AtomicInteger()

/** Opens `ProviderActivity` for `kind`. `FLAG_MUTABLE` so Android appends the request; never `FLAG_ONE_SHOT`. */
private fun entryIntent(context: Context, kind: RequestKind): PendingIntent =
    PendingIntent.getActivity(
        context,
        requestCodes.incrementAndGet(),
        Intent(context, ProviderActivity::class.java).putExtra(EXTRA_REQUEST_KIND, kind.wire),
        PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
    )

class ProviderService : CredentialProviderService() {
    override fun onBeginGetCredentialRequest(
        request: BeginGetCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginGetCredentialResponse, GetCredentialException>,
    ) {
        val entries = mutableListOf<CredentialEntry>()
        if (served(request.callingAppInfo)) {
            for (option in request.beginGetCredentialOptions) {
                if (option is BeginGetPublicKeyCredentialOption) {
                    entries += PublicKeyCredentialEntry.Builder(this, ENTRY_NAME, entryIntent(this, RequestKind.GET), option).build()
                } else if (option is BeginGetPasswordOption) {
                    entries += PasswordCredentialEntry.Builder(this, ENTRY_NAME, entryIntent(this, RequestKind.PASSWORD), option).build()
                }
            }
        }
        callback.onResult(BeginGetCredentialResponse.Builder().setCredentialEntries(entries).build())
    }

    override fun onBeginCreateCredentialRequest(
        request: BeginCreateCredentialRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<BeginCreateCredentialResponse, CreateCredentialException>,
    ) {
        val response = BeginCreateCredentialResponse.Builder()
        if (request is BeginCreatePublicKeyCredentialRequest && served(request.callingAppInfo)) {
            response.addCreateEntry(CreateEntry.Builder(ENTRY_NAME, entryIntent(this, RequestKind.CREATE)).build())
        }
        callback.onResult(response.build())
    }

    /** The provider keeps no state. */
    override fun onClearCredentialStateRequest(
        request: ProviderClearCredentialStateRequest,
        cancellationSignal: CancellationSignal,
        callback: OutcomeReceiver<Void?, ClearCredentialException>,
    ) {
        callback.onResult(null)
    }

    private fun served(info: androidx.credentials.provider.CallingAppInfo?): Boolean =
        info != null && servesCaller(callerOf(this, info))
}
