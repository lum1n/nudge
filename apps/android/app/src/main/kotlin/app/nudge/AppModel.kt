// The signed-in account and its clients: the player's home, one assistant on one server, and the
// assistants they joined from there (ADR 10). Tokens are in the app's private preferences, each
// client's views and outbox in a SQLite file of its own. Push registration goes through here too.
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
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.sync.withLock
import nudge.client.JoinLink
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
import nudge.ffi.Membership
import nudge.ffi.Memberships
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.PushPayload
import nudge.ffi.PushPlatforms
import nudge.ffi.listAssistants
import nudge.ffi.newDeviceKey
import nudge.ffi.registerWithRelay

/** An assistant the app is signed in to. */
data class Account(val server: String, val assistant: String, val assistantName: String) {
    val key get() = "$server|$assistant"

    fun isAt(server: String, assistant: String) =
        this.server.trimEnd('/') == server.trimEnd('/') && this.assistant == assistant
}

/** A room of one of the account's assistants. */
data class RoomRef(val account: String, val room: String)

/** A signed-in assistant with its client and the views every screen needs. */
class Session(
    val account: Account,
    val client: NudgeClient,
    val connection: Observed<ConnectionStatus>,
    val home: Observed<HomeUpdate>,
) {
    /** Who the player is there, once the server said. */
    val me = MutableStateFlow<MeInfo?>(null)
    /** Which native pushes the server sends; null until asked, or when it sends none. */
    val pushPlatforms = MutableStateFlow<PushPlatforms?>(null)
    internal var registeredToken: String? = null
    /** What the server knows the device by: the FCM token, or the relay's handle for it. */
    internal var registeredDevice: String? = null

    internal fun close() {
        connection.close()
        home.close()
        client.disconnect()
        client.close()
    }
}

