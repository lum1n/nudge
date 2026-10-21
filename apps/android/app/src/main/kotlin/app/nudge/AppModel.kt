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
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import nudge.client.JoinLink
import nudge.client.Observed
import nudge.client.PairingLink
import nudge.client.PreferencesTokens
import nudge.client.observeConnectionState
import nudge.client.observeRoomListState
import nudge.client.saved
import nudge.client.settings
import nudge.ffi.Assistant
import nudge.ffi.AssistantFor
import nudge.ffi.ClientConfig
import nudge.ffi.ConnectionStatus
import nudge.ffi.DeviceKey
import nudge.ffi.DevicePlatform
import nudge.ffi.MeInfo
import nudge.ffi.MadeAssistant
import nudge.ffi.Membership
import nudge.ffi.Memberships
import nudge.ffi.NewAssistant
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.PushPayload
import nudge.ffi.PushPlatforms
import nudge.ffi.Reach
import nudge.ffi.RoomListUpdate
import nudge.ffi.SetupChoices
import nudge.ffi.listAssistants
import nudge.ffi.newDeviceKey
import nudge.ffi.reach
import nudge.ffi.registerWithRelay

/** An assistant the app is signed in to. */
/**
 * An assistant the app is signed in to. [standalone]: signed in as a person of its own there, not
 * joined from home: a standalone server, outside the person's cluster, which home never names.
 */
