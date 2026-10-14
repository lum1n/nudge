// The bindings on this machine's JVM, against a Nudge server on a faux model
// (`packages/server/scripts/faux-server.ts`, which runs the built packages: `pnpm build` first).
// Skipped without node or the build.
package nudge.client

import java.io.File
import kotlinx.coroutines.flow.filterNotNull
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import nudge.ffi.AnswerStatus
import nudge.ffi.ClientConfig
import nudge.ffi.ConnectionStatus
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.Part
import nudge.ffi.PendingState
import nudge.ffi.Sent
import nudge.ffi.SyncStatus
import nudge.ffi.TimelineChange
import nudge.ffi.TimelineItem
import nudge.ffi.MarkerKind
import nudge.ffi.listAssistants
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertTrue
import org.junit.Assume.assumeTrue
import org.junit.Before
import org.junit.Test

class ClientTest {
    private lateinit var server: Process
    private lateinit var url: String
    private lateinit var ann: String
    private lateinit var bo: String
    private val clients = mutableListOf<NudgeClient>()

    @Before
    fun startServer() {
        val repository = File(System.getProperty("nudge.repository"))
        assumeTrue("no packages/server/dist", repository.resolve("packages/server/dist/index.js").exists())
        server = try {
            ProcessBuilder("node", "packages/server/scripts/faux-server.ts")
                .directory(repository)
                .redirectError(ProcessBuilder.Redirect.INHERIT)
                .start()
        } catch (_: java.io.IOException) {
            assumeTrue("no node", false)
            return
        }
        val started = server.inputStream.bufferedReader().readLine()
        url = Regex("\"url\":\"([^\"]+)\"").find(started)!!.groupValues[1]
        ann = Regex("\"ann\":\"([^\"]+)\"").find(started)!!.groupValues[1]
        bo = Regex("\"bo\":\"([^\"]+)\"").find(started)!!.groupValues[1]
    }

    @After
    fun stopServer() {
        clients.forEach { it.disconnect(); it.close() }
        if (::server.isInitialized) server.destroy()
    }

    private fun client(tokens: MemoryTokens): NudgeClient {
        val config = ClientConfig(url, "robin", "nudge-android-test", "0", "jvm", null)
        return NudgeClient(config, tokens).also { clients += it; it.connect() }
    }

    private suspend fun <T : Any> Observed<T>.awaitState(predicate: (T) -> Boolean): T =
        withTimeout(15_000) { state.filterNotNull().first(predicate) }

    @Test
    fun applyingChanges() {
        fun marker(id: String) = TimelineItem.Marker(id, MarkerKind.RESET)
        val timeline = emptyList<TimelineItem>().applying(
            listOf(
                TimelineChange.Reset(listOf(marker("a"), marker("c"))),
                TimelineChange.Insert(1u, marker("b")),
                TimelineChange.Append(listOf(marker("d"))),
                TimelineChange.Set(3u, marker("e")),
                TimelineChange.Remove(0u),
            ),
        )
        assertEquals(listOf("b", "c", "e"), timeline.map { (it as TimelineItem.Marker).id })
    }

    @Test
    fun pairingAndAStreamedAnswer() = runBlocking {
        assertEquals(listOf("robin"), listAssistants(url).map { it.name })
        val admin = client(MemoryTokens(ann))
        val me = admin.me()
        assertTrue(me.admin)

        val cy = admin.createPlayer("Cy")
        val code = admin.pairingCode(cy.id)
        val tokens = MemoryTokens()
        val paired = client(tokens)
        assertEquals(cy.id, paired.pair(code.code).player.id)
        assertNotNull(tokens.get())
        val open = paired.observeConnectionState().awaitState { it is ConnectionStatus.Open }
        assertEquals(cy.id, (open as ConnectionStatus.Open).player.id)

        val room = admin.observeRoomState("trip")
        val live = room.awaitState { it.status == SyncStatus.LIVE }
        assertEquals("Trip", live.room?.name)

        assertTrue(admin.send("trip", "Hello there", null) is Sent.Delivered)
        val texts = mutableListOf<String>()
        val done = withTimeout(15_000) {
            room.state.filterNotNull().first { state ->
                val answer = state.timeline.filterIsInstance<TimelineItem.Answer>().firstOrNull()
                    ?: return@first false
                texts += answer.parts.filterIsInstance<Part.Text>().joinToString("") { it.text }
                answer.status == AnswerStatus.DONE
            }
        }
        assertTrue(texts.last().startsWith("Hello! This answer arrives"))
        assertTrue("streamed in several states", texts.toSet().size > 2)
        val user = done.timeline.filterIsInstance<TimelineItem.User>().single()
        assertEquals("Hello there", user.text)
        assertTrue(done.pending.isEmpty())

        val fact = admin.remember("trip", "Bo likes trains")
        assertEquals("Bo likes trains", room.awaitState { it.memory.size == 1 }.memory[0].text)
        admin.forget("trip", fact.id)
        room.awaitState { it.memory.isEmpty() }
        room.close()

        val home = admin.observeHomeState().awaitState { it.view != null }
        assertTrue(home.view!!.rooms.any { it.room.id == "trip" })
    }

    @Test
    fun refusalsAndRevocation() = runBlocking {
        val admin = client(MemoryTokens(ann))
        val member = client(MemoryTokens(bo))
        try {
            member.createPlayer("Dee")
            error("not refused")
        } catch (e: NudgeException.Status) {
            assertEquals(403.toUShort(), e.status)
        }

        val nowhere = member.observeRoomState("nowhere")
        try {
            member.send("nowhere", "hi", null)
            error("not refused")
        } catch (e: NudgeException.Status) {
            assertEquals(404.toUShort(), e.status)
        }
        val failed = nowhere.awaitState { it.pending.isNotEmpty() }
        assertTrue(failed.pending[0].state is PendingState.Failed)

        val connection = member.observeConnectionState()
        val open = connection.awaitState { it is ConnectionStatus.Open } as ConnectionStatus.Open
        admin.revoke(open.clientId)
        val closed = connection.awaitState { it is ConnectionStatus.Closed && it.code != 1000.toUShort() }
        assertEquals(4401.toUShort(), (closed as ConnectionStatus.Closed).code)
    }
}