class AppModel(private val context: Context) {
    private val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main.immediate)
    private val preferences = context.getSharedPreferences("nudge", Context.MODE_PRIVATE)
    private val syncing = Mutex()

    private val mutableSession = MutableStateFlow<Session?>(null)
    /** The player's home. */
    val session: StateFlow<Session?> = mutableSession.asStateFlow()

    private val mutablePlaces = MutableStateFlow<List<Session>>(emptyList())
    /** The assistants the player joined from home, that this device is signed in to. */
    val places: StateFlow<List<Session>> = mutablePlaces.asStateFlow()

    private val mutableMemberships = MutableStateFlow<Memberships?>(null)
    /** Where the player joined, as their home says; null until it did, or without federation there. */
    val memberships: StateFlow<Memberships?> = mutableMemberships.asStateFlow()

    /** The room on screen; pushes for it aren't shown while the app is. */
    val selectedRoom = MutableStateFlow<RoomRef?>(null)
    /** A room to open, from a tapped notification. */
    val requestedRoom = MutableStateFlow<RoomRef?>(null)
    /** A pairing link opened while signed out, or for another server. */
    val pendingLink = MutableStateFlow<PairingLink?>(null)
    /** A join link: an admin elsewhere invited the player. */
    val pendingJoin = MutableStateFlow<JoinLink?>(null)
    /** Why the app signed out on its own, for the sign-in screen. */
    val signedOutBecause = MutableStateFlow<String?>(null)

    /** Whether the app is on screen; pushes for the open room aren't shown then. */
    @Volatile var foreground = false
        private set

    private var deviceToken: String? = null

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

    /** Every signed-in assistant, home first. */
    fun sessions(): List<Session> = listOfNotNull(mutableSession.value) + mutablePlaces.value

    fun sessionFor(account: String): Session? = sessions().firstOrNull { it.account.key == account }

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

    /** Forgets the tokens, the device's push registrations and the cached views, everywhere. */
    suspend fun signOut(because: String? = null) {
        val session = mutableSession.value ?: return
        // Cleared first: revoking the token closes the socket with 4401, which mustn't sign out
        // a second time.
        mutableSession.value = null
        val places = mutablePlaces.value
        mutablePlaces.value = emptyList()
        mutableMemberships.value = null
        selectedRoom.value = null
        requestedRoom.value = null
        signedOutBecause.value = because
        preferences.edit().remove("server").remove("assistant").remove("assistantName").remove(PLACES).apply()
        for (place in places) forget(place)
        forget(session)
    }

    /** The socket is closed while the app is in the background, so the server pushes instead. */
    fun setForeground(foreground: Boolean) {
        this.foreground = foreground
        for (session in sessions()) {
            if (foreground) {
                session.client.connect()
                session.client.retryNow()
            } else {
                session.client.disconnect()
            }
        }
        if (foreground) scope.launch { syncPlaces() }
    }

    /** An FCM registration token, new or again: register it with every server once signed in. */
    fun onPushToken(token: String) {
        deviceToken = token
        scope.launch { sessions().forEach { registerDevice(it) } }
    }

    /** What a push through the relay says, opened with the device's key; null if it isn't for it. */
    fun openPush(sealed: String): PushPayload? = nudge.ffi.openPush(deviceKey.privateKey, sealed)

    /** A tapped notification: open its room, at the assistant of that name. */
    fun open(assistant: String?, room: String?) {
        if (room == null) return
        val session = sessions().firstOrNull { assistant == null || it.account.assistant == assistant } ?: return
        requestedRoom.value = RoomRef(session.account.key, room)
    }

    /** Whether the room a push is about is on screen. */
    fun showing(assistant: String?, room: String): Boolean {
        val shown = selectedRoom.value ?: return false
        return shown.room == room && (assistant == null || sessionFor(shown.account)?.account?.assistant == assistant)
    }

    /**
     * Joins the assistant a link names, with the home vouching for the player; an admin there must
     * have invited their address.
     */
    suspend fun join(link: JoinLink) {
        val home = mutableSession.value ?: throw IllegalStateException("Sign in at home first.")
        if (home.account.isAt(link.server, link.assistant)) throw IllegalStateException("That is your home.")
        syncing.withLock {
            if (mutablePlaces.value.none { it.account.isAt(link.server, link.assistant) }) {
                mutablePlaces.value += joined(home, link.server, link.assistant)
                savePlaces()
            }
        }
        mutableMemberships.value = runCatching { home.client.memberships() }.getOrNull()
    }

    /** Starts or stops carrying the player's own memory to an assistant they joined. */
    suspend fun carryMemory(membership: Membership, carry: Boolean) {
        val home = mutableSession.value ?: return
        home.client.carryMemory(membership.server, membership.assistant, carry)
        mutableMemberships.value = home.client.memberships()
    }

    /** Stops the home sending the player's profile and memory there, and signs this device out of it. */
    suspend fun leave(membership: Membership) {
        val home = mutableSession.value ?: return
        home.client.leave(membership.server, membership.assistant)
        syncing.withLock {
            val (gone, kept) = mutablePlaces.value.partition { it.account.isAt(membership.server, membership.assistant) }
            mutablePlaces.value = kept
            savePlaces()
            gone.forEach { forget(it) }
        }
        mutableMemberships.value = runCatching { home.client.memberships() }.getOrNull()
    }

    private fun start(account: Account, made: NudgeClient? = null) {
        val session = open(account, made) ?: return
        mutableSession.value = session
        // The assistants joined, as this device last knew them, until home says.
        mutablePlaces.value = savedPlaces().mapNotNull { place ->
            if (tokens(place).get() == null) null else open(place)
        }
        if (BuildConfig.FIREBASE) {
            // The token arrives in PushService.onRegistered.
            FirebaseMessaging.getInstance().register()
        }
        scope.launch { syncPlaces() }
    }

    /** A client of `account`, connected, its player and pushes asked for. */
    private fun open(account: Account, made: NudgeClient? = null): Session? {
        val client = made ?: runCatching { NudgeClient(config(account), tokens(account)) }.getOrNull() ?: return null
        client.connect()
        val session = Session(account, client, client.observeConnectionState(), client.observeHomeState())
        scope.launch {
            session.me.value = runCatching { client.me() }.getOrNull()
            session.pushPlatforms.value = runCatching { client.pushPlatforms() }.getOrNull()
            registerDevice(session)
        }
        return session
    }

    /**
     * Matches the assistants this device is in to the memberships at home: joins the ones it isn't
     * in yet (a membership needs no invite again), and signs out of ones left elsewhere.
     */
    private suspend fun syncPlaces() {
        val home = mutableSession.value ?: return
        val memberships = try {
            home.client.memberships()
        } catch (error: NudgeException.Status) {
            // No federation at home: nobody joined anything from there.
            if (error.status.toInt() == 404) mutableMemberships.value = null
            return
        } catch (_: NudgeException) {
            return
        }
        mutableMemberships.value = memberships
        syncing.withLock {
            if (mutableSession.value !== home) return
            val (kept, gone) = mutablePlaces.value.partition { place ->
                memberships.memberships.any { place.account.isAt(it.server, it.assistant) }
            }
            val added = memberships.memberships
                .filter { membership -> kept.none { it.account.isAt(membership.server, membership.assistant) } }
                .mapNotNull { runCatching { joined(home, it.server, it.assistant) }.getOrNull() }
            mutablePlaces.value = kept + added
            savePlaces()
            gone.forEach { forget(it) }
        }
    }

    /** Signs in to an assistant with the home's assertion. */
    private suspend fun joined(home: Session, server: String, assistant: String): Session {
        val name = runCatching { listAssistants(server).firstOrNull { it.name == assistant }?.displayName }.getOrNull()
        val account = Account(server, assistant, name ?: assistant)
        val tokens = tokens(account)
        val client = NudgeClient(config(account), tokens)
        try {
            client.join(home.client.vouchFor(server, assistant))
        } catch (error: Exception) {
            client.close()
            throw error
        }
        return open(account, client)!!
    }

    /** Signs a session out on its server, as far as it can be reached, and drops what is kept of it. */
    private suspend fun forget(session: Session) {
        session.registeredDevice?.let { device -> runCatching { session.client.unregisterDevice(device) } }
        runCatching { session.client.signOut() }
        session.close()
        tokens(session.account).set(null)
        cacheFile(session.account).delete()
    }

    /**
     * Registers the FCM token with a server: directly when it sends to this app itself, else
     * through the relay this build knows, if the server sends through it too.
     */
    private suspend fun registerDevice(session: Session) {
        val token = deviceToken ?: return
        val platforms = session.pushPlatforms.value ?: return
        if (token == session.registeredToken) return
        try {
            if (platforms.fcm) {
                session.client.registerDevice(DevicePlatform.FCM, token, null)
                session.registeredDevice = token
            } else {
                val relay = BuildConfig.PUSH_RELAY
                if (relay.isEmpty() || platforms.relays.none { it.trimEnd('/') == relay }) return
                val handle = registerWithRelay(relay, DevicePlatform.FCM, token, null)
                session.client.registerRelayDevice(relay, handle, deviceKey.publicKey)
                session.registeredDevice = handle
            }
            session.registeredToken = token
        } catch (_: NudgeException) {
            // Tried again on the next start or token.
        }
    }

    private fun savedPlaces(): List<Account> = preferences.getStringSet(PLACES, emptySet()).orEmpty().mapNotNull { saved ->
        val parts = saved.split('\u0001')
        if (parts.size == 3) Account(parts[0], parts[1], parts[2]) else null
    }

    private fun savePlaces() {
        val saved = mutablePlaces.value.map { "${it.account.server}\u0001${it.account.assistant}\u0001${it.account.assistantName}" }
        preferences.edit().putStringSet(PLACES, saved.toSet()).apply()
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

    private companion object {
        const val PLACES = "places"
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
