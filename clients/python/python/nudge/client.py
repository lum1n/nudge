"""An asyncio face on the generated bindings: views arrive as `Watch`es to iterate, the room's
timeline comes whole rather than as changes, and listeners are cancelled before the interpreter
shuts down (a library thread calling into a finalizing interpreter crashes it)."""

from __future__ import annotations

import asyncio
import atexit
import os
import weakref
from collections.abc import AsyncIterator, Callable, Sequence
from dataclasses import dataclass
from importlib import metadata
from typing import Generic, TypeVar

from nudge import _ffi
from nudge._ffi import (
    Approval,
    ConnectionStatus,
    Fact,
    GoneReason,
    HomeUpdate,
    Live,
    MeInfo,
    Paired,
    PairingCode,
    PendingMessage,
    Player,
    QueuedMessage,
    Room,
    RoomNudge,
    RoomUpdate,
    Sent,
    SyncStatus,
    TimelineChange,
    TimelineItem,
    TokenInfo,
    TokenStore,
    WhenBusy,
)
from nudge.tokens import MemoryTokens

__all__ = ["Client", "RoomState", "RoomWatch", "Watch", "apply_changes"]

try:
    VERSION = metadata.version("nudge-client")
except metadata.PackageNotFoundError:
    VERSION = "0.0.0"

T = TypeVar("T")
S = TypeVar("S")


@dataclass(frozen=True)
class RoomState:
    """A room as its `RoomWatch` shows it: the view, earlier items and this client's pending
    messages. `room` and `live` are None until the first view (cached or from the server)."""

    status: SyncStatus
    reason: GoneReason | None
    error: str | None
    room: Room | None
    live: Live | None
    queue: Sequence[QueuedMessage]
    approvals: Sequence[Approval]
    memory: Sequence[Fact]
    nudges: Sequence[RoomNudge]
    # Earlier items, then the view's, oldest first.
    timeline: Sequence[TimelineItem]
    can_load_earlier: bool
    loading_earlier: bool
    earlier_error: str | None
    # Messages this client sent that the timeline doesn't show yet, oldest first.
    pending: Sequence[PendingMessage]


def apply_changes(
    timeline: Sequence[TimelineItem], changes: Sequence[TimelineChange]
) -> tuple[TimelineItem, ...]:
    """The timeline after `changes`, applied in order."""
    items = list(timeline)
    for change in changes:
        if change.is_reset():
            items = list(change.items)
        elif change.is_append():
            items.extend(change.items)
        elif change.is_insert():
            items.insert(change.index, change.item)
        elif change.is_set():
            items[change.index] = change.item
        elif change.is_remove():
            del items[change.index]
    return tuple(items)


# Watches whose listener may still be called, cancelled at exit.
_open: weakref.WeakSet[Watch] = weakref.WeakSet()


@atexit.register
def _cancel_all() -> None:
    for watch in list(_open):
        watch.close()


class Watch(Generic[T]):
    """The latest state of something a client observes. `async for` gives the current state, then
    each newer one; states that arrive while the loop body runs are skipped, not queued. Stops
    when closed, by `close()`, leaving an `async with`, or closing the client."""

    def __init__(self, loop: asyncio.AbstractEventLoop, convert: Callable[[T | None, S], T]):
        self._loop = loop
        self._convert = convert
        self._state: T | None = None
        self._version = 0
        self._changed = asyncio.Event()
        self._closed = False
        self._subscription: _ffi.Subscription | _ffi.RoomSubscription | None = None
        _open.add(self)

    @property
    def current(self) -> T | None:
        """The latest state, None before the first."""
        return self._state

    @property
    def closed(self) -> bool:
        return self._closed

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        _open.discard(self)
        if self._subscription is not None:
            self._subscription.cancel()
        self._wake()

    async def __aenter__(self) -> Watch[T]:
        return self

    async def __aexit__(self, *_: object) -> None:
        self.close()

    def __aiter__(self) -> AsyncIterator[T]:
        return self._states()

    async def _states(self) -> AsyncIterator[T]:
        seen = 0
        while not self._closed:
            if self._version > seen and self._state is not None:
                seen = self._version
                yield self._state
                continue
            changed = self._changed
            await changed.wait()

    async def wait_for(self, predicate: Callable[[T], bool], timeout: float | None = None) -> T:
        """The first state, current or coming, that `predicate` accepts. Raises TimeoutError
        after `timeout` seconds, and EOFError if the watch closes first."""

        async def first() -> T:
            async for state in self:
                if predicate(state):
                    return state
            raise EOFError("watch closed")

        return await asyncio.wait_for(first(), timeout)

    # Called on a library thread.
    def _deliver(self, update: S) -> None:
        try:
            self._loop.call_soon_threadsafe(self._push, update)
        except RuntimeError:
            pass  # The loop is closed; nobody is listening.

    def _push(self, update: S) -> None:
        if self._closed:
            return
        self._state = self._convert(self._state, update)
        self._version += 1
        self._wake()

    def _wake(self) -> None:
        self._changed.set()
        self._changed = asyncio.Event()


