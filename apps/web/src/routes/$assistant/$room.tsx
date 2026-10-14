import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePartPrimitive,
  MessagePrimitive,
  type MessageState,
  type MessageStatus,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useCallback, useEffect, useMemo, useState } from "react";
import {
  appendText,
  buildQueueAdapter,
  type PendingSend,
  toThreadMessageLike,
} from "../../assistant-runtime.ts";
import { cancelNudge, forget, forgetToken, remember } from "../../api.ts";
import { useEarlierHistory } from "../../earlier.ts";
import { memoryQuery, meQuery, nudgesQuery, roomQuery } from "../../queries.ts";
import { type RoomSocket, useRoomSocket, useRoomState } from "../../room-socket.ts";
import { type RoomStatus, ThreadReader } from "../../thread.ts";
import { newlyDoneToolCalls } from "../../tool-watch.ts";

const MEMORY_TOOLS = new Set(["remember", "forget"]);
const NUDGE_TOOLS = new Set(["schedule_nudge", "cancel_nudge"]);
const WATCHED_TOOLS = new Set([...MEMORY_TOOLS, ...NUDGE_TOOLS]);

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

/** `CLOSE.unauthorized` in `@nudge/server`'s protocol: the token the tab has no longer works. */
const UNAUTHORIZED = 4401;

function Room() {
  const { assistant, room } = Route.useParams();
  const query = useQuery(roomQuery(assistant, room));
  const { socket, retrying } = useRoomSocket(assistant, room);
  const state = useRoomState(socket);
  const navigate = useNavigate();

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  if (query.isPending) return <p className="text-stone-500">Loading…</p>;
  if (query.error) return <p className="text-red-700">{query.error.message}</p>;
  const { room: info, members } = query.data;

  return (
    <section className="flex flex-col gap-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h2 className="text-lg font-medium">{info.name}</h2>
          <p className="text-sm text-stone-600">
            {members.map((member) => member.displayName).join(", ")}
          </p>
        </div>
        <Link
          to="/$assistant/$room/browser"
          params={{ assistant, room }}
          className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
        >
          Browser
        </Link>
      </div>
      {socket === undefined ? (
        <p className="text-stone-500">Connecting…</p>
      ) : state.status === "closed" ? (
        retrying ? (
          <p className="text-stone-500">Reconnecting…</p>
        ) : (
          <p className="text-red-700">Disconnected{state.error ? `: ${state.error}` : ""}.</p>
        )
      ) : (
        <Chat socket={socket} />
      )}
      <MemoryPanel assistant={assistant} room={room} />
      <NudgesPanel assistant={assistant} room={room} />
    </section>
  );
}

