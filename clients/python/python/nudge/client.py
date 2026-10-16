"""An asyncio face on the generated bindings: views arrive as `Watch`es to iterate, the room's
timeline comes whole rather than as changes, and listeners are cancelled before the interpreter
shuts down (a library thread calling into a finalizing interpreter crashes it)."""

from __future__ import annotations

import asyncio
import atexit
import json
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
    DevicePlatform,
    ExtensionSetup,
    Fact,
    GoneReason,
    HomeUpdate,
    Live,
    MeInfo,
    ModelMessage,
    Paired,
    PairingCode,
    PanelStatus,
    PendingMessage,
    Player,
    PlayerMemory,
    PushEnvironment,
    PushPlatforms,
    QueuedMessage,
    Room,
    RoomExtension,
    RoomNudge,
    RoomUpdate,
    SavedExtensionSetup,
    Sent,
    SyncStatus,
    TimelineChange,
    TimelineItem,
    TokenInfo,
    TokenStore,
    Usage,
    WhenBusy,
)
from nudge.tokens import MemoryTokens

__all__ = ["Client", "Panel", "RoomState", "RoomWatch", "Watch", "apply_changes"]

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


# Watches and panels whose listener may still be called, cancelled at exit.
_open: weakref.WeakSet[Watch | Panel] = weakref.WeakSet()


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


class Panel:
    """A room's socket to an extension's panel, such as `lists`, `documents`, `connectors` or
    `browser`: the extension's frames as dicts, every one and in order (`async for`, or
    `wait_for`), and `send` for its inputs. The frames are the extension's own, such as
    `{"type": "lists", ...}`, and `ok` and `error` replies that echo an input's `ref`. It
    reconnects on its own, and the extension sends its view again then. `statuses` watches the
    socket: `PanelStatus.CLOSED` with code 4404 when the room has no such extension. `close()` or
    leaving an `async with` stops it."""

    def __init__(self, loop: asyncio.AbstractEventLoop):
        self._loop = loop
        self._frames: asyncio.Queue[dict | None] = asyncio.Queue()
        self._closed = False
        self._ffi: _ffi.Panel | None = None
        self.statuses: Watch[PanelStatus] = Watch(loop, lambda _, status: status)
        _open.add(self)

    @property
    def status(self) -> PanelStatus | None:
        """The socket's latest status, None before the first."""
        return self.statuses.current

    @property
    def closed(self) -> bool:
        return self._closed

    def send(self, frame: dict) -> None:
        """Sends one of the extension's inputs; dropped while the socket isn't open."""
        assert self._ffi is not None
        self._ffi.send(json.dumps(frame))

    def close(self) -> None:
        if self._closed:
            return
        self._closed = True
        _open.discard(self)
        if self._ffi is not None:
            self._ffi.disconnect()
        self.statuses.close()
        self._frames.put_nowait(None)

    async def __aenter__(self) -> Panel:
        return self

    async def __aexit__(self, *_: object) -> None:
        self.close()

    def __aiter__(self) -> AsyncIterator[dict]:
        return self._each()

    async def _each(self) -> AsyncIterator[dict]:
        while not self._closed:
            frame = await self._frames.get()
            if frame is None:
                return
            yield frame

    async def wait_for(
        self, predicate: Callable[[dict], bool], timeout: float | None = None
    ) -> dict:
        """The next frame `predicate` accepts; the ones before it are passed over. Raises
        TimeoutError after `timeout` seconds, and EOFError if the panel closes first."""

        async def first() -> dict:
            async for frame in self:
                if predicate(frame):
                    return frame
            raise EOFError("panel closed")

        return await asyncio.wait_for(first(), timeout)

    # Called on a library thread.
    def _deliver(self, frame: dict) -> None:
        try:
            self._loop.call_soon_threadsafe(self._push, frame)
        except RuntimeError:
            pass  # The loop is closed; nobody is listening.

    def _push(self, frame: dict) -> None:
        if not self._closed:
            self._frames.put_nowait(frame)


