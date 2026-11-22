// Saving a file (android.md §6.2): `file-save` opens ACTION_CREATE_DOCUMENT, the chunks are written
// in order on one thread, `file-end` closes the document. One save at a time; a save asked while
// another runs is refused. An abort, a failed write or the window leaving deletes the partial
// document. State changes on the main thread only.
package io.github.allisson.blindvault

import android.app.Activity
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import java.io.OutputStream
import java.util.concurrent.Executors

const val SAVE_REQUEST = 2

class FileSaver(private val activity: Activity, private val answer: (Long, Outcome) -> Unit) {
    private class Writing(val uri: Uri, val out: OutputStream) {
        /** Read and written on the I/O thread only. */
        var failed = false
    }

    private val io = Executors.newSingleThreadExecutor()

    /** The `file-save` waiting for the picker, and whether an abort came meanwhile. */
    private var picking: Long? = null
    private var abortedWhilePicking = false
    private var writing: Writing? = null

    private fun busy() = picking != null || writing != null

    fun save(id: Long, name: String, mediaType: String) {
        if (busy()) return answer(id, Outcome.Error(ShellError.INVALID))
        val intent = Intent(Intent.ACTION_CREATE_DOCUMENT)
            .addCategory(Intent.CATEGORY_OPENABLE)
            .setType(mediaType)
            .putExtra(Intent.EXTRA_TITLE, name)
        picking = id
        abortedWhilePicking = false
        try {
            activity.startActivityForResult(intent, SAVE_REQUEST)
        } catch (e: Exception) {
            picking = null
            answer(id, Outcome.Error(ShellError.FAILED))
        }
    }

    /** The picker's result, from `onActivityResult`. */
    fun picked(resultCode: Int, data: Intent?) {
        val id = picking ?: return
        picking = null
        val uri = data?.data
        if (abortedWhilePicking) {
            if (uri != null) io.execute { delete(uri) }
            return answer(id, Outcome.Error(ShellError.CANCELLED))
        }
        if (resultCode != Activity.RESULT_OK || uri == null) return answer(id, Outcome.Error(ShellError.CANCELLED))
        val out = try {
            activity.contentResolver.openOutputStream(uri, "wt")
        } catch (e: Exception) {
            null
        }
        if (out == null) {
            io.execute { delete(uri) }
            return answer(id, Outcome.Error(ShellError.FAILED))
        }
        writing = Writing(uri, out)
        answer(id, Outcome.Ok())
    }

    fun chunk(id: Long, data: ByteArray) {
        val save = writing ?: return answer(id, Outcome.Error(ShellError.INVALID))
        io.execute {
            val outcome = if (save.failed) {
                Outcome.Error(ShellError.FAILED)
            } else {
                try {
                    save.out.write(data)
                    Outcome.Ok()
                } catch (e: Exception) {
                    save.failed = true
                    Outcome.Error(ShellError.FAILED)
                }
            }
            data.fill(0)
            activity.runOnUiThread {
                if (outcome is Outcome.Error && writing === save) discard(save)
                answer(id, outcome)
            }
        }
    }

    fun end(id: Long) {
        val save = writing ?: return answer(id, Outcome.Error(ShellError.INVALID))
        writing = null
        io.execute {
            val outcome = try {
                if (save.failed) throw IllegalStateException("a write failed")
                save.out.close()
                Outcome.Ok()
            } catch (e: Exception) {
                close(save)
                delete(save.uri)
                Outcome.Error(ShellError.FAILED)
            }
            activity.runOnUiThread { answer(id, outcome) }
        }
    }

    /** `file-abort`, a lock or the window leaving: the partial document is deleted. */
    fun abort() {
        if (picking != null) abortedWhilePicking = true
        writing?.let { discard(it) }
    }

    private fun discard(save: Writing) {
        writing = null
        io.execute {
            close(save)
            delete(save.uri)
        }
    }

    private fun close(save: Writing) {
        try {
            save.out.close()
        } catch (e: Exception) {
            // Deleted next.
        }
    }

    private fun delete(uri: Uri) {
        try {
            DocumentsContract.deleteDocument(activity.contentResolver, uri)
        } catch (e: Exception) {
            // The provider refused; nothing more the shell can do.
        }
    }

    fun shutdown() {
        abort()
        io.shutdown()
    }
}