function Chat({ socket }: { socket: RoomSocket }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const state = useRoomState(socket);
  const reader = useMemo(() => new ThreadReader(), [socket]);
  const earlier = useEarlierHistory(assistant, room, state.view);
  const thread = useMemo(
    () => (state.view === undefined ? undefined : reader.read(state.view, me, earlier.entries)),
    [reader, state.view, me, earlier.entries],
  );
  const { pending, dispatch } = usePendingSends(socket);
  const queryClient = useQueryClient();
  const seenToolCalls = useMemo(() => new Set<string>(), [socket]);

  // The only signal in the browser for "a remember/forget/nudge tool result landed": a completed
  // tool call in the thread. Refetches the panel it affects instead of rendering from the call.
  useEffect(() => {
    if (thread === undefined) return;
    const done = newlyDoneToolCalls(thread.messages, WATCHED_TOOLS, seenToolCalls);
    if (done.length === 0) return;
    for (const call of done) seenToolCalls.add(call.toolCallId);
    if (done.some((call) => MEMORY_TOOLS.has(call.toolName)))
      void queryClient.invalidateQueries({ queryKey: [assistant, "rooms", room, "memory"] });
    if (done.some((call) => NUDGE_TOOLS.has(call.toolName)))
      void queryClient.invalidateQueries({ queryKey: [assistant, "nudges"] });
  }, [thread, seenToolCalls, queryClient, assistant, room]);

  const runtime = useExternalStoreRuntime({
    messages: thread?.messages ?? [],
    convertMessage: toThreadMessageLike,
    isRunning: thread?.isRunning ?? false,
    hasEarlier: earlier.hasEarlier,
    onLoadEarlier: earlier.loadEarlier,
    onNew: async (message) => dispatch(message, message.steer ? "steer" : "queue"),
    onCancel: async () => socket.abort(),
    queue: buildQueueAdapter(thread?.queue ?? [], pending, dispatch),
  });

  if (thread === undefined) return <p className="text-stone-500">Connecting…</p>;

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex flex-col gap-3">
        <StatusLine status={thread.status} />
        <ThreadPrimitive.Viewport className="flex flex-col gap-2">
          <ThreadPrimitive.LoadEarlier className="self-center text-sm text-stone-500 underline disabled:text-stone-300 disabled:no-underline">
            Load earlier
          </ThreadPrimitive.LoadEarlier>
          <ThreadPrimitive.Messages>
            {({ message }) => <MessageRow message={message} />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <ComposerPrimitive.Root className="flex flex-col gap-2">
          <ComposerPrimitive.Queue>
            {({ queueItem }) => (
              <p key={queueItem.id} className="text-sm text-stone-500">
                Waiting: {queueItem.prompt}
              </p>
            )}
          </ComposerPrimitive.Queue>
          <div className="flex gap-2">
            <ComposerPrimitive.Input
              placeholder="Message"
              className="flex-1 rounded border border-stone-300 px-2 py-1"
            />
            {thread.isRunning ? (
              <ComposerPrimitive.Cancel className="rounded border px-3">
                Stop
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send className="rounded border px-3">Send</ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
}

/** Tracks our own sends from the moment they're typed until the server acknowledges them. */
function usePendingSends(socket: RoomSocket) {
  const [pending, setPending] = useState<readonly PendingSend[]>([]);

  const dispatch = useCallback(
    (message: AppendMessage, lane: "queue" | "steer") => {
      const text = appendText(message).trim();
      if (text === "") return;
      const localId = `local:${Math.random().toString(36).slice(2)}`;
      setPending((current) => [...current, { localId, text, lane }]);
      const settle = () =>
        setPending((current) => current.filter((item) => item.localId !== localId));
      void socket.submit(text, lane === "steer" ? "steer" : undefined).then(settle, settle);
    },
    [socket],
  );

  return { pending, dispatch };
}

function StatusLine({ status }: { status?: RoomStatus }) {
  if (status === undefined) return null;
  switch (status.kind) {
    case "retrying":
      return (
        <p className="text-sm text-amber-700">
          Retrying (attempt {status.attempt}): {status.error}
        </p>
      );
    case "compacting":
      return <p className="text-sm text-stone-500">Summarizing older messages…</p>;
    case "compaction-failed":
      return (
        <p className="text-sm text-amber-700">Couldn't summarize older messages: {status.error}</p>
      );
  }
}

function MessageRow({ message }: { message: MessageState }) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return <AssistantMessage message={message} />;
    case "system":
      return <SystemMessage message={message} />;
  }
}

function UserMessage({ message }: { message: MessageState }) {
  const custom = message.metadata.custom as { author?: string; mine?: boolean } | undefined;
  return (
    <MessagePrimitive.Root>
      <p>
        <b>{custom?.mine ? "You" : (custom?.author ?? "Someone")}:</b>{" "}
        <MessagePrimitive.Parts components={{ Text: TextPart }} />
      </p>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ message }: { message: Extract<MessageState, { role: "assistant" }> }) {
  return (
    <MessagePrimitive.Root>
      <div className="rounded bg-stone-100 px-3 py-2">
        <MessagePrimitive.Parts
          components={{
            Text: MarkdownText,
            Reasoning: ReasoningPart,
            tools: { Fallback: ToolCallPart },
          }}
        />
        {message.status.type !== "complete" && (
          <p className="text-xs text-stone-500">{statusLabel(message.status)}</p>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage({ message }: { message: MessageState }) {
  const part = message.content[0] as
    | { readonly name?: string; readonly data?: unknown }
    | undefined;
  if (part?.name === "nudge")
    return <p className="italic text-stone-600">Nudge: {(part.data as { text: string }).text}</p>;
  if (part?.name === "marker") return <hr />;
  return null;
}

function TextPart() {
  return <MessagePartPrimitive.Text component="p" />;
}

// No `@tailwindcss/typography`: everything else in this app is hand-rolled utility classes (see
// the plan's Decisions), so markdown elements get the same treatment instead of a `prose` class.
function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      className="[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-stone-300
        [&_blockquote]:pl-2 [&_blockquote]:text-stone-600 [&_code]:rounded [&_code]:bg-stone-200
        [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold
        [&_h3]:font-semibold [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-1
        [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-stone-200 [&_pre]:p-2
        [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}

function ReasoningPart() {
  return <MessagePartPrimitive.Text component="p" className="text-sm text-stone-500" />;
}

function ToolCallPart({ toolName, status, result, isError, artifact }: ToolCallMessagePartProps) {
  const { assistant, room } = Route.useParams();
  if (toolName === "browse" && (artifact as { needsLogin?: boolean } | undefined)?.needsLogin)
    return (
      <p className="my-1 text-sm">
        <Link
          to="/$assistant/$room/browser"
          params={{ assistant, room }}
          className="inline-block rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600"
        >
          Open the room's browser to log in
        </Link>
      </p>
    );
  return (
    <p className="text-sm text-stone-500">
      {toolName} — {result !== undefined ? (isError ? "failed" : "done") : status.type}
    </p>
  );
}

function statusLabel(status: MessageStatus): string {
  switch (status.type) {
    case "running":
      return "running";
    case "requires-action":
      return status.reason;
    case "incomplete":
      return status.reason === "cancelled" ? "stopped" : "failed";
    case "complete":
      return "";
  }
}

function MemoryPanel({ assistant, room }: { assistant: string; room: string }) {
  const query = useQuery(memoryQuery(assistant, room));
  const queryClient = useQueryClient();
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  const invalidate = () =>
    queryClient.invalidateQueries({ queryKey: [assistant, "rooms", room, "memory"] });

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === "") return;
    setBusy(true);
    setError(undefined);
    try {
      await remember(assistant, room, value);
      setText("");
      await invalidate();
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onForget(id: string) {
    try {
      await forget(assistant, room, id);
    } finally {
      await invalidate();
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Memory</h3>
      {query.data?.facts.length === 0 && (
        <p className="text-sm text-stone-500">Nothing remembered yet.</p>
      )}
      <ul className="flex flex-col gap-1">
        {query.data?.facts.map((fact) => (
          <li key={fact.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span>{fact.text}</span>
            <button
              type="button"
              onClick={() => void onForget(fact.id)}
              className="shrink-0 text-stone-500 underline"
            >
              Forget
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Remember something"
          className="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ""}
          className="rounded border px-2 text-sm disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

function NudgesPanel({ assistant, room }: { assistant: string; room: string }) {
  const query = useQuery(nudgesQuery(assistant));
  const queryClient = useQueryClient();
  const nudges = query.data?.nudges.filter((nudge) => nudge.roomId === room) ?? [];

  async function onCancel(id: string) {
    try {
      await cancelNudge(assistant, id);
    } finally {
      await queryClient.invalidateQueries({ queryKey: [assistant, "nudges"] });
    }
  }

  // Nudges can only be scheduled from chat, not this panel, so there's nothing to show for an
  // empty list beyond the chat itself already being silent about it.
  if (nudges.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Nudges</h3>
      <ul className="flex flex-col gap-1">
        {nudges.map((nudge) => (
          <li key={nudge.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span>
              {new Date(nudge.fireAt).toLocaleString()} — {nudge.message}
            </span>
            <button
              type="button"
              onClick={() => void onCancel(nudge.id)}
              className="shrink-0 text-stone-500 underline"
            >
              Cancel
            </button>
          </li>
        ))}
      </ul>
    </section>
  );
}
