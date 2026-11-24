// The credential types the provider declares (android.md §7, D303): Android asks a provider only for the
// types its `res/xml/provider.xml` lists, so a missing one silently gets no request.
package io.github.allisson.blindvault

import org.junit.Assert.assertEquals
import org.junit.Test
import java.io.File

class CapabilitiesTest {
    @Test
    fun declaresPasskeysAndPasswordsOnly() {
        val names = Regex("""<capability\s+name="([^"]+)"""")
            .findAll(File("src/main/res/xml/provider.xml").readText())
            .map { it.groupValues[1] }
            .toSet()
        assertEquals(
            setOf("androidx.credentials.TYPE_PUBLIC_KEY_CREDENTIAL", "android.credentials.TYPE_PASSWORD_CREDENTIAL"),
            names,
        )
    }
}
