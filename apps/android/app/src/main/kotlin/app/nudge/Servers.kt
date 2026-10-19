// The servers this device owns (ADR 11), with a server token each, and the exe.dev key and token
// servers are made with. Kept in the app's private preferences, like the player tokens; never sent to a
// server but the one each belongs to.
package app.nudge

import android.content.SharedPreferences
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import nudge.client.PreferencesTokens
import nudge.ffi.ExeClient
import nudge.ffi.ServerClient
import nudge.ffi.WiredStatus
import nudge.ffi.exeNewKey

class Servers(private val preferences: SharedPreferences) {
    private val mutableOwned = MutableStateFlow(saved())
    /** The addresses of the servers this device signed in to as an owner. */
    val owned: StateFlow<List<String>> = mutableOwned.asStateFlow()

    /** The server's own API, signed in as an owner when this device has a server token for it. */
    fun client(server: String): ServerClient =
        ServerClient(server, tokens(server), "nudge-android", "android")

    /** Keeps a server token, as setup and signing in as an owner give one. */
    fun remember(server: String, token: String) {
        tokens(server).set(token)
        if (server !in mutableOwned.value) {
            mutableOwned.value += server
            save()
        }
    }

    /** Signs this device out of a server's own API, as far as it can be reached. */
    suspend fun forget(server: String) {
        runCatching { client(server).signOut() }
        tokens(server).set(null)
        mutableOwned.value -= server
        save()
    }

    /**
     * The owned server that holds a Wired network (other than [except]), if any: the home that
     * new servers join. With [holding], only one whose network has that member.
     */
    suspend fun wiredRoot(except: String? = null, holding: String? = null): String? =
        mutableOwned.value.filter { it != except }.firstOrNull { server ->
            val state = runCatching { client(server).wired() }.getOrNull()
            state != null && state.state == WiredStatus.ROOT && (holding == null || state.members.any { it.name == holding })
        }

    /** The exe.dev token the person pasted, to make and remove servers with. */
    var exeToken: String?
        get() = preferences.getString(EXE_TOKEN, null)
        set(token) {
            preferences.edit().apply { if (token == null) remove(EXE_TOKEN) else putString(EXE_TOKEN, token) }.apply()
        }

    fun exe(): ExeClient? = exeToken?.let { ExeClient(it) }

    /**
     * The app's SSH key for exe.dev, made the first time. Signing in adds it to the person's
     * account, and the exe.dev token is signed with it.
     */
    fun exeKey(): String =
        preferences.getString(EXE_KEY, null)
            ?: exeNewKey().privateKey.also { preferences.edit().putString(EXE_KEY, it).apply() }

    private fun tokens(server: String) = PreferencesTokens(preferences, "serverToken:${server.trimEnd('/')}")

    private fun saved(): List<String> = preferences.getStringSet(OWNED, emptySet()).orEmpty().sorted()

    private fun save() = preferences.edit().putStringSet(OWNED, mutableOwned.value.toSet()).apply()

    private companion object {
        const val OWNED = "servers"
        const val EXE_TOKEN = "exe.token"
        const val EXE_KEY = "exe.key"
    }
}
