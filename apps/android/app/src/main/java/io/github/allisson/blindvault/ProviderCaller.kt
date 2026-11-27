// Who asks, from Credential Manager's CallingAppInfo (android.md §7.3, D301): the privileged-browser
// allowlist the build ships, read once per process and never fetched, and `CallingAppInfo.getOrigin` against
// it. The decision itself is `callerOf` in Provider.kt.
package io.github.allisson.blindvault

import android.content.Context
import androidx.credentials.provider.CallingAppInfo

private const val ALLOWLIST_ASSET = "privileged-apps.json"

internal object Allowlist {
    private var json: String? = null
    private var browsers: String? = null

    @Synchronized
    fun get(context: Context): String =
        json ?: context.applicationContext.assets.open(ALLOWLIST_ASSET).bufferedReader().use { it.readText() }.also { json = it }

    /** The allowlist without its packages that are not browsers: whose `webDomain` autofill trusts (§8, D309). */
    @Synchronized
    fun browsers(context: Context): String = browsers ?: browsersOnly(get(context)).also { browsers = it }
}

/** The caller of `info`, a privileged browser only when its package and certificate are in the allowlist. */
fun callerOf(context: Context, info: CallingAppInfo): Caller =
    callerOf(
        info.packageName,
        info.signingInfoCompat.apkContentsSigners.map { it.toByteArray() },
        info.isOriginPopulated(),
    ) { info.getOrigin(Allowlist.get(context)) }
