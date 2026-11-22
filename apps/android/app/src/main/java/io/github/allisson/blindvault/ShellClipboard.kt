// The clipboard (android.md §6.1, D282): the copy is marked sensitive, so Android hides it in its
// preview, and the clear's timer runs here, with or without the window's focus.
package io.github.allisson.blindvault

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.Handler
import android.os.Looper
import android.os.PersistableBundle

class ShellClipboard(context: Context) {
    private val manager = context.getSystemService(ClipboardManager::class.java)
    private val handler = Handler(Looper.getMainLooper())
    private val clearLater = Runnable { manager.clearPrimaryClip() }

    fun copy(text: String, clearSeconds: Int) {
        val clip = ClipData.newPlainText("BlindVault", text)
        clip.description.extras = PersistableBundle().apply {
            putBoolean(ClipDescription.EXTRA_IS_SENSITIVE, true)
        }
        manager.setPrimaryClip(clip)
        handler.removeCallbacks(clearLater)
        handler.postDelayed(clearLater, clearSeconds * 1000L)
    }

    fun clear() {
        handler.removeCallbacks(clearLater)
        manager.clearPrimaryClip()
    }
}
