from __future__ import annotations

import asyncio
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
        assert [a.name for a in assistants] == ["robin"]

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
