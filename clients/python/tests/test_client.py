from __future__ import annotations

import asyncio
import json
import os
import socket
import stat
import subprocess
import sys
import textwrap
from pathlib import Path

import nudge
import pytest
from nudge import (
    AnswerStatus,
    ApprovalStatus,
    Client,
    FileTokens,
    MemoryTokens,
    NudgeError,
    PendingState,
    RoomState,
    SyncStatus,
    TimelineChange,
    TimelineItem,
)

TIMEOUT = 15


def run(test):
    return asyncio.run(asyncio.wait_for(test, 60))


def answers(state: RoomState) -> list[TimelineItem]:
    return [item for item in state.timeline if item.is_answer()]


def text(item: TimelineItem) -> str:
    return "".join(part.text for part in item.parts if part.is_text())


def test_apply_changes() -> None:
    def marker(id: str) -> TimelineItem:
        return TimelineItem.MARKER(id=id, kind=nudge.MarkerKind.RESET)

    timeline = nudge.apply_changes(
        (),
        [
            TimelineChange.RESET(items=[marker("a"), marker("c")]),
            TimelineChange.INSERT(index=1, item=marker("b")),
            TimelineChange.APPEND(items=[marker("d")]),
            TimelineChange.SET(index=3, item=marker("e")),
            TimelineChange.REMOVE(index=0),
        ],
    )
    assert [item.id for item in timeline] == ["b", "c", "e"]


def test_file_tokens(tmp_path: Path) -> None:
    tokens = FileTokens(tmp_path / "dir" / "token")
    assert tokens.get() is None
    tokens.set("secret")
    assert tokens.get() == "secret"
    assert stat.S_IMODE(os.stat(tokens.path).st_mode) == 0o600
    tokens.set(None)
    assert not tokens.path.exists()


def test_pairing_and_a_streamed_answer(server, tmp_path: Path) -> None:
    async def test() -> None:
        assistants = await nudge.list_assistants(server.url)
        assert [a.name for a in assistants] == ["robin", "team"]

        async with Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann:
            me = await ann.me()
            assert me.admin and me.player.display_name == "Ann"
            cy = await ann.create_player("Cy")
            code = await ann.pairing_code(cy.id)

            tokens = FileTokens(tmp_path / "token")
            async with Client(server.url, server.assistant, tokens) as client:
                paired = await client.pair(code.code)
                assert paired.player.id == cy.id
                assert tokens.get() is not None
                assert (await client.me()).player.display_name == "Cy"
                status = await client.connection().wait_for(lambda s: s.is_open(), TIMEOUT)
                assert status.player.id == cy.id

            async with ann.room("trip") as room:
                state = await room.wait_for(lambda s: s.status == SyncStatus.LIVE, TIMEOUT)
                assert state.room.name == "Trip"
                assert {p.display_name for p in state.room.members} == {"Ann", "Bo"}

                sent = await ann.send("trip", "Hello there")
                assert sent.is_delivered()

                # The answer streams: the same item grows over several states.
                seen: list[str] = []
                async for state in room:
                    if answer := next(iter(answers(state)), None):
                        seen.append(text(answer))
                        if answer.status == AnswerStatus.DONE:
                            break
                assert seen[-1].startswith("Hello! This answer arrives")
                assert len(set(seen)) > 2

                user = next(item for item in state.timeline if item.is_user())
                assert user.text == "Hello there" and user.author.display_name == "Ann"
                assert state.pending == ()
                assert not state.live.running

                # Commands show up in the view.
                fact = await ann.remember("trip", "Bo likes trains")
                state = await room.wait_for(lambda s: len(s.memory) == 1, TIMEOUT)
                assert state.memory[0].text == "Bo likes trains"
                await ann.forget("trip", fact.id)
                await room.wait_for(lambda s: not s.memory, TIMEOUT)

            home = await ann.home().wait_for(lambda u: u.view is not None, TIMEOUT)
            assert "trip" in [r.room.id for r in home.view.rooms]

    run(test())


