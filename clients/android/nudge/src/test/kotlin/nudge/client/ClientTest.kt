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
import nudge.ffi.ApprovalStatus
import nudge.ffi.ClientConfig
import nudge.ffi.ConnectionStatus
import nudge.ffi.NudgeClient
import nudge.ffi.NudgeException
import nudge.ffi.PanelStatus
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
import org.junit.Assert.assertFalse
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
    fun approvalsAndNudges() = runBlocking {
        val admin = client(MemoryTokens(ann))
        val member = client(MemoryTokens(bo))
        val room = member.observeRoomState("trip")
        room.awaitState { it.status == SyncStatus.LIVE }

        // The model's `pay` waits for someone in the room to approve.
        admin.send("trip", "Please pay the bill", null)
        val approval = room.awaitState { state ->
            state.approvals.any { it.status == ApprovalStatus.PENDING }
        }.approvals[0]
        assertEquals("Pay 10 kr", approval.summary)
        assertEquals("bo", member.decide("trip", approval.id, true).decidedBy?.id)
        val done = room.awaitState { it.approvals[0].status == ApprovalStatus.DONE }
        assertEquals("Paid 10 kr.", done.approvals[0].result)
        try {
            admin.decide("trip", approval.id, false)
            error("not refused")
        } catch (e: NudgeException.Status) {
            assertEquals(409.toUShort(), e.status)
        }

        // The model's `schedule_nudge` shows in the room and on the home view.
        admin.send("trip", "Remind me to water the plants", null)
        val scheduled = room.awaitState { it.nudges.size == 1 }.nudges[0]
        assertEquals("Water the plants", scheduled.message)
        val home = admin.observeHomeState().awaitState { it.view?.nudges?.size == 1 }
        assertEquals("trip", home.view!!.nudges[0].roomId)
        member.cancelNudge(scheduled.id)
        room.awaitState { it.nudges.isEmpty() }
        try {
            member.cancelNudge(scheduled.id)
            error("not refused")
        } catch (e: NudgeException.Status) {
            assertEquals(404.toUShort(), e.status)
        }
        room.close()
    }

    @Test
    fun ownMemoryAndRoomExtensions() = runBlocking {
        val member = client(MemoryTokens(bo))
        val fact = member.rememberForMe("Likes coffee")
        assertEquals("bo", fact.by?.id)
        val memory = member.myMemory()
        assertEquals(listOf(fact.id), memory.facts.map { it.id })
        assertFalse(memory.shared)
        assertTrue(member.shareMyMemory(true).shared)
        member.shareMyMemory(false)
        member.forgetForMe(fact.id)
        assertTrue(member.myMemory().facts.isEmpty())

        val payer = member.roomExtensions("trip").first { it.name == "payer" }
        assertTrue(payer.enabled && payer.byDefault)
        val off = member.setRoomExtension("trip", "payer", false)
        assertFalse(off.enabled)
        assertTrue(off.byDefault)
        assertTrue(member.setRoomExtension("trip", "payer", null).enabled)
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

    @Test
    fun listsPanelAndUsage() = runBlocking {
        val ann = client(MemoryTokens(this@ClientTest.ann))
        assertEquals(7, ann.usage().month.length)
        val lists = ann.observeLists("trip")
        suspend fun until(predicate: (ListsState) -> Boolean) =
            withTimeout(15_000) { lists.state.first(predicate) }
        until { it.lists == emptyList<NudgeList>() }
        lists.add("Milk", "Shopping")
        val shown = until { it.lists?.firstOrNull()?.items?.size == 1 }
        val item = shown.lists!!.first().items.first()
        assertEquals("shopping", shown.lists!!.first().name)
        assertEquals("Milk", item.text)
        lists.toggle(item, "shopping")
        until { it.lists?.firstOrNull()?.items?.firstOrNull()?.done == true }
        lists.remove(item, "nope")
        until { it.error != null }
        lists.close()

        val nowhere = ann.observeLists("nowhere")
        val closed = withTimeout(15_000) { nowhere.state.first { it.status is PanelStatus.Closed } }
        assertEquals(4404.toUShort(), (closed.status as PanelStatus.Closed).code)
        nowhere.close()
    }

    @Test
    fun documentsPanel() = runBlocking {
        val bo = client(MemoryTokens(this@ClientTest.bo))
        val documents = bo.observeDocuments("trip")
        suspend fun until(predicate: (DocumentsState) -> Boolean) =
            withTimeout(15_000) { documents.state.first(predicate) }
        until { it.documents == emptyList<DocumentInfo>() }
        val receipt = "Receipt: one bicycle, 4000 kr".toByteArray()
        val id = documents.upload("receipt.txt", "text/plain", receipt)
        val shown = until { it.documents?.size == 1 }.documents!!.single()
        assertEquals(id, shown.id)
        assertEquals("receipt.txt", shown.name)
        assertEquals("Bo", shown.addedBy)
        assertEquals(receipt.size.toLong(), shown.size)
        val file = documents.download(shown)
        assertEquals("receipt.txt", file.name)
        assertEquals(String(receipt), String(file.bytes))
        try {
            documents.upload("again.txt", "text/plain", receipt)
            error("not refused")
        } catch (refused: PanelRefusal) {
            assertTrue(refused.message!!.contains("here already"))
        }
        documents.remove(shown)
        until { it.documents?.isEmpty() == true }
        documents.close()
    }

    @Test
    fun connectorsPanel() = runBlocking {
        val bo = client(MemoryTokens(this@ClientTest.bo))
        val room = bo.observeRoomState("trip")
        room.awaitState { it.status == SyncStatus.LIVE }
        // The model asks to add "Weather"; it needs an approval.
        bo.send("trip", "Please add a connector for the weather", null)
        val approval = room.awaitState { state -> state.approvals.any { it.status == ApprovalStatus.PENDING } }.approvals[0]
        bo.decide("trip", approval.id, true)
        room.close()

        val connectors = bo.observeConnectors("trip")
        suspend fun until(predicate: (ConnectorsState) -> Boolean) =
            withTimeout(15_000) { connectors.state.first(predicate) }
        val weather = until { it.connectors?.size == 1 }.connectors!!.single()
        assertEquals("Weather", weather.name)
        assertEquals("header", weather.auth?.placement)
        assertFalse(weather.hasKey)
        assertFalse(until { it.connectors != null }.admin)
        connectors.setKey(weather, "secret-key")
        until { it.connectors?.single()?.hasKey == true }
        connectors.allowPrivateNetwork(weather, true)
        until { it.connectors?.single()?.allowPrivateNetwork == true }
        connectors.setReadPaths(weather, listOf("POST /graphql"))
        until { it.connectors?.single()?.readPaths == listOf("POST /graphql") }
        connectors.setReadPaths(weather, listOf("GET /x"))
        until { it.error != null }
        connectors.clearKey(weather)
        until { it.connectors?.single()?.hasKey == false && it.error == null }
        connectors.remove(weather)
        until { it.connectors?.isEmpty() == true }
        connectors.close()
    }

    @Test
    fun pairingLinks() {
        assertEquals(
            PairingLink("https://nudge.example/x", "robin", "7K3Q-M9XD"),
            PairingLink.parse("nudge://pair?server=https%3A%2F%2Fnudge.example%2Fx&assistant=robin&code=7K3Q-M9XD"),
        )
        for (bad in listOf(
            "nudge://pair?server=ftp%3A%2F%2Fx&assistant=robin&code=1",
            "nudge://pair?server=https%3A%2F%2Fx&code=1",
            "nudge://other?server=https%3A%2F%2Fx&assistant=robin&code=1",
            "https://pair?server=https%3A%2F%2Fx&assistant=robin&code=1",
            "not a link",
        )) {
            assertEquals(bad, null, PairingLink.parse(bad))
        }
    }
}