data class Account(
    val server: String,
    val assistant: String,
    val assistantName: String,
    val standalone: Boolean = false,
) {
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
    val roomList: Observed<RoomListUpdate>,
) {
    /** Who the player is there, once the server said. */
    val me = MutableStateFlow<MeInfo?>(null)
    /** Which native pushes the server sends; null until asked, or when it sends none. */
    val pushPlatforms = MutableStateFlow<PushPlatforms?>(null)
    internal var registeredToken: String? = null
    /** What the server knows the device by: the FCM token, or the relay's handle for it. */
    internal var registeredDevice: String? = null

    /** The server no longer takes this device's token here (4401). */
    val signedOut: Boolean
        get() = (connection.state.value as? ConnectionStatus.Closed)?.code?.toInt() == 4401

    internal fun close() {
        connection.close()
        roomList.close()
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

    private val mutableHomeFederation = MutableStateFlow<Boolean?>(null)
    /** Whether the home has federation: false once it said it hasn't, null until it said. */
    val homeFederation: StateFlow<Boolean?> = mutableHomeFederation.asStateFlow()

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

    /** The servers this device owns, and the exe.dev token it makes new ones with. */
    val servers = Servers(preferences)

    /** Speech to text for the composer, and the player's speech languages on this device. */
    val dictation = Dictation(context, preferences)

    /** Where the player is, told to home while the app is on screen, if they turned it on. */
    val location = LocationSharing(context, preferences, scope)

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

    /**
     * Sets a server up with what the wizard asked (ADR 11), and signs in as its owner. Signed out,
     * its new assistant becomes the person's home. Signed in at home, it is started from there:
     * home vouches for the person, so its first player is them and its owner their address. With
     * federation it is joined from home at once, landing on that player; without, it stays
     * standalone, and can join the cluster later ([joinCluster]).
     */
    suspend fun setUp(server: String, wizard: SetupChoices): SetUpServer {
        if (mutableSession.value != null && wizard.federation) homeProblem()?.let { throw ServerProblem(it) }
        var choices = wizard
        val home = mutableSession.value
        if (home != null && mutableMemberships.value?.address != null) {
            try {
                choices = choices.copy(homeAssertion = home.client.ownerAssertion(server.trimEnd('/')))
            } catch (error: NudgeException) {
                // A standalone server home can't vouch for becomes a home of its own instead.
                if (choices.federation) throw error
            }
        }
        val done = nudge.ffi.setUp(server, choices, "nudge-android", "android")
        servers.remember(server, done.serverToken)
        if (mutableSession.value != null && !choices.federation) {
            val account = Account(server, done.assistant, choices.displayName ?: done.assistant, standalone = true)
            tokens(account).set(done.token)
            syncing.withLock {
                open(account)?.let { mutablePlaces.value += it }
                savePlaces()
            }
            return SetUpServer.Standalone
        }
        if (mutableSession.value != null) {
            // The owner API invites and joins from here on; the setup player's token isn't needed.
            val setupAccount = Account(server, done.assistant, done.assistant)
            val setupTokens = PreferencesTokens(preferences, "setup:${setupAccount.key}")
            setupTokens.set(done.token)
            val setup = NudgeClient(config(setupAccount).copy(cachePath = null), setupTokens)
            runCatching { setup.signOut() }
            setupTokens.set(null)
            setup.close()
            joinFromHome(server, done.assistant)
            return SetUpServer.Joined
        }
        val account = Account(server, done.assistant, choices.displayName ?: done.assistant)
        tokens(account).set(done.token)
        preferences.edit()
            .putString("server", account.server)
            .putString("assistant", account.assistant)
            .putString("assistantName", account.assistantName)
            .apply()
        signedOutBecause.value = null
        start(account)
        return SetUpServer.Home
    }

    /**
     * Who can reach the home as other servers do: at its federation address once it has one,
     * else where this device reaches it. Null while signed out.
     */
    fun homeReach(): Reach? {
        val home = mutableSession.value ?: return null
        val address = mutableMemberships.value?.address
        val at = address?.indexOf('@') ?: -1
        val slash = address?.lastIndexOf('/') ?: -1
        if (address != null && at in 0 until slash) {
            val server = address.substring(at + 1, slash)
            return reach(if ("://" in server) server else "https://$server")
        }
        return reach(home.account.server)
    }

    /** Why the home can't join assistants on other servers yet, if it can't. */
    fun homeProblem(): ServerProblem.Kind? {
        if (mutableSession.value == null) return null
        if (homeReach() == Reach.PRIVATE) return ServerProblem.Kind.PRIVATE_HOME
        if (mutableHomeFederation.value == false) return ServerProblem.Kind.NO_FEDERATION
        return null
    }

    /**
     * Turns federation on at home, at the address this device reaches it, so the person can join
     * assistants elsewhere. Needs them to be an admin there.
     */
    suspend fun turnOnFederation() {
        val home = mutableSession.value ?: return
        setFederationAddress(home.client, home.account.server.trimEnd('/'))
        mutableMemberships.value = home.client.memberships()
        mutableHomeFederation.value = true
    }

    /**
     * Turns federation on for the assistant [client] is signed in to, at [server], the address
     * other servers know it by. Needs the player to be an admin there.
     */
    private suspend fun setFederationAddress(client: NudgeClient, server: String) {
        val setups = client.extensionSetups()
        val federation = setups.firstOrNull { it.from.endsWith("federation") }
            ?: throw ServerProblem(ServerProblem.Kind.NO_FEDERATION_EXTENSION)
        client.saveExtensionSetups(
            setups
                .filter { it.configured || it.from == federation.from }
                .map { setup ->
                    if (setup.from == federation.from) {
                        setup.saved(true, JsonObject(setup.settings + ("server" to JsonPrimitive(server))), setup.rooms)
                    } else {
                        setup.saved(setup.enabled, setup.settings, setup.rooms)
                    }
                },
        )
    }

    /**
     * Whether a standalone assistant was started from this person's home, so it can join their
     * cluster: its player there is them, by their address. Independent ones never can.
     */
    fun canJoinCluster(place: Session): Boolean {
        val address = mutableMemberships.value?.address ?: return false
        return place.account.standalone && place.me.value?.player?.address == address
    }

    /**
     * Joins a standalone assistant started from home to the person's cluster (ADR 11): turns its
     * federation on at the address this device reaches it by, and joins it from home, which lands
     * on the same player, so its rooms and history stay. From then on it is one of home's
     * memberships, on all their devices.
     */
    suspend fun joinCluster(place: Session) {
        val home = mutableSession.value ?: return
        if (!canJoinCluster(place)) return
        homeProblem()?.let { throw ServerProblem(it) }
        val server = place.account.server
        setFederationAddress(place.client, server.trimEnd('/'))
        val old = tokens(place.account).get()
        syncing.withLock {
            val joined = joined(home, server, place.account.assistant)
            mutablePlaces.value =
                if (mutablePlaces.value.any { it === place }) mutablePlaces.value.map { if (it === place) joined else it }
                else mutablePlaces.value + joined
            savePlaces()
        }
        place.close()
        // The standalone token is the same player's; the joined one replaced it.
        if (old != null) {
            val oldTokens = PreferencesTokens(preferences, "setup:${place.account.key}")
            oldTokens.set(old)
            val client = NudgeClient(config(place.account).copy(cachePath = null), oldTokens)
            runCatching { client.signOut() }
            oldTokens.set(null)
            client.close()
        }
        syncPlaces()
    }

    /** Whether this device is signed in to that assistant, as home or joined from it. */
    fun isSignedIn(server: String, assistant: String) = sessions().any { it.account.isAt(server, assistant) }

    /**
     * Joins an assistant on a server this device owns from home, as its owner: invites the home's
     * address, joins, and makes that guest an admin there; the server makes the person an owner by
     * their address, so deleting the assistant later leaves them its owner.
     */
    suspend fun joinFromHome(server: String, assistant: String) {
        if (mutableSession.value == null) return
        homeProblem()?.let { throw ServerProblem(it) }
        val address = mutableMemberships.value?.address ?: throw ServerProblem(ServerProblem.Kind.NO_FEDERATION)
        val owner = servers.client(server)
        // At the address this device knows the server by, which the link may write otherwise.
        owner.invite(assistant, address)
        join(JoinLink(server, assistant))
        val place = mutablePlaces.value.firstOrNull { it.account.isAt(server, assistant) }
            ?: throw ServerProblem(ServerProblem.Kind.NOT_JOINED)
        val guest = place.client.me().player.id
        owner.addOwner(assistant, guest, true)
        // An admin now: Settings shows its extensions and invites.
        place.me.value = runCatching { place.client.me() }.getOrNull() ?: place.me.value
        // On the list at home, for the person's other devices; the next sync puts it there otherwise.
        mutableSession.value?.let { home ->
            runCatching { home.client.addOwnedServer(server.trimEnd('/')) }
                .onSuccess { listed -> servers.setAtHome(listed.map { it.server }.toSet()) }
        }
    }

    /**
     * Makes an assistant on a server this device owns. One that is "for me" is joined from home
     * at once, so its rooms show beside the home's and the person is its first admin.
     */
    suspend fun createAssistant(server: String, new: NewAssistant): MadeAssistant {
        if (new.madeFor is AssistantFor.Me) homeProblem()?.let { throw ServerProblem(it) }
        val made = servers.client(server).createAssistant(new)
        made.joinLink?.let { JoinLink.parse(it) }?.let { join(it) }
        return made
    }

    /**
     * Removes a server made on exe.dev, with everything on it: leaves its assistants joined from
     * home, deletes the VM, and forgets it here.
     */
    suspend fun removeExeServer(server: String) {
        val exe = servers.exe() ?: throw ServerProblem(ServerProblem.Kind.NOT_ON_EXE)
        val vm = exeVmName(server) ?: throw ServerProblem(ServerProblem.Kind.NOT_ON_EXE)
        for (membership in mutableMemberships.value?.memberships.orEmpty()) {
            if (membership.server.trimEnd('/') == server.trimEnd('/')) runCatching { leave(membership) }
        }
        exe.delete(vm)
        removeServer(server)
    }

    /**
     * Takes a server off the person's list at home and signs this device out of it; their other
     * devices follow when they next look. They stay its owner, and nothing on the server changes.
     */
    suspend fun removeServer(server: String) {
        mutableSession.value?.let { home ->
            try {
                home.client.removeOwnedServer(server.trimEnd('/'))
            } catch (error: NudgeException.Status) {
                // Not on the list, or no federation at home: there is nothing to take off.
                if (error.status.toInt() != 404) throw error
            }
        }
        servers.forget(server)
    }

    /**
     * Matches the servers this device owns to the person's list at home (ADR 11): signs in to the
     * ones another device put there, with an assertion from home; puts there the ones only this
     * device knew, when their owner is the person at home; and forgets the ones taken off elsewhere.
     */
    private suspend fun syncServers(home: Session) {
        val address = mutableMemberships.value?.address ?: return
        val listed = try {
            home.client.ownedServers()
        } catch (_: NudgeException) {
            return
        }
        if (mutableSession.value !== home) return
        val atHome = listed.map { it.server.trimEnd('/') }.toMutableSet()
        val homeServer = home.account.server.trimEnd('/')
        for (server in servers.owned.value) {
            val key = server.trimEnd('/')
            if (key in atHome || key == homeServer) continue
            if (servers.wasAtHome(key)) {
                servers.forget(server)
                continue
            }
            val client = servers.client(server)
            val owner = runCatching { client.info().owner }.getOrNull() ?: continue
            // Set up before owners had addresses, this device may be signed in as the setup's
            // player, beside the owner its home vouches for.
            if (owner.address != address &&
                runCatching { client.owners() }.getOrNull()?.none { it.address == address } != false
            ) continue
            runCatching { home.client.addOwnedServer(key) }.onSuccess { atHome += key }
        }
        for (owned in listed) {
            val local = servers.owned.value.firstOrNull { it.trimEnd('/') == owned.server }
            if (local != null) {
                // Still signed in, unless its token was revoked, as with the player it was through.
                try {
                    servers.client(local).info()
                    continue
                } catch (error: NudgeException) {
                    if (error !is NudgeException.Status || error.status.toInt() != 401) continue
                }
            }
            val server = local ?: owned.server
            try {
                val assertion = home.client.ownerAssertion(owned.server)
                servers.client(server).signInFromHome(assertion)
                // The client kept the token; remember the server.
                servers.remember(server, serverToken(server) ?: continue)
            } catch (_: NudgeException) {
                // Unreachable for now, or no longer theirs: tried again next time.
            }
        }
        servers.setAtHome(atHome)
    }

    /** Signs in to the home's server as its owner, when the player is one; quietly not otherwise. */
    private suspend fun signInAsOwner(home: Session) {
        if (home.account.server in servers.owned.value) return
        val token = tokens(home.account).get() ?: return
        try {
            servers.client(home.account.server).signIn(home.account.assistant, token)
            // The client kept the token; remember the server.
            servers.remember(home.account.server, serverToken(home.account.server) ?: return)
        } catch (_: NudgeException) {
            // Not an owner, or an older server without the server API.
        }
    }

    private fun serverToken(server: String) =
        PreferencesTokens(preferences, "serverToken:${server.trimEnd('/')}").get()

    /** Forgets the tokens, the device's push registrations and the cached views, everywhere. */
    suspend fun signOut(because: String? = null) {
        val session = mutableSession.value ?: return
        // Cleared first: revoking the token closes the socket with 4401, which mustn't sign out
        // a second time.
        mutableSession.value = null
        location.setClient(null)
        val places = mutablePlaces.value
        mutablePlaces.value = emptyList()
        mutableMemberships.value = null
        mutableHomeFederation.value = null
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
        location.setForeground(foreground)
    }

    /** An FCM registration token, new or again: register it with every server once signed in. */
    fun onPushToken(token: String) {
        deviceToken = token
        scope.launch { sessions().forEach { registerDevice(it) } }
    }

    /** What a push through the relay says, opened with the device's key; null if it isn't for it. */
    fun openPush(sealed: String): PushPayload? = nudge.ffi.openPush(deviceKey.privateKey, sealed)

    /**
     * The session a push is for: by the `account` it carries, or, from a server that sends none, by
     * the assistant's name, which two servers may share.
     */
    private fun sessionForPush(account: String?, assistant: String?): Session? {
        val sessions = sessions()
        if (account != null) sessions.firstOrNull { it.client.pushAccount() == account }?.let { return it }
        return sessions.firstOrNull { assistant == null || it.account.assistant == assistant }
    }

    /** A tapped notification: open its room, at the assistant it came from. */
    fun open(account: String?, assistant: String?, room: String?) {
        if (room == null) return
        val session = sessionForPush(account, assistant) ?: return
        requestedRoom.value = RoomRef(session.account.key, room)
    }

    /** Whether the room a push is about is on screen. */
    fun showing(account: String?, assistant: String?, room: String): Boolean {
        val shown = selectedRoom.value ?: return false
        return shown.room == room && sessionForPush(account, assistant)?.account?.key == shown.account
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
    /** Signs this device out of a standalone assistant; nothing at home changes. */
    suspend fun signOutOf(place: Session) {
        syncing.withLock {
            mutablePlaces.value = mutablePlaces.value.filter { it !== place }
            savePlaces()
        }
        forget(place)
    }

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
        // Only home learns where the player is, never the assistants they joined.
        location.setClient(session.client)
        // The assistants joined, as this device last knew them, until home says.
        mutablePlaces.value = savedPlaces().mapNotNull { place ->
            if (tokens(place).get() == null) null else open(place)?.also { watch(it) }
        }
        if (BuildConfig.FIREBASE) {
            // The token arrives in PushService.onRegistered.
            FirebaseMessaging.getInstance().register()
        }
        scope.launch { syncPlaces() }
        scope.launch { signInAsOwner(session) }
    }

    /** A client of `account`, connected, its player and pushes asked for. */
    private fun open(account: Account, made: NudgeClient? = null): Session? {
        val client = made ?: runCatching { NudgeClient(config(account), tokens(account)) }.getOrNull() ?: return null
        client.connect()
        val session = Session(account, client, client.observeConnectionState(), client.observeRoomListState())
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
        // Only these may have been left elsewhere: one joined while home answers isn't in its answer.
        val before = mutablePlaces.value
        val memberships = try {
            home.client.memberships()
        } catch (error: NudgeException.Status) {
            // No federation at home: nobody joined anything from there.
            if (error.status.toInt() == 404) {
                mutableMemberships.value = null
                mutableHomeFederation.value = false
            }
            return
        } catch (_: NudgeException) {
            return
        }
        mutableMemberships.value = memberships
        mutableHomeFederation.value = true
        syncing.withLock {
            if (mutableSession.value !== home) return
            val (gone, kept) = mutablePlaces.value.partition { place ->
                !place.account.standalone && before.any { it === place } &&
                    memberships.memberships.none { place.account.isAt(it.server, it.assistant) }
            }
            val added = memberships.memberships
                .filter { membership -> kept.none { it.account.isAt(membership.server, membership.assistant) } }
                .mapNotNull { runCatching { joined(home, it.server, it.assistant) }.getOrNull() }
            mutablePlaces.value = kept + added
            savePlaces()
            gone.forEach { forget(it) }
        }
        rejoinSignedOut()
        syncServers(home)
    }

    /**
     * Joins again, with a fresh assertion from home, the assistants whose token stopped working
     * there: home still has their memberships, so they need no invite. One left elsewhere stays
     * signed out.
     */
    suspend fun rejoinSignedOut() {
        val home = mutableSession.value ?: return
        syncing.withLock {
            for (place in mutablePlaces.value.filter { it.signedOut && !it.account.standalone }) {
                val fresh = runCatching { joined(home, place.account.server, place.account.assistant) }.getOrNull() ?: continue
                if (mutableSession.value !== home || mutablePlaces.value.none { it === place }) {
                    fresh.close()
                    continue
                }
                mutablePlaces.value = mutablePlaces.value.map { if (it === place) fresh else it }
                // Its token is gone already, so there is nothing to sign out.
                place.close()
            }
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
        return open(account, client)!!.also { watch(it) }
    }

    /** A joined assistant whose token stops working is joined again from home. */
    private fun watch(place: Session) {
        scope.launch {
            place.connection.state.collect { status ->
                if (status is ConnectionStatus.Closed && status.code.toInt() == 4401) rejoinSignedOut()
            }
        }
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
        when (parts.size) {
            3 -> Account(parts[0], parts[1], parts[2])
            4 -> Account(parts[0], parts[1], parts[2], standalone = parts[3] == STANDALONE)
            else -> null
        }
    }

    private fun savePlaces() {
        val saved = mutablePlaces.value.map {
            val kind = if (it.account.standalone) "\u0001$STANDALONE" else ""
            "${it.account.server}\u0001${it.account.assistant}\u0001${it.account.assistantName}$kind"
        }
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
        const val STANDALONE = "standalone"
    }
}

/** How setting a server up ended for this device. */
sealed interface SetUpServer {
    /** Its assistant is the person's home now. */
    data object Home : SetUpServer
    /** Joined from home. */
    data object Joined : SetUpServer
    /** Outside the person's cluster: signed in to as a person of its own. */
    data object Standalone : SetUpServer
}

/** Why the home can't join an assistant on a server this device owns, or more on servers. */
class ServerProblem(val kind: Kind) : Exception(kind.text) {
    enum class Kind(val text: String) {
        NO_FEDERATION("Your home has no federation yet, so it can't join assistants on other servers."),
        NO_FEDERATION_EXTENSION("Your home's server has no federation extension to turn on. Update it first."),
        PRIVATE_HOME(
            "This device reaches your home at a local address, which other servers can't reach. " +
                "Sign in to your home at its public address, or hold a Wired network at home and use its address: " +
                "under Settings → Servers, open your home's server.",
        ),
        NOT_JOINED("Joining the assistant from home didn't work."),
        NOT_ON_EXE("This server isn't one this device made on exe.dev."),
    }
}

/** The exe.dev VM a server runs on, from its address: `robin` for `https://robin.exe.xyz`. */
fun exeVmName(server: String): String? {
    val host = runCatching { java.net.URI(server).host }.getOrNull() ?: return null
    if (!host.endsWith(".exe.xyz")) return null
    val name = host.removeSuffix(".exe.xyz")
    return if (name.isEmpty() || '.' in name) null else name
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