def test_approvals_and_nudges(server) -> None:
    async def test() -> None:
        async with (
            Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann,
            Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo,
        ):
            async with bo.room("trip") as room:
                await room.wait_for(lambda s: s.status == SyncStatus.LIVE, TIMEOUT)

                # The model's `pay` waits for someone in the room to approve.
                await ann.send("trip", "Please pay the bill")
                state = await room.wait_for(
                    lambda s: any(a.status == ApprovalStatus.PENDING for a in s.approvals), TIMEOUT
                )
                approval = state.approvals[0]
                assert approval.summary == "Pay 10 kr"
                decided = await bo.decide("trip", approval.id, True)
                assert decided.decided_by is not None and decided.decided_by.id == "bo"
                state = await room.wait_for(
                    lambda s: s.approvals[0].status == ApprovalStatus.DONE, TIMEOUT
                )
                assert state.approvals[0].result == "Paid 10 kr."
                with pytest.raises(NudgeError.Status) as refused:
                    await ann.decide("trip", approval.id, False)
                assert refused.value.status == 409

                # The model's `schedule_nudge` shows in the room and on the home view.
                await ann.send("trip", "Remind me to water the plants")
                state = await room.wait_for(lambda s: len(s.nudges) == 1, TIMEOUT)
                scheduled = state.nudges[0]
                assert scheduled.message == "Water the plants"
                home = await ann.home().wait_for(
                    lambda u: u.view is not None and len(u.view.nudges) == 1, TIMEOUT
                )
                assert home.view.nudges[0].room_id == "trip"
                await bo.cancel_nudge(scheduled.id)
                await room.wait_for(lambda s: not s.nudges, TIMEOUT)
                with pytest.raises(NudgeError.Status) as refused:
                    await bo.cancel_nudge(scheduled.id)
                assert refused.value.status == 404

    run(test())


def test_private_messages_and_values(server) -> None:
    async def test() -> None:
        async with (
            Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann,
            Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo,
        ):
            async with bo.room("trip") as room:
                await room.wait_for(lambda s: s.status == SyncStatus.LIVE, TIMEOUT)
                await ann.send("trip", "My door code is 4455", private=True)
                state = await room.wait_for(lambda s: len(answers(s)) == 1, TIMEOUT)
                first = state.timeline[0]
                assert first.is_user() and first.text == ""
                assert first.private_to is not None and first.private_to.id == "ann"

                placeholder = await ann.protect("Storgata 5", private=True)
                assert [v.value for v in await ann.private_values()] == ["Storgata 5"]
                assert await bo.private_values() == []
                await ann.send("trip", "Meet at Storgata 5")
                await room.wait_for(
                    lambda s: any(
                        i.is_user() and i.text == f"Meet at {placeholder}" for i in s.timeline
                    ),
                    TIMEOUT,
                )
                with pytest.raises(NudgeError.Status) as refused:
                    await bo.forget_value(placeholder)
                assert refused.value.status == 403
                await ann.forget_value(placeholder)
                assert await ann.private_values() == []

    run(test())