class RoomWatch(Watch[RoomState]):
    """A room's watch, which can also fetch earlier items."""

    async def load_earlier(self, limit: int | None = None) -> None:
        """Fetches the page before the earliest item; the next state has it."""
        assert isinstance(self._subscription, _ffi.RoomSubscription)
        await self._subscription.load_earlier(limit)


def _room_state(previous: RoomState | None, update: RoomUpdate) -> RoomState:
    timeline = apply_changes(previous.timeline if previous else (), update.timeline)
    return RoomState(
        status=update.status,
        reason=update.reason,
        error=update.error,
        room=update.room,
        live=update.live,
        queue=tuple(update.queue),
        approvals=tuple(update.approvals),
        memory=tuple(update.memory),
        nudges=tuple(update.nudges),
        timeline=timeline,
        can_load_earlier=update.can_load_earlier,
        loading_earlier=update.loading_earlier,
        earlier_error=update.earlier_error,
        pending=tuple(update.pending),
    )


class _ConnectionListener(_ffi.ConnectionListener):
    def __init__(self, watch: Watch[ConnectionStatus]):
        self._watch = weakref.ref(watch)

    def on_status(self, status: ConnectionStatus) -> None:
        if watch := self._watch():
            watch._deliver(status)


class _HomeListener(_ffi.HomeListener):
    def __init__(self, watch: Watch[HomeUpdate]):
        self._watch = weakref.ref(watch)

    def on_update(self, update: HomeUpdate) -> None:
        if watch := self._watch():
            watch._deliver(update)


class _RoomListener(_ffi.RoomListener):
    def __init__(self, watch: RoomWatch):
        self._watch = weakref.ref(watch)

    def on_update(self, update: RoomUpdate) -> None:
        if watch := self._watch():
            watch._deliver(update)


