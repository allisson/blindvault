// The autofill service (android.md §8, D304): it holds no session, so it cannot know what the vault holds. For a
// structure with a user name or password field, it answers one BlindVault dataset whose authentication opens
// ProviderActivity, which unlocks, lists the logins and fills the fields on the user's tap. Who asks and which
// fields stay here, under a random token the intent's data carries; the structure Android appends to that intent
// is never read. Nothing is read from the vault, logged or stored here.
package io.github.allisson.blindvault

import android.app.PendingIntent
import android.app.assist.AssistStructure
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.SigningInfo
import android.net.Uri
import android.os.CancellationSignal
import android.service.autofill.AutofillService
import android.service.autofill.Dataset
import android.service.autofill.Field
import android.service.autofill.FillCallback
import android.service.autofill.FillRequest
import android.service.autofill.FillResponse
import android.service.autofill.Presentations
import android.service.autofill.SaveCallback
import android.service.autofill.SaveRequest
import android.view.View
import android.view.autofill.AutofillId
import android.view.autofill.AutofillValue
import android.widget.RemoteViews
import androidx.credentials.provider.CallingAppInfo
import java.security.SecureRandom
import java.util.concurrent.atomic.AtomicInteger

/** The scheme of the authentication intent's data, `blindvault-autofill:<token>`. */
const val AUTOFILL_SCHEME = "blindvault-autofill"

private const val DATASET_NAME = "BlindVault"

/** The requests waiting for the window: a few, since each fill request replaces the user's last. */
val autofillRequests = AutofillRequests<AutofillId>(16) { ByteArray(32).also { SecureRandom().nextBytes(it) } }

private val requestCodes = AtomicInteger()

/** The menu entry: BlindVault. */
private fun presentations(context: Context): Presentations =
    Presentations.Builder()
        .setMenuPresentation(
            RemoteViews(context.packageName, android.R.layout.simple_list_item_1).apply {
                setTextViewText(android.R.id.text1, DATASET_NAME)
            },
        )
        .build()

/** The dataset the window answers: the user name and the password for the fields found (§8 "Window"). */
fun filledDataset(context: Context, pending: PendingAutofill<AutofillId>, userName: String, password: String): Dataset {
    val dataset = Dataset.Builder(presentations(context))
    pending.userName?.let { dataset.setField(it, Field.Builder().setValue(AutofillValue.forText(userName)).build()) }
    pending.password?.let { dataset.setField(it, Field.Builder().setValue(AutofillValue.forText(password)).build()) }
    return dataset.build()
}

private fun nodeOf(node: AssistStructure.ViewNode): StructureNode<AutofillId> {
    val html = node.htmlInfo
    fun attribute(name: String) = html?.attributes?.firstOrNull { it.first.equals(name, ignoreCase = true) }?.second
    return StructureNode(
        id = node.autofillId,
        textInput = node.autofillType == View.AUTOFILL_TYPE_TEXT,
        focused = node.isFocused,
        hints = node.autofillHints?.toList() ?: emptyList(),
        htmlType = if (html?.tag.equals("input", ignoreCase = true)) attribute("type")?.lowercase() ?: "text" else null,
        htmlAutocomplete = attribute("autocomplete"),
        inputType = node.inputType,
        webDomain = node.webDomain,
        webScheme = node.webScheme,
        children = (0 until node.childCount).map { nodeOf(node.getChildAt(it)) },
    )
}

class FillService : AutofillService() {
    override fun onFillRequest(request: FillRequest, cancellationSignal: CancellationSignal, callback: FillCallback) {
        val structure = request.fillContexts.lastOrNull()?.structure ?: return callback.onSuccess(null)
        val roots = (0 until structure.windowNodeCount).map { nodeOf(structure.getWindowNodeAt(it).rootViewNode) }
        val found = findFields(flatten(roots)) ?: return callback.onSuccess(null)

        val packageName = structure.activityComponent.packageName
        val signing = signingInfo(packageName)
        val caller = autofillCallerOf(
            packageName,
            this.packageName,
            signing?.apkContentsSigners?.map { it.toByteArray() },
            found.webScheme,
            found.webDomain,
        ) { origin -> CallingAppInfo(packageName, signing!!, origin).getOrigin(Allowlist.get(this)) }
        if (!servesCaller(caller)) return callback.onSuccess(null)

        val token = autofillRequests.put(PendingAutofill(caller, found.userName, found.password))
        val intent = PendingIntent.getActivity(
            this,
            requestCodes.incrementAndGet(),
            Intent(this, ProviderActivity::class.java).setData(Uri.parse("$AUTOFILL_SCHEME:$token")),
            PendingIntent.FLAG_MUTABLE or PendingIntent.FLAG_UPDATE_CURRENT,
        )
        val dataset = Dataset.Builder(presentations(this))
        listOfNotNull(found.userName, found.password).forEach { dataset.setField(it, Field.Builder().build()) }
        dataset.setAuthentication(intent.intentSender)
        callback.onSuccess(FillResponse.Builder().addDataset(dataset.build()).build())
    }

    /** Saving is out of v1 (§12): no response asks for it. */
    override fun onSaveRequest(request: SaveRequest, callback: SaveCallback) {
        callback.onSuccess()
    }

    /** The package's signing information, `null` when the service cannot see it (§8 "Visibility"). */
    private fun signingInfo(packageName: String): SigningInfo? = try {
        packageManager.getPackageInfo(packageName, PackageManager.GET_SIGNING_CERTIFICATES).signingInfo
    } catch (e: PackageManager.NameNotFoundException) {
        null
    }
}