class _PanelListener(_ffi.PanelListener):
    def __init__(self, panel: Panel):
        self._panel = weakref.ref(panel)

    def on_status(self, status: PanelStatus) -> None:
        if panel := self._panel():
            panel.statuses._deliver(status)

    def on_frame(self, json_: str) -> None:
        if panel := self._panel():
            panel._deliver(json.loads(json_))


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
        self._watches: weakref.WeakSet[Watch | Panel] = weakref.WeakSet()

    def open(self) -> None:
        """Connects the socket; watched views are subscribed once it is open."""
        self.ffi.connect()

    def close(self) -> None:
        """Closes the socket and every watch and panel of this client."""
        for watch in list(self._watches):
            watch.close()
        self.ffi.disconnect()

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

    def panel(self, room: str, extension: str) -> Panel:
        """A room's socket to an extension's panel, such as `lists` or `documents`."""
        panel = Panel(asyncio.get_running_loop())
        panel._ffi = self.ffi.open_panel(room, extension, _PanelListener(panel))
        self._watches.add(panel)
        return panel

    async def pair(self, code: str) -> Paired:
        """Trades a pairing code for a token, and stores it."""
        return await self.ffi.pair(code)

    async def me(self) -> MeInfo:
        return await self.ffi.me()

    async def sign_out(self) -> None:
        """Revokes this client's token on the server and forgets it; the socket closes with
        4401."""
        await self.ffi.sign_out()

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

    async def my_memory(self) -> PlayerMemory:
        """The caller's own memory, and whether they share it with all their rooms."""
        return await self.ffi.my_memory()

    async def remember_for_me(self, text: str) -> Fact:
        return await self.ffi.remember_for_me(text)

    async def forget_for_me(self, fact_id: str) -> None:
        await self.ffi.forget_for_me(fact_id)

    async def share_my_memory(self, shared: bool) -> PlayerMemory:
        """With `shared`, everyone in the caller's rooms, and the model there, sees their own
        facts."""
        return await self.ffi.share_my_memory(shared)

    async def room_extensions(self, room: str) -> list[RoomExtension]:
        return await self.ffi.room_extensions(room)

    async def set_room_extension(
        self, room: str, extension: str, enabled: bool | None
    ) -> RoomExtension:
        """Turns an extension on or off in the room; `None` goes back to the default for its
        kind."""
        return await self.ffi.set_room_extension(room, extension, enabled)

    async def decide(self, room: str, approval_id: str, approve: bool) -> Approval:
        return await self.ffi.decide(room, approval_id, approve)

    async def cancel_nudge(self, nudge_id: str) -> None:
        await self.ffi.cancel_nudge(nudge_id)

    async def protect(self, value: str, kind: str | None = None) -> str:
        """A placeholder that stands for `value` in what the model sees."""
        return await self.ffi.protect(value, kind)

    async def model_view(self, room: str) -> list[ModelMessage]:
        """What the model saw in the room, as sent: placeholders, not the values."""
        return await self.ffi.model_view(room)

    async def usage(self) -> Usage:
        """This month's model spend; every month, room and player for admins."""
        return await self.ffi.usage()

    async def push_platforms(self) -> PushPlatforms:
        """Which native pushes the server sends; `NudgeError.Status` 404 when it sends none."""
        return await self.ffi.push_platforms()

    async def register_device(
        self,
        platform: DevicePlatform,
        token: str,
        environment: PushEnvironment | None = None,
    ) -> None:
        """Has the server push to a device (an APNs device token in hex, or an FCM registration
        token) when one of the player's rooms has news; `environment` is for APNs."""
        await self.ffi.register_device(platform, token, environment)

    async def unregister_device(self, token: str) -> None:
        await self.ffi.unregister_device(token)

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

    async def extension_setups(self) -> list[ExtensionSetup]:
        """The assistant's extensions and the ones it could add, with their settings and JSON
        Schemas as JSON text (`json.loads(setup.settings_json)`)."""
        return await self.ffi.extension_setups()

    async def save_extension_setups(
        self, extensions: Sequence[SavedExtensionSetup]
    ) -> list[ExtensionSetup]:
        """Installs `extensions`, in order, in place of the assistant's, and keeps them in its
        config; ones left out are removed. `NudgeError.Status` 400, and nothing changed, when one
        won't start."""
        return await self.ffi.save_extension_setups(list(extensions))