class Client:
    """A client of one assistant on a Nudge server: commands, a socket that reconnects on its
    own, watches of the views, and an outbox that delivers what didn't get through once the
    socket is open again, also after a restart when there is a `cache` file.

        async with Client("https://nudge.example", "robin", FileTokens("~/.nudge-token")) as client:
            async for state in client.room("trip"):
                ...
    """

    def __init__(
        self,
        server: str,
        assistant: str,
        tokens: TokenStore | None = None,
        *,
        cache: str | os.PathLike[str] | None = None,
        client_name: str = "nudge-python",
        client_version: str = VERSION,
        platform: str = "python",
    ) -> None:
        self.tokens = tokens if tokens is not None else MemoryTokens()
        config = _ffi.ClientConfig(
            server=server,
            assistant=assistant,
            client_name=client_name,
            client_version=client_version,
            platform=platform,
            cache_path=os.fspath(cache) if cache is not None else None,
        )
        self.ffi = _ffi.NudgeClient(config, self.tokens)
        self._watches: weakref.WeakSet[Watch] = weakref.WeakSet()

    def open(self) -> None:
        """Connects the socket; watched views are subscribed once it is open."""
        self.ffi.open()

    def close(self) -> None:
        """Closes the socket and every watch of this client."""
        for watch in list(self._watches):
            watch.close()
        self.ffi.close()

    async def __aenter__(self) -> Client:
        self.open()
        return self

    async def __aexit__(self, *_: object) -> None:
        self.close()

    def retry_now(self) -> None:
        """Reconnects at once when waiting to retry."""
        self.ffi.retry_now()

    @property
    def status(self) -> ConnectionStatus:
        return self.ffi.connection_status()

    def connection(self) -> Watch[ConnectionStatus]:
        """The socket's status, now and on every change."""
        watch: Watch[ConnectionStatus] = Watch(asyncio.get_running_loop(), lambda _, s: s)
        watch._subscription = self.ffi.observe_connection(_ConnectionListener(watch))
        self._watches.add(watch)
        return watch

    def home(self) -> Watch[HomeUpdate]:
        """The player's home view: their rooms and nudges."""
        watch: Watch[HomeUpdate] = Watch(asyncio.get_running_loop(), lambda _, u: u)
        watch._subscription = self.ffi.observe_home(_HomeListener(watch))
        self._watches.add(watch)
        return watch

    def room(self, room: str) -> RoomWatch:
        """A room's view, with its whole timeline in every state."""
        watch = RoomWatch(asyncio.get_running_loop(), _room_state)
        watch._subscription = self.ffi.observe_room(room, _RoomListener(watch))
        self._watches.add(watch)
        return watch

    async def pair(self, code: str) -> Paired:
        """Trades a pairing code for a token, and stores it."""
        return await self.ffi.pair(code)

    async def me(self) -> MeInfo:
        return await self.ffi.me()

    async def create_room(self, name: str, members: Sequence[str] = ()) -> Room:
        """A shared room with the caller and `members` (player ids)."""
        return await self.ffi.create_room(name, list(members))

    async def personal_room(self) -> Room:
        """The caller's personal room, made on first use."""
        return await self.ffi.personal_room()

    async def send(self, room: str, text: str, *, when_busy: WhenBusy | None = None) -> Sent:
        """Sends a message, pending in the room's state until the timeline has it. `Sent.QUEUED`
        means it is in the outbox, to go out when the server can be reached; refused messages
        raise `NudgeError` and stay pending with the error until `resend` or `dismiss`."""
        return await self.ffi.send(room, text, when_busy)

    async def resend(self, room: str, request_id: str) -> Sent:
        return await self.ffi.resend(room, request_id)

    def dismiss(self, room: str, request_id: str) -> None:
        self.ffi.dismiss(room, request_id)

    async def abort(self, room: str) -> None:
        """Stops the answer in progress, and drops the room's queued messages."""
        await self.ffi.abort(room)

    async def remember(self, room: str, text: str) -> Fact:
        return await self.ffi.remember(room, text)

    async def forget(self, room: str, fact_id: str) -> None:
        await self.ffi.forget(room, fact_id)

    async def decide(self, room: str, approval_id: str, approve: bool) -> Approval:
        return await self.ffi.decide(room, approval_id, approve)

    async def cancel_nudge(self, nudge_id: str) -> None:
        await self.ffi.cancel_nudge(nudge_id)

    async def protect(self, value: str, kind: str | None = None) -> str:
        """A placeholder that stands for `value` in what the model sees."""
        return await self.ffi.protect(value, kind)

    # Admin commands, for players with the admin flag.

    async def create_player(self, display_name: str) -> Player:
        return await self.ffi.create_player(display_name)

    async def pairing_code(self, player_id: str) -> PairingCode:
        return await self.ffi.pairing_code(player_id)

    async def list_tokens(self, player_id: str | None = None) -> list[TokenInfo]:
        return await self.ffi.list_tokens(player_id)

    async def revoke(self, client_id: str) -> None:
        """Revokes a client's token; its sockets close with 4401."""
        await self.ffi.revoke(client_id)
