package nudge.sample

import android.app.Application
import androidx.lifecycle.AndroidViewModel
import androidx.lifecycle.viewModelScope
import java.io.File
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import nudge.client.Observed
import nudge.client.ObservedRoom
import nudge.client.PreferencesTokens
import nudge.client.observeConnectionState
import nudge.client.observeHomeState
import nudge.client.observeRoomState
import nudge.ffi.ClientConfig
import nudge.ffi.ConnectionStatus
import nudge.ffi.HomeUpdate
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException

/** A signed-in client: the server it talks to and what it observes there. */
class Session(
    val client: NudgeClient,
    val connection: Observed<ConnectionStatus>,
    val home: Observed<HomeUpdate>,
) {
    fun close() {
        connection.close()
        home.close()
        client.disconnect()
        client.close()
    }
}

class NudgeViewModel(application: Application) : AndroidViewModel(application) {
    private val preferences = application.getSharedPreferences("nudge", 0)
    private val tokens = PreferencesTokens(preferences)
    private val cache = File(application.filesDir, "nudge.sqlite").path

    private val mutableSession = MutableStateFlow<Session?>(null)
    val session: StateFlow<Session?> = mutableSession.asStateFlow()

    private val mutableError = MutableStateFlow<String?>(null)
    val error: StateFlow<String?> = mutableError.asStateFlow()

    init {
        val server = preferences.getString("server", null)
        val assistant = preferences.getString("assistant", null)
        if (server != null && assistant != null && tokens.get() != null) {
            mutableSession.value = start(newClient(server, assistant))
        }
    }

    private fun newClient(server: String, assistant: String) = NudgeClient(
        ClientConfig(
            server = server,
            assistant = assistant,
            clientName = "nudge-android-sample",
            clientVersion = "0.0.0",
            platform = "android",
            cachePath = cache,
        ),
        tokens,
    )

    private fun start(client: NudgeClient): Session {
        client.connect()
        return Session(client, client.observeConnectionState(), client.observeHomeState())
    }

    /** Signs in with a pairing code, as typed or from a `nudge://pair` link. */
    fun pair(server: String, assistant: String, code: String) {
        mutableError.value = null
        viewModelScope.launch {
            val client = try {
                newClient(server.trim().trimEnd('/'), assistant.trim())
            } catch (e: NudgeException) {
                mutableError.value = e.message
                return@launch
            }
            try {
                client.pair(code)
            } catch (e: NudgeException) {
                client.close()
                mutableError.value = when (e) {
                    is NudgeException.Status -> if (e.status.toInt() == 401) "That code didn't work" else e.detail
                    is NudgeException.Network -> "No answer from $server"
                    else -> e.message
                }
                return@launch
            }
            preferences.edit().putString("server", server).putString("assistant", assistant).apply()
            mutableSession.value = start(client)
        }
    }

    fun signOut() {
        mutableSession.value?.close()
        mutableSession.value = null
        tokens.set(null)
    }

    fun room(id: String): ObservedRoom? = mutableSession.value?.client?.observeRoomState(id)

    fun send(room: String, text: String) = command { send(room, text, null) }

    fun resend(room: String, requestId: String) = command { resend(room, requestId) }

    fun dismiss(room: String, requestId: String) {
        mutableSession.value?.client?.dismiss(room, requestId)
    }

    fun abort(room: String) = command { abort(room) }

    fun decide(room: String, approval: String, approve: Boolean) =
        command { decide(room, approval, approve) }

    private fun command(run: suspend NudgeClient.() -> Unit) {
        val client = mutableSession.value?.client ?: return
        viewModelScope.launch {
            try {
                client.run()
            } catch (e: NudgeException) {
                // A refused message shows as failed in the room; other refusals show here.
                mutableError.value = e.message
            }
        }
    }

    fun clearError() {
        mutableError.value = null
    }

    override fun onCleared() {
        mutableSession.value?.close()
    }
}