def test_own_memory_and_room_extensions(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo:
            fact = await bo.remember_for_me("Likes coffee")
            assert fact.by is not None and fact.by.id == "bo"
            memory = await bo.my_memory()
            assert [f.id for f in memory.facts] == [fact.id] and not memory.shared
            assert (await bo.share_my_memory(True)).shared
            assert not (await bo.share_my_memory(False)).shared
            await bo.forget_for_me(fact.id)
            assert not (await bo.my_memory()).facts

            payer = next(e for e in await bo.room_extensions("trip") if e.name == "payer")
            assert payer.enabled and payer.by_default
            off = await bo.set_room_extension("trip", "payer", False)
            assert not off.enabled and off.by_default
            assert (await bo.set_room_extension("trip", "payer", None)).enabled

    run(test())


def test_renames_a_room(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo:
            renamed = await bo.rename_room("trip", "Trip to Bergen")
            assert (renamed.id, renamed.name) == ("trip", "Trip to Bergen")
            await bo.home().wait_for(
                lambda u: (
                    u.view is not None
                    and any(r.room.name == "Trip to Bergen" for r in u.view.rooms)
                ),
                TIMEOUT,
            )
            with pytest.raises(NudgeError.Status) as refused:
                await bo.rename_room("trip", "")
            assert refused.value.status == 400
            with pytest.raises(NudgeError.Status) as refused:
                await bo.rename_room("lobby", "Hall")
            assert refused.value.status == 403

    run(test())


def test_refusals(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo:
            with pytest.raises(NudgeError.Status) as refused:
                await bo.create_player("Dee")
            assert refused.value.status == 403

            room = bo.room("nowhere")
            with pytest.raises(NudgeError.Status) as refused:
                await bo.send("nowhere", "hi")
            assert refused.value.status == 404
            state = await room.wait_for(lambda s: bool(s.pending), TIMEOUT)
            assert isinstance(state.pending[0].state, PendingState.FAILED)
            bo.dismiss("nowhere", state.pending[0].request_id)
            await room.wait_for(lambda s: not s.pending, TIMEOUT)

        async with Client(server.url, server.assistant, MemoryTokens("wrong")) as nobody:
            # Closed (1000) before it opens; then refused.
            status = await nobody.connection().wait_for(
                lambda s: s.is_closed() and s.code != 1000, TIMEOUT
            )
            assert status.code == 4401

    run(test())


def test_revocation_closes_the_socket(server) -> None:
    async def test() -> None:
        async with (
            Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann,
            Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo,
        ):
            connection = bo.connection()
            open_ = await connection.wait_for(lambda s: s.is_open(), TIMEOUT)
            await ann.revoke(open_.client_id)
            closed = await connection.wait_for(lambda s: s.is_closed(), TIMEOUT)
            assert closed.code == 4401

    run(test())


def test_outbox_survives_a_restart(server, tmp_path: Path) -> None:
    cache = tmp_path / "cache.sqlite"
    with socket.socket() as unused:
        unused.bind(("127.0.0.1", 0))
        offline = f"http://127.0.0.1:{unused.getsockname()[1]}"

    async def test() -> None:
        async with Client(offline, server.assistant, MemoryTokens(server.ann), cache=cache) as c:
            sent = await c.send("trip", "Sent while offline")
            assert sent.is_queued()

        async with Client(server.url, server.assistant, MemoryTokens(server.ann), cache=cache) as c:
            await c.room("trip").wait_for(
                lambda s: any(i.is_user() and i.text == "Sent while offline" for i in s.timeline),
                TIMEOUT,
            )

    run(test())


def test_exit_with_a_watch_open(server) -> None:
    # A listener still subscribed at exit used to crash the interpreter.
    script = textwrap.dedent(
        f"""
        import asyncio, nudge

        async def main():
            client = nudge.Client({server.url!r}, "robin", nudge.MemoryTokens({server.ann!r}))
            client.open()
            room = client.room("trip")
            await room.wait_for(lambda s: s.status == nudge.SyncStatus.LIVE, 15)
            await client.send("trip", "bye")

        asyncio.run(main())
        """
    )
    done = subprocess.run([sys.executable, "-c", script], timeout=60)
    assert done.returncode == 0


def test_a_panel_usage_and_the_model_view(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann:
            usage = await ann.usage()
            assert len(usage.month) == 7 and usage.total >= 0
            messages = await ann.model_view("trip")
            assert all(m.role != nudge.ModelRole.USER for m in messages)

            async with ann.panel("trip", "lists") as lists:
                assert await lists.wait_for(lambda f: f["type"] == "lists", TIMEOUT) == {
                    "type": "lists",
                    "lists": [],
                }
                assert lists.status == nudge.PanelStatus.OPEN()
                lists.send({"type": "add", "list": "Shopping", "text": "Milk", "ref": "r1"})
                assert await lists.wait_for(lambda f: f.get("ref") == "r1", TIMEOUT) == {
                    "type": "ok",
                    "ref": "r1",
                }
                shown = await lists.wait_for(lambda f: f["type"] == "lists", TIMEOUT)
                assert shown["lists"][0]["name"] == "shopping"
                assert shown["lists"][0]["items"][0]["text"] == "Milk"

            nowhere = ann.panel("nowhere", "lists")
            closed = await nowhere.statuses.wait_for(lambda s: s.is_closed(), TIMEOUT)
            assert closed.code == 4404
            nowhere.close()

    run(test())


def test_devices_and_signing_out(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann:
            cy = await ann.create_player("Cy")
            code = await ann.pairing_code(cy.id)

        tokens = MemoryTokens()
        async with Client(server.url, server.assistant, tokens) as cy:
            await cy.pair(code.code)
            # The faux server sends no pushes.
            with pytest.raises(NudgeError.Status) as refused:
                await cy.push_platforms()
            assert refused.value.status == 404
            with pytest.raises(NudgeError.Status) as refused:
                await cy.register_device(nudge.DevicePlatform.FCM, "token")
            assert refused.value.status == 404
            with pytest.raises(NudgeError.Status) as refused:
                await cy.unregister_device("token")
            assert refused.value.status == 404

            connection = cy.connection()
            await connection.wait_for(lambda s: s.is_open(), TIMEOUT)
            await cy.sign_out()
            closed = await connection.wait_for(lambda s: s.is_closed(), TIMEOUT)
            assert closed.code == 4401
            with pytest.raises(NudgeError.Status) as refused:
                await cy.me()
            assert refused.value.status == 401

    run(test())


def test_extension_settings(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.bo)) as bo:
            with pytest.raises(NudgeError.Status) as refused:
                await bo.extension_setups()
            assert refused.value.status == 403

        async with Client(server.url, server.assistant, MemoryTokens(server.ann)) as ann:
            setups = await ann.extension_setups()
            documents = next(s for s in setups if s.name == "documents")
            assert documents.configured and documents.enabled
            schema = json.loads(documents.schema_json)
            assert list(schema["properties"]) == ["maxMegabytes", "maxPerRoom"]
            assert not next(s for s in setups if s.name == "mail").configured

            def saved(settings: dict) -> list[nudge.SavedExtensionSetup]:
                return [
                    nudge.SavedExtensionSetup(
                        _from=s._from,
                        enabled=s.enabled,
                        settings_json=json.dumps(settings) if s is documents else s.settings_json,
                        rooms=s.rooms,
                    )
                    for s in setups
                    if s.configured
                ]

            after = await ann.save_extension_setups(saved({"maxMegabytes": 5}))
            documents_after = next(s for s in after if s.name == "documents")
            assert json.loads(documents_after.settings_json) == {"maxMegabytes": 5}
            with pytest.raises(NudgeError.Status) as refused:
                await ann.save_extension_setups(saved({"maxMegabytes": "lots"}))
            assert refused.value.status == 400

    run(test())


def test_profile_and_joining_another_assistant(server) -> None:
    async def test() -> None:
        async with Client(server.url, server.assistant, MemoryTokens(server.ann)) as home:
            profile = await home.update_profile(
                nudge.ProfileUpdate(
                    time_zone="Europe/Oslo",
                    language="nb",
                    notifications=nudge.Notifications(answers=True, approvals=False),
                )
            )
            assert (profile.display_name, profile.time_zone, profile.language) == (
                "Ann",
                "Europe/Oslo",
                "nb",
            )
            assert not profile.notifications.approvals
            cleared = await home.update_profile(nudge.ProfileUpdate(language=""))
            assert cleared.language is None and cleared.time_zone == "Europe/Oslo"
            assert json.loads(cleared.extensions_json) == {}
            with pytest.raises(NudgeError.Status) as refused:
                await home.update_profile(nudge.ProfileUpdate(time_zone="Mars/Olympus"))
            assert refused.value.status == 400

            address = f"ann@{server.url}/robin"
            async with Client(server.url, "team", MemoryTokens(server.dee)) as dee:
                assert [invite.address for invite in await dee.invites()] == [address]
                tokens = MemoryTokens()
                async with Client(server.url, "team", tokens) as there:
                    joined = await there.join_from(home)
                    assert joined.player.address == address
                    assert tokens.get() is not None
                    assert (await there.me()).player.display_name == "Ann"
                assert await dee.invites() == []

            [membership] = await home.memberships()
            assert (membership.assistant, membership.carry_memory) == ("team", False)
            carried = await home.carry_memory(server.url, "team", True)
            assert carried.carry_memory
            await home.leave(server.url, "team")
            assert await home.memberships() == []

    run(test())
