// Where a client keeps its token. `pair` stores the token it gets, and every request and
// connection attempt reads it again; both are called on library threads.
package nudge.client

import android.content.SharedPreferences
import nudge.ffi.TokenStore

/** A token held in memory only. */
class MemoryTokens(@Volatile private var token: String? = null) : TokenStore {
    override fun get(): String? = token

    override fun set(token: String?) {
        this.token = token
    }
}

/**
 * A token in the app's private preferences, under [key]. Readable by the app (and its
 * backups, unless excluded) only; a store backed by the Android Keystore can implement
 * [TokenStore] the same way.
 */
class PreferencesTokens(
    private val preferences: SharedPreferences,
    private val key: String = "nudge.token",
) : TokenStore {
    override fun get(): String? = preferences.getString(key, null)

    override fun set(token: String?) {
        preferences.edit().apply { if (token == null) remove(key) else putString(key, token) }.apply()
    }
}
