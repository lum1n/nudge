// The signed-in account and its client: one assistant on one server, the token in the app's
// private preferences, views and the outbox in a SQLite file of their own. Push registration
// goes through here too.
package app.nudge

import android.content.Context
import com.google.firebase.messaging.FirebaseMessaging
import java.io.File
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import nudge.client.Observed
import nudge.client.PairingLink
import nudge.client.PreferencesTokens
import nudge.client.observeConnectionState
import nudge.client.observeHomeState
import nudge.ffi.Assistant
import nudge.ffi.ClientConfig
import nudge.ffi.ConnectionStatus
import nudge.ffi.DeviceKey
import nudge.ffi.DevicePlatform
import nudge.ffi.HomeUpdate
import nudge.ffi.MeInfo
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.PushPayload
import nudge.ffi.PushPlatforms
import nudge.ffi.newDeviceKey
import nudge.ffi.registerWithRelay

/** Where the app signs in. */
data class Account(val server: String, val assistant: String, val assistantName: String) {
    val key get() = "$server|$assistant"
}

/** A signed-in account with its client and the views every screen needs. */
class Session(
    val account: Account,
    val client: NudgeClient,
    val connection: Observed<ConnectionStatus>,
    val home: Observed<HomeUpdate>,
)

class AppModel(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val preferences = context.getSharedPreferences("nudge", Context.MODE_PRIVATE)

    private val mutableSession = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = mutableSession.asStateFlow()

    private val mutableMe = MutableStateFlow<MeInfo?>(null)
    /** Who the player is, once the server said. */
    val me: StateFlow<MeInfo?> = mutableMe.asStateFlow()

    private val mutablePushPlatforms = MutableStateFlow<PushPlatforms?>(null)
    /** Which native pushes the server sends; null until asked, or when it sends none. */
    val pushPlatforms: StateFlow<PushPlatforms?> = mutablePushPlatforms.asStateFlow()

    /** The room on screen; pushes for it aren't shown while the app is. */
    val selectedRoom = MutableStateFlow<String?>(null)
    /** A room to open, from a tapped notification. */
    val requestedRoom = MutableStateFlow<String?>(null)
    /** A pairing link opened while signed out, or for another server. */
    val pendingLink = MutableStateFlow<PairingLink?>(null)
    /** Why the app signed out on its own, for the sign-in screen. */
    val signedOutBecause = MutableStateFlow<String?>(null)

    /** Whether the app is on screen; pushes for the open room aren't shown then. */
    @Volatile var foreground = false
        private set

    private var deviceToken: String? = null
    private var registeredToken: String? = null
    /** What the server knows the device by: the FCM token, or the relay's handle for it. */
    private var registeredDevice: String? = null

    /**
     * The device's key for pushes through the relay, made once and kept in the app's private
     * preferences; the relay and Firebase see only what is sealed for it.
     */
    private val deviceKey: DeviceKey by lazy {
        val publicKey = preferences.getString("deviceKey.public", null)
        val privateKey = preferences.getString("deviceKey.private", null)
        if (publicKey != null && privateKey != null) {
            DeviceKey(publicKey, privateKey)
        } else {
            newDeviceKey().also { key ->
                preferences.edit()
                    .putString("deviceKey.public", key.publicKey)
                    .putString("deviceKey.private", key.privateKey)
                    .apply()
            }
        }
    }

    init {
        val server = preferences.getString("server", null)
        val assistant = preferences.getString("assistant", null)
        if (server != null && assistant != null) {
            start(Account(server, assistant, preferences.getString("assistantName", null) ?: assistant))
        }
    }

    /** Trades a pairing code for a token, and signs in. */
    suspend fun signIn(server: String, assistant: Assistant, code: String) {
        val account = Account(server, assistant.name, assistant.displayName)
        val tokens = tokens(account)
        val client = NudgeClient(config(account), tokens)
        val entered = code.trim()
        try {
            if (entered.startsWith("nudge_")) {
                // A token from `nudge token <player>` signs in as it is; checked before it is kept.
                tokens.set(entered)
                client.me()
            } else {
                client.pair(entered)
            }
        } catch (error: Exception) {
            if (entered.startsWith("nudge_")) tokens.set(null)
            client.close()
            throw error
        }
        preferences.edit()
            .putString("server", account.server)
            .putString("assistant", account.assistant)
            .putString("assistantName", account.assistantName)
            .apply()
        signedOutBecause.value = null
        start(account, client)
    }

    /** Forgets the token, the device's push registration and the cached views. */
    suspend fun signOut(because: String? = null) {
        val session = mutableSession.value ?: return
        // Cleared first: revoking the token closes the socket with 4401, which mustn't sign out
        // a second time.
        val device = registeredDevice
        mutableSession.value = null
        session.connection.close()
        session.home.close()
        mutableMe.value = null
        mutablePushPlatforms.value = null
        registeredToken = null
        registeredDevice = null
        selectedRoom.value = null
        requestedRoom.value = null
        signedOutBecause.value = because
        preferences.edit().remove("server").remove("assistant").remove("assistantName").apply()
        device?.let { token -> runCatching { session.client.unregisterDevice(token) } }
        // Revoked on the server too; signed out here whether or not it can be reached.
        runCatching { session.client.signOut() }
        session.client.disconnect()
        session.client.close()
        tokens(session.account).set(null)
        cacheFile(session.account).delete()
    }

    /** The socket is closed while the app is in the background, so the server pushes instead. */
    fun setForeground(foreground: Boolean) {
        this.foreground = foreground
        val client = mutableSession.value?.client ?: return
        if (foreground) {
            client.connect()
            client.retryNow()
        } else {
            client.disconnect()
        }
    }

    /** An FCM registration token, new or again: register it with the server once signed in. */
    fun onPushToken(token: String) {
        deviceToken = token
        scope.launch { registerDevice() }
    }

    /** What a push through the relay says, opened with the device's key; null if it isn't for it. */
    fun openPush(sealed: String): PushPayload? = nudge.ffi.openPush(deviceKey.privateKey, sealed)

    /** A tapped notification: open its room, if it is for this account's assistant. */
    fun open(assistant: String?, room: String?) {
        if (room == null) return
        if (assistant != null && assistant != mutableSession.value?.account?.assistant) return
        requestedRoom.value = room
    }

    private fun start(account: Account, made: NudgeClient? = null) {
        val client = made ?: runCatching { NudgeClient(config(account), tokens(account)) }.getOrNull() ?: return
        client.connect()
        mutableSession.value = Session(account, client, client.observeConnectionState(), client.observeHomeState())
        scope.launch {
            mutableMe.value = runCatching { client.me() }.getOrNull()
            mutablePushPlatforms.value = runCatching { client.pushPlatforms() }.getOrNull()
            registerDevice()
        }
        if (BuildConfig.FIREBASE) {
            // The token arrives in PushService.onRegistered.
            FirebaseMessaging.getInstance().register()
        }
    }

    /**
     * Registers the FCM token with the server: directly when it sends to this app itself, else
     * through the relay this build knows, if the server sends through it too.
     */
    private suspend fun registerDevice() {
        val client = mutableSession.value?.client ?: return
        val token = deviceToken ?: return
        val platforms = mutablePushPlatforms.value ?: return
        if (token == registeredToken) return
        try {
            if (platforms.fcm) {
                client.registerDevice(DevicePlatform.FCM, token, null)
                registeredDevice = token
            } else {
                val relay = BuildConfig.PUSH_RELAY
                if (relay.isEmpty() || platforms.relays.none { it.trimEnd('/') == relay }) return
                val handle = registerWithRelay(relay, DevicePlatform.FCM, token, null)
                client.registerRelayDevice(relay, handle, deviceKey.publicKey)
                registeredDevice = handle
            }
            registeredToken = token
        } catch (_: NudgeException) {
            // Tried again on the next start or token.
        }
    }

    private fun tokens(account: Account) = PreferencesTokens(preferences, "token:${account.key}")

    private fun config(account: Account) = ClientConfig(
        account.server,
        account.assistant,
        "nudge-android",
        BuildConfig.VERSION_NAME,
        "android",
        cacheFile(account).path,
    )

    private fun cacheFile(account: Account): File {
        val name = account.key.map { if (it.isLetterOrDigit()) it else '_' }.joinToString("")
        return File(context.noBackupFilesDir, "$name.sqlite")
    }
}

/** What to tell the user. */
fun explain(error: Throwable): String = when (error) {
    is NudgeException.Status ->
        if (error.status.toInt() == 401) {
            "That didn't work. A pairing code from nudge pair <your name> works once, for ten minutes; " +
                "a token from nudge token <your name> until it is revoked."
        } else {
            error.detail
        }
    is NudgeException.Network -> "Can't reach the server: ${error.detail}"
    is NudgeException.Decode -> "The server's answer made no sense: ${error.detail}"
    is NudgeException.Config -> error.detail
    else -> error.message ?: error.toString()
}
