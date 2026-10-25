import {
  type AppendMessage,
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  type MessageState,
  type MessageStatus,
  ThreadPrimitive,
  type ToolCallMessagePartProps,
  useExternalStoreRuntime,
  useMessagePartText,
} from "@assistant-ui/react";
import { MarkdownTextPrimitive } from "@assistant-ui/react-markdown";
import type {
  Approval,
  PendingMessage,
  RoomState,
  RoomStore,
  RoomView,
  Status,
} from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import {
  createContext,
  type FormEvent,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  use,
  useMemo,
  useRef,
  useState,
} from "react";
import { clientFor, forgetToken, useConnection, useRoom, useRoomList } from "../../api.ts";
import { type Appearance, lookOf, NUDGE } from "../../avatar/appearance.ts";
import { Avatar, Portrait } from "../../avatar/Avatar.tsx";
import type { Mood } from "../../avatar/pose.ts";
import { useRoomMood } from "../../avatar/use-room-mood.ts";
import {
  announcement,
  appendText,
  buildQueueAdapter,
  dayLabel,
  dayStarts,
  type Lane,
  PLACEHOLDER,
  type Seen,
  timeLabel,
  toThreadMessageLike,
  transcript,
} from "../../assistant-runtime.ts";
import { dateLocale, m } from "../../i18n/index.ts";
import { assistantsQuery, meQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

/** `CLOSE.unauthorized` in the protocol: the token the tab has no longer works. */
const UNAUTHORIZED = 4401;

/** The room's view, for the parts deep in the chat that need it, such as approval cards. */
const ViewContext = createContext<RoomView | undefined>(undefined);
/** How the assistant's robot looks, for the portraits beside its answers. */
const LookContext = createContext<Appearance>(NUDGE);

function Room() {
  const { assistant, room } = Route.useParams();
  const held = useRoom(assistant, room);
  const connection = useConnection(assistant);
  const navigate = useNavigate();
  // Below `md` the sidebar is a drawer over the chat.
  const [drawer, setDrawer] = useState(false);
  // Focus goes into the drawer when it opens, and back to what opened it when it closes.
  const opener = useRef<HTMLButtonElement>(null);
  const closer = useRef<HTMLButtonElement>(null);
  const closeDrawer = useCallback(() => {
    setDrawer(false);
    opener.current?.focus();
  }, []);
  useEffect(() => {
    if (drawer) closer.current?.focus();
  }, [drawer]);

  useEffect(() => {
    if (connection.kind === "closed" && connection.code === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, connection]);

  const view = held?.state.view;
  if (held?.state.status === "gone")
    return (
      <p className="p-4 text-red-700">
        {held.state.reason === "removed" ? m.room.removed : m.room.noSuchRoom}
      </p>
    );
  if (held === undefined || view === undefined)
    return (
      <p className="p-4 text-stone-500">
        {connection.kind === "closed" ? m.room.disconnected(connection.reason) : m.room.connecting}
      </p>
    );

  const waiting = view.approvals.filter((item) => item.status === "pending").length;
  return (
    <ViewContext value={view}>
      <div className="relative flex h-full min-h-0">
        {drawer && (
          <button
            type="button"
            aria-label={m.room.closeDetails}
            tabIndex={-1}
            onClick={closeDrawer}
            className="fixed inset-0 z-20 bg-stone-900/30 md:hidden"
          />
        )}
        <aside
          {...(drawer ? { role: "dialog", "aria-modal": true, "aria-label": m.room.details } : {})}
          onKeyDown={(event) => {
            if (drawer && event.key === "Escape") closeDrawer();
          }}
          className={`${
            drawer ? "fixed inset-y-0 left-0 z-30 flex w-[min(22rem,88vw)] shadow-xl" : "hidden"
          } flex-col gap-4 overflow-y-auto border-r border-stone-200 bg-stone-50 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] md:static md:flex md:w-80 md:shrink-0 md:pt-4 md:pb-4 md:shadow-none`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <RoomName view={view} />
              <p className="text-sm text-stone-600">
                {view.room.members.map((member, index) => (
                  <span key={member.id} title={member.address}>
                    {index > 0 && ", "}
                    {member.displayName}
                    {member.address !== undefined && (
                      <span className="text-stone-400">
                        {" "}
                        {m.room.from(member.address.slice(member.address.indexOf("@") + 1))}
                      </span>
                    )}
                  </span>
                ))}
              </p>
            </div>
            <button
              ref={closer}
              type="button"
              onClick={closeDrawer}
              className="shrink-0 rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-200 md:hidden"
            >
              {m.common.close}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/$assistant/$room/activity"
              params={{ assistant, room }}
              title={m.room.links.activityTitle}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.activity}
            </Link>
            <Link
              to="/$assistant/$room/browser"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.browser}
            </Link>
            <Link
              to="/$assistant/$room/desktop"
              params={{ assistant, room }}
              title={m.room.links.desktopTitle}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.desktop}
            </Link>
            <Link
              to="/$assistant/$room/connectors"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.connectors}
            </Link>
            <Link
              to="/$assistant/$room/mcp"
              params={{ assistant, room }}
              title={m.room.links.mcpTitle}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.mcp}
            </Link>
            <Link
              to="/$assistant/$room/lists"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.lists}
            </Link>
            <Link
              to="/$assistant/$room/documents"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.documents}
            </Link>
            <Link
              to="/$assistant/$room/model"
              params={{ assistant, room }}
              title={m.room.links.modelTitle}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              {m.room.links.model}
            </Link>
          </div>
          <ApprovalsPanel approvals={view.approvals} />
          <MemoryPanel view={view} />
          <LocationPanel view={view} />
          <PrivateValuesPanel />
          <NudgesPanel view={view} />
          <ExtensionsPanel />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:pt-4 sm:pb-4">
          <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
            <h2 className="min-w-0 flex-1 truncate font-medium">{view.room.name}</h2>
            <Link
              to="/$assistant/$room/activity"
              params={{ assistant, room }}
              className="shrink-0 rounded border border-stone-300 bg-white px-3 py-1 text-sm"
            >
              {m.room.links.activity}
            </Link>
            <button
              ref={opener}
              type="button"
              aria-haspopup="dialog"
              aria-expanded={drawer}
              onClick={() => setDrawer(true)}
              className="flex shrink-0 items-center gap-1.5 rounded border border-stone-300 bg-white px-3 py-1 text-sm"
            >
              {m.room.open}
              {waiting > 0 && (
                <span className="rounded-full bg-amber-600 px-1.5 text-xs text-white">
                  {waiting}
                  <span className="sr-only">{m.room.waitingForApproval}</span>
                </span>
              )}
            </button>
          </div>
          {connection.kind === "waiting" ? (
            <p className="text-sm text-stone-500">{m.room.reconnecting}</p>
          ) : connection.kind === "closed" ? (
            <p className="text-sm text-red-700">{m.room.disconnected(connection.reason)}</p>
          ) : null}
          <SharingLocation view={view} />
          <Chat store={held.store} state={held.state} view={view} />
        </div>
      </div>
    </ViewContext>
  );
}

/** The room's name, which its members may change; the lobby's only an admin. */
function RoomName({ view }: { view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const admin = useQuery(meQuery(assistant)).data?.admin ?? false;
  const [draft, setDraft] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // Back on Rename once the name is saved or the change cancelled.
  const rename = useRef<HTMLButtonElement>(null);
  const editing = draft !== undefined;
  const wasEditing = useRef(false);
  useEffect(() => {
    if (wasEditing.current && !editing) rename.current?.focus();
    wasEditing.current = editing;
  }, [editing]);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const name = draft?.trim() ?? "";
    if (name === "") return;
    setBusy(true);
    setError(undefined);
    try {
      // The new name comes back through the room's view.
      await clientFor(assistant).api.renameRoom(room, name);
      setDraft(undefined);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  if (draft === undefined)
    return (
      <div className="flex items-baseline gap-2">
        <h2 className="text-lg font-medium">{view.room.name}</h2>
        {(view.room.kind !== "lobby" || admin) && (
          <button
            ref={rename}
            type="button"
            onClick={() => setDraft(view.room.name)}
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            {m.room.rename}
          </button>
        )}
      </div>
    );
  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1">
      <div className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          aria-label={m.room.name}
          autoFocus
          onKeyDown={(event) => {
            if (event.key !== "Escape") return;
            // Not the drawer's too: Escape here only cancels the rename.
            event.stopPropagation();
            setDraft(undefined);
            setError(undefined);
          }}
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        >
          {m.common.save}
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(undefined);
            setError(undefined);
          }}
          className="rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-200"
        >
          {m.common.cancel}
        </button>
      </div>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}

function Chat({ store, state, view }: { store: RoomStore; state: RoomState; view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const name =
    useQuery(assistantsQuery()).data?.assistants.find((item) => item.name === assistant)
      ?.displayName ?? assistant;
  // Only in a shared room is there anyone to keep a message from.
  const shared = view.room.kind !== "personal";
  const [secret, setSecret] = useState(false);
  const mood = useRoomMood(view);
  const look = lookOf(useRoomList(assistant)?.view?.appearance);
  const said = useAnnouncement(room, state.timeline, view.approvals, me, name);
  // The composer keeps the focus: after a send, and on opening a room (where a keyboard is the
  // pointer; on a phone that would pop up the keyboard unasked).
  const input = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (matchMedia("(pointer: fine)").matches) input.current?.focus();
  }, [room]);
  const dispatch = useCallback(
    (message: AppendMessage, lane: Lane) => {
      const text = appendText(message).trim();
      if (text === "") return;
      // A failed send stays in the store's `pending` with its error; the page offers it again.
      clientFor(assistant)
        .send(room, text, {
          ...(lane === "steer" ? { whenBusy: "steer" as const } : {}),
          ...(secret && shared ? { private: true } : {}),
        })
        .catch(() => {});
    },
    [assistant, room, secret, shared],
  );
  const convertMessage = useCallback(
    (item: RoomView["timeline"][number]) => toThreadMessageLike(item, me),
    [me],
  );

  // Tool calls, nudges and ended approvals are on the activity page, not in the chat.
  const messages = useMemo(
    () => transcript(state.timeline, view.approvals),
    [state.timeline, view.approvals],
  );
  const days = useMemo(() => dayStarts(messages), [messages]);
  const runtime = useExternalStoreRuntime({
    messages,
    convertMessage,
    isRunning: view.live.running,
    hasEarlier: state.canLoadEarlier,
    onLoadEarlier: () => store.loadEarlier(),
    onNew: async (message) => {
      dispatch(message, message.steer ? "steer" : "queue");
      input.current?.focus();
    },
    onCancel: async () => {
      await clientFor(assistant).api.abort(room);
    },
    queue: buildQueueAdapter(view.queue, state.pending, dispatch),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <LookContext value={look}>
        <div className="flex h-full min-h-0 flex-col gap-3">
          {/* Read out when an answer is done or an approval is asked for, not as it streams. */}
          <p role="status" aria-live="polite" aria-atomic className="sr-only">
            {said}
          </p>
          <StatusLine status={view.live.status} />
          <ThreadPrimitive.Viewport className="flex min-h-0 min-w-0 flex-1 flex-col gap-3 overflow-x-hidden overflow-y-auto">
            <ThreadPrimitive.LoadEarlier className="self-center text-sm text-stone-500 underline disabled:text-stone-300 disabled:no-underline">
              {m.room.chat.loadEarlier}
            </ThreadPrimitive.LoadEarlier>
            {state.earlierError !== undefined && (
              <p className="self-center text-sm text-red-700">{state.earlierError}</p>
            )}
            <ThreadPrimitive.Empty>
              <div className="m-auto flex flex-col items-center gap-2 py-8 text-stone-500">
                <Avatar mood={mood} appearance={look} size={160} title={name} />
                <p>{m.room.chat.sayHello(name)}</p>
              </div>
            </ThreadPrimitive.Empty>
            <ThreadPrimitive.Messages>
              {({ message }) => (
                <>
                  {days.has(message.id) && <DayDivider at={days.get(message.id)!} />}
                  <MessageRow message={message} assistant={name} />
                </>
              )}
            </ThreadPrimitive.Messages>
          </ThreadPrimitive.Viewport>
          <FailedSends store={store} pending={state.pending} />
          {messages.length > 0 && <Presence mood={mood} look={look} view={view} name={name} />}
          <ComposerPrimitive.Root className="flex shrink-0 flex-col gap-2">
            <ComposerPrimitive.Queue>
              {({ queueItem }) => (
                <p key={queueItem.id} className="text-sm [overflow-wrap:anywhere] text-stone-500">
                  {m.room.chat.waiting(queueItem.prompt)}
                </p>
              )}
            </ComposerPrimitive.Queue>
            <div className="flex gap-2">
              {shared && (
                <button
                  type="button"
                  aria-pressed={secret}
                  onClick={() => setSecret((on) => !on)}
                  title={m.room.chat.privateTitle}
                  className={`shrink-0 rounded border px-2 text-sm ${
                    secret
                      ? "border-violet-700 bg-violet-700 text-white"
                      : "bg-white text-stone-600"
                  }`}
                >
                  {m.room.chat.private}
                </button>
              )}
              <ComposerPrimitive.Input
                ref={input}
                aria-label={secret && shared ? m.room.chat.privateMessage : m.room.chat.message}
                placeholder={
                  secret && shared ? m.room.chat.privatePlaceholder : m.room.chat.message
                }
                className="max-h-40 min-w-0 flex-1 resize-none rounded border border-stone-300 bg-white px-2 py-1.5"
              />
              {view.live.running ? (
                <ComposerPrimitive.Cancel className="shrink-0 rounded border bg-white px-3">
                  {m.room.chat.stop}
                </ComposerPrimitive.Cancel>
              ) : (
                <ComposerPrimitive.Send className="shrink-0 rounded border bg-white px-3">
                  {m.room.chat.send}
                </ComposerPrimitive.Send>
              )}
            </div>
          </ComposerPrimitive.Root>
        </div>
      </LookContext>
    </AssistantRuntimeProvider>
  );
}

/**
 * The latest line for the chat's live region, from `announcement`. A room starts with nothing to
 * say, so switching to one doesn't read out its history.
 */
function useAnnouncement(
  room: string,
  timeline: RoomState["timeline"],
  approvals: RoomView["approvals"],
  me: string,
  name: string,
): string {
  const [said, setSaid] = useState("");
  const seen = useRef<{ room: string; at: Seen }>(undefined);
  useEffect(() => {
    const now = { timeline, approvals };
    const before = seen.current?.room === room ? seen.current.at : undefined;
    seen.current = { room, at: now };
    if (before === undefined) setSaid("");
    const line = announcement(before, now, me, name);
    if (line !== undefined) setSaid(line);
  }, [room, timeline, approvals, me, name]);
  return said;
}

/** The robot, live, and a word on what it is doing. */
function Presence({
  mood,
  look,
  view,
  name,
}: {
  mood: Mood;
  look: Appearance;
  view: RoomView;
  name: string;
}) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-sm text-stone-500">
      <Avatar mood={mood} appearance={look} size={40} title={name} />
      <span aria-live="polite">{presenceLabel(mood, view)}</span>
    </div>
  );
}

function presenceLabel(mood: Mood, view: RoomView): string {
  switch (mood) {
    case "working": {
      const answer = view.timeline.findLast((item) => item.type === "answer");
      const part = answer?.parts.at(-1);
      return part?.type === "tool" ? m.room.presence.using(part.name) : m.room.presence.working;
    }
    case "thinking":
      return view.live.status?.kind === "compacting"
        ? m.room.presence.tidying
        : m.room.presence.thinking;
    case "speaking":
      return m.room.presence.answering;
    case "waiting":
      return m.room.presence.waiting;
    case "puzzled":
      return m.room.presence.tryingAgain;
    case "sad":
      return m.room.presence.failed;
    case "asleep":
      return m.room.presence.dozing;
    case "happy":
    case "idle":
    case "listening":
      return "";
  }
}

/** Messages the server didn't take, with a way to send each again or let it go. */
function FailedSends({ store, pending }: { store: RoomStore; pending: readonly PendingMessage[] }) {
  const { assistant, room } = Route.useParams();
  const failed = pending.filter((message) => message.error !== undefined);
  if (failed.length === 0) return null;
  return (
    <ul className="flex shrink-0 flex-col gap-1">
      {failed.map((message) => (
        <li
          key={message.requestId}
          className="flex items-baseline justify-between gap-2 rounded border border-red-200 bg-red-50 px-3 py-1 text-sm"
        >
          <span className="min-w-0 [overflow-wrap:anywhere]">
            {m.room.chat.notSent(message.text)}{" "}
            <span className="text-red-700">({message.error})</span>
          </span>
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              onClick={() =>
                void clientFor(assistant)
                  .resend(room, message.requestId)
                  .catch(() => {})
              }
              className="underline"
            >
              {m.room.chat.retry}
            </button>
            <button
              type="button"
              onClick={() => store.dismiss(message.requestId)}
              className="text-stone-500 underline"
            >
              {m.room.chat.dismiss}
            </button>
          </span>
        </li>
      ))}
    </ul>
  );
}

function StatusLine({ status }: { status?: Status }) {
  if (status === undefined) return null;
  switch (status.kind) {
    case "retrying":
      return (
        <p className="text-sm text-amber-700">
          {m.room.status.retrying(status.attempt, status.error)}
        </p>
      );
    case "compacting":
      return <p className="text-sm text-stone-500">{m.room.status.compacting}</p>;
    case "compaction-failed":
      return (
        <p className="text-sm text-amber-700">{m.room.status.compactionFailed(status.error)}</p>
      );
  }
}

/** Where a new day starts in the chat. */
function DayDivider({ at }: { at: number }) {
  return (
    <div className="my-2 flex items-center gap-3 text-xs font-medium text-stone-500">
      <hr className="flex-1 border-stone-200" />
      {dayLabel(at)}
      <hr className="flex-1 border-stone-200" />
    </div>
  );
}

/** When a message was sent or an answer started, from `metadata.custom.at`. */
function timeOfMessage(message: MessageState): number | undefined {
  return (message.metadata.custom as { at?: number } | undefined)?.at;
}

function MessageRow({ message, assistant }: { message: MessageState; assistant: string }) {
  switch (message.role) {
    case "user":
      return <UserMessage message={message} />;
    case "assistant":
      return <AssistantMessage message={message} name={assistant} />;
    case "system":
      return <SystemMessage message={message} />;
  }
}

function UserMessage({ message }: { message: MessageState }) {
  const custom = message.metadata.custom as
    | { author?: string; mine?: boolean; private?: boolean }
    | undefined;
  const mine = custom?.mine ?? false;
  const at = timeOfMessage(message);
  return (
    <MessagePrimitive.Root>
      <div className={`flex flex-col ${mine ? "items-end" : "items-start"}`}>
        <div
          className={`max-w-[85%] min-w-0 rounded-2xl px-3 py-2 [overflow-wrap:anywhere] md:max-w-[75%] ${
            mine ? "bg-sky-600 text-white" : "bg-stone-200 text-stone-900"
          }`}
        >
          {!mine && (
            <p className="mb-0.5 text-xs font-medium text-stone-600">
              {custom?.author ?? m.room.chat.someone}
            </p>
          )}
          {custom?.private === true && <OnlyYou light={mine} />}
          <MessagePrimitive.Parts components={{ Text: TextPart }} />
        </div>
        {at !== undefined && (
          <time
            dateTime={new Date(at).toISOString()}
            className="mt-0.5 px-1 text-xs text-stone-400"
          >
            {timeLabel(at)}
          </time>
        )}
      </div>
    </MessagePrimitive.Root>
  );
}

/** How an answer to a fired nudge, or to what a watch found, looks. */
const PROMPTS = {
  nudge: {
    glyph: "🔔",
    card: "border-amber-200 border-l-amber-500 bg-amber-50",
    badge: "bg-amber-100 text-amber-800",
  },
  watch: {
    glyph: "👀",
    card: "border-indigo-200 border-l-indigo-500 bg-indigo-50",
    badge: "bg-indigo-100 text-indigo-800",
  },
} as const;

function AssistantMessage({
  message,
  name,
}: {
  message: Extract<MessageState, { role: "assistant" }>;
  name: string;
}) {
  const { assistant, room } = Route.useParams();
  const custom = message.metadata.custom as
    | { private?: boolean; promptedBy?: "nudge" | "watch" }
    | undefined;
  const secret = custom?.private === true;
  // An answer no one asked for just now stands out from the rest, by what prompted it.
  const prompt =
    custom?.promptedBy === undefined
      ? undefined
      : { ...PROMPTS[custom.promptedBy], label: m.room.chat.promptedBy[custom.promptedBy] };
  const at = timeOfMessage(message);
  return (
    <MessagePrimitive.Root>
      <div className="flex justify-start">
        <div
          className={`max-w-full min-w-0 rounded-2xl border border-l-4 px-3 py-2 [overflow-wrap:anywhere] md:max-w-[85%] ${
            prompt?.card ?? "border-stone-200 border-l-teal-500 bg-white"
          }`}
        >
          <p className="mb-1 flex flex-wrap items-baseline gap-2 text-xs">
            <span className="font-semibold text-stone-700">
              <Portrait
                appearance={use(LookContext)}
                size={18}
                className="mr-1 inline-block align-[-4px]"
              />
              {name}
            </span>
            {prompt !== undefined && (
              <span className={`rounded-full px-2 py-0.5 font-medium ${prompt.badge}`}>
                <span aria-hidden>{prompt.glyph} </span>
                {prompt.label}
              </span>
            )}
            {at !== undefined && (
              <time dateTime={new Date(at).toISOString()} className="text-stone-400">
                {timeLabel(at)}
              </time>
            )}
          </p>
          {secret && <OnlyYou />}
          <MessagePrimitive.Parts
            components={{
              Text: MarkdownText,
              tools: { Fallback: ToolCallPart },
            }}
          />
          {message.status.type !== "complete" && (
            <p className="text-xs text-stone-500">
              {statusLabel(message.status)}
              {message.status.type === "running" && (
                <>
                  {" · "}
                  <Link
                    to="/$assistant/$room/activity"
                    params={{ assistant, room }}
                    className="underline"
                  >
                    {m.room.chat.whatItsDoing}
                  </Link>
                </>
              )}
            </p>
          )}
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage({ message }: { message: MessageState }) {
  // See `toThreadMessageLike`: the line's kind and data are in `metadata.custom`. Nudges and
  // ended approvals are on the activity page instead.
  const custom = message.metadata.custom as { kind?: string; text?: string } | undefined;
  if (custom?.kind === "marker") return <hr className="border-stone-200" />;
  if (custom?.kind === "private")
    return (
      <p className="text-center text-sm text-violet-700 italic">
        <span aria-hidden>🔒 </span>
        {custom.text}
      </p>
    );
  return null;
}

/** Says a message is the reader's alone, so they know the others don't see it. */
function OnlyYou({ light = false }: { light?: boolean }) {
  return (
    <p className={`mb-0.5 text-xs font-medium ${light ? "text-sky-100" : "text-violet-700"}`}>
      {m.room.chat.onlyYou}
    </p>
  );
}

/** A value the server hid: someone else made it private, or it was forgotten. */
function Hidden({ placeholder }: { placeholder: string }) {
  return (
    <span
      title={m.room.chat.hiddenTitle(placeholder)}
      className="mx-0.5 inline-block rounded bg-stone-700 px-1.5 text-xs leading-5 text-white"
    >
      {m.room.chat.hidden}
    </span>
  );
}

/** Text with each placeholder shown as a hidden chip. */
function withHidden(text: string): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  for (const match of text.matchAll(PLACEHOLDER)) {
    out.push(text.slice(last, match.index));
    out.push(<Hidden key={match.index} placeholder={match[0]} />);
    last = match.index + match[0].length;
  }
  out.push(text.slice(last));
  return out;
}

function TextPart() {
  const { text } = useMessagePartText();
  return <p className="whitespace-pre-wrap">{withHidden(text)}</p>;
}

// No `@tailwindcss/typography`: everything else in this app is hand-rolled utility classes (see
// the plan's Decisions), so markdown elements get the same treatment instead of a `prose` class.
function MarkdownText() {
  return (
    <MarkdownTextPrimitive
      // Placeholders become links to `#hidden`, which `a` draws as a chip.
      preprocess={(text) => text.replace(PLACEHOLDER, (placeholder) => `[${placeholder}](#hidden)`)}
      components={{
        a: ({ href, children, ...rest }) =>
          href === "#hidden" ? (
            <Hidden placeholder={String(children)} />
          ) : (
            <a href={href} {...rest}>
              {children}
            </a>
          ),
      }}
      className="[&_a]:underline [&_blockquote]:border-l-2 [&_blockquote]:border-stone-300
        [&_blockquote]:pl-2 [&_blockquote]:text-stone-600 [&_code]:rounded [&_code]:bg-stone-200
        [&_code]:px-1 [&_h1]:text-lg [&_h1]:font-semibold [&_h2]:text-base [&_h2]:font-semibold
        [&_h3]:font-semibold [&_ol]:my-1 [&_ol]:list-decimal [&_ol]:pl-5 [&_p]:my-1 [&_pre]:my-1
        [&_img]:max-w-full [&_pre]:max-w-full [&_pre]:overflow-x-auto [&_pre]:rounded [&_pre]:bg-stone-200 [&_pre]:p-2 [&_pre]:[overflow-wrap:normal]
        [&_table]:block [&_table]:max-w-full [&_table]:overflow-x-auto
        [&_pre_code]:bg-transparent [&_pre_code]:px-0 [&_ul]:my-1 [&_ul]:list-disc [&_ul]:pl-5"
    />
  );
}

/** What `transcript` keeps of a tool: a login the browser waits for, or a pending approval. */
function ToolCallPart({ toolName, artifact }: ToolCallMessagePartProps) {
  const { assistant, room } = Route.useParams();
  if (toolName === "browse" && (artifact as { needsLogin?: boolean } | undefined)?.needsLogin)
    return (
      <p className="my-1 text-sm">
        <Link
          to="/$assistant/$room/browser"
          params={{ assistant, room }}
          className="inline-block rounded bg-sky-700 px-3 py-1 text-white hover:bg-sky-600"
        >
          {m.room.chat.openBrowser}
        </Link>
      </p>
    );
  const approval = (artifact as { approval?: string } | undefined)?.approval;
  if (typeof approval === "string") return <ApprovalCard id={approval} />;
  return null;
}

function statusLabel(status: MessageStatus): string {
  switch (status.type) {
    case "running":
      return m.room.answer.working;
    case "requires-action":
      return status.reason;
    case "incomplete":
      return status.reason === "cancelled" ? m.room.answer.stopped : m.room.answer.failed;
    case "complete":
      return "";
  }
}

/** Approve and Deny for one approval, where the tool asked for it in the chat. */
function ApprovalCard({ id }: { id: string }) {
  const approval = useContext(ViewContext)?.approvals.find((item) => item.id === id);
  if (approval === undefined)
    return <p className="text-sm text-stone-500">{m.room.chat.askedForApproval}</p>;
  return (
    <div className="my-1 rounded border border-amber-300 bg-amber-50 px-3 py-2 text-sm">
      <ApprovalRow approval={approval} />
    </div>
  );
}

function ApprovalRow({ approval }: { approval: Approval }) {
  const { assistant, room } = Route.useParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(approve: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await clientFor(assistant).api.decide(room, approval.id, approve);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere]">{approval.summary}</span>
        {approval.status === "pending" ? (
          <span className="flex shrink-0 gap-2">
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(true)}
              className="rounded bg-emerald-700 px-2 py-0.5 text-white disabled:opacity-50"
            >
              {m.room.approvals.approve}
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
              className="rounded border border-stone-300 px-2 py-0.5 disabled:opacity-50"
            >
              {m.room.approvals.deny}
            </button>
          </span>
        ) : (
          <span className="shrink-0 text-stone-500">
            {m.room.approvals.status[approval.status]}
            {approval.decidedBy ? m.room.approvals.by(approval.decidedBy.displayName) : ""}
          </span>
        )}
      </div>
      {error !== undefined && <p className="text-red-700">{error}</p>}
    </div>
  );
}

/** What waits for someone in the room to approve it; hidden while nothing does. */
function ApprovalsPanel({ approvals }: { approvals: readonly Approval[] }) {
  const pending = approvals.filter((item) => item.status === "pending");
  if (pending.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded border border-amber-300 bg-amber-50 p-3">
      <h3 className="text-sm font-medium tracking-wide text-amber-800 uppercase">
        {m.room.approvals.title}
      </h3>
      {pending.map((approval) => (
        <ApprovalRow key={approval.id} approval={approval} />
      ))}
    </section>
  );
}

function MemoryPanel({ view }: { view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const mine = useQuery({
    queryKey: ["my-memory", assistant],
    queryFn: () => clientFor(assistant).api.myMemory(),
  });
  const [text, setText] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value === "") return;
    setBusy(true);
    setError(undefined);
    try {
      await clientFor(assistant).api.remember(room, value);
      setText("");
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function onForget(fact: RoomView["memory"][number]) {
    setError(undefined);
    try {
      if (fact.owner === undefined) await clientFor(assistant).api.forget(room, fact.id);
      else await clientFor(assistant).api.forgetForMe(fact.id);
      await mine.refetch();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function onShare(shared: boolean) {
    setError(undefined);
    try {
      await clientFor(assistant).api.shareMyMemory(shared);
      await mine.refetch();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.room.memory.title}
      </h3>
      {view.memory.length === 0 && <p className="text-sm text-stone-500">{m.room.memory.empty}</p>}
      <ul className="flex flex-col gap-1">
        {view.memory.map((fact) => (
          <li
            key={`${fact.owner?.id ?? ""}/${fact.id}`}
            className="flex items-baseline justify-between gap-2 text-sm"
          >
            <span>
              {fact.text}
              {fact.owner !== undefined && (
                <span className="text-stone-500">{m.room.memory.own(fact.owner.displayName)}</span>
              )}
              {fact.privateTo !== undefined && (
                <span className="text-violet-700">{m.room.memory.onlyYou}</span>
              )}
            </span>
            {(fact.owner === undefined || fact.owner.id === me) && (
              <button
                type="button"
                onClick={() => void onForget(fact)}
                className="shrink-0 text-stone-500 underline"
              >
                {m.room.memory.forget}
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={m.room.memory.placeholder}
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ""}
          className="shrink-0 rounded border px-2 text-sm disabled:opacity-50"
        >
          {m.room.memory.add}
        </button>
      </form>
      {mine.data !== undefined && (
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={mine.data.shared}
            onChange={(event) => void onShare(event.target.checked)}
          />
          {m.room.memory.share(mine.data.facts.length)}
        </label>
      )}
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

/** Whose location the assistant knows here, above the chat, so everyone in the room sees it. */
function SharingLocation({ view }: { view: RoomView }) {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id;
  const sharing = view.sharingLocation ?? [];
  if (sharing.length === 0) return null;
  const names = sharing.map((player) => (player.id === me ? m.room.you : player.displayName));
  return (
    <p className="mb-2 rounded border border-sky-200 bg-sky-50 px-3 py-1 text-sm text-sky-900">
      📍 {m.room.sharingLocation(names, sharing.length === 1 && sharing[0]?.id !== me)}
    </p>
  );
}

/**
 * Whether the assistant knows where the player is in this room. A personal room always has it
 * once a device shared it; a shared room only once the player says so here, and then for anyone
 * in the room.
 */
function LocationPanel({ view }: { view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id;
  const personal = useQuery({
    queryKey: [assistant, "personal"],
    queryFn: () => clientFor(assistant).api.personal(),
  });
  const queryClient = useQueryClient();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  if (view.room.kind === "lobby" || me === undefined) return null;
  const sharing = (view.sharingLocation ?? []).some((player) => player.id === me);
  const known = personal.data?.location !== undefined;

  async function onShare(shared: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      queryClient.setQueryData(
        [assistant, "personal"],
        await clientFor(assistant).api.shareLocation(room, shared),
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.room.location.title}
      </h3>
      {view.room.kind === "personal" ? (
        <p className="text-sm text-stone-600">
          {known ? m.room.location.known : m.room.location.notShared}
        </p>
      ) : (
        <>
          <label className="flex items-center gap-2 text-sm text-stone-600">
            <input
              type="checkbox"
              checked={sharing}
              disabled={busy}
              onChange={(event) => void onShare(event.target.checked)}
            />
            {m.room.location.share}
          </label>
          <p className="text-xs text-stone-500">
            {m.room.location.explain}
            {sharing && !known && ` ${m.room.location.notYet}`}
          </p>
        </>
      )}
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

/**
 * Values only this player sees: everyone else, and the model, get a placeholder wherever they
 * show. Hiding one here works in every room; forgetting one drops it for good.
 */
function PrivateValuesPanel() {
  const { assistant } = Route.useParams();
  const values = useQuery({
    queryKey: [assistant, "private-values"],
    queryFn: () => clientFor(assistant).api.privateValues(),
  });
  const [text, setText] = useState("");
  const [error, setError] = useState<string>();

  async function run(action: () => Promise<unknown>) {
    setError(undefined);
    try {
      await action();
      await values.refetch();
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = text.trim();
    if (value.length < 2) return;
    await run(async () => {
      await clientFor(assistant).api.protect(value, { private: true });
      setText("");
    });
  }

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.room.privateValues.title}
      </h3>
      {values.data?.length === 0 && (
        <p className="text-sm text-stone-500">{m.room.privateValues.empty}</p>
      )}
      <ul className="flex flex-col gap-1">
        {values.data?.map((value) => (
          <li key={value.placeholder} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 [overflow-wrap:anywhere]">{value.value}</span>
            <button
              type="button"
              title={m.room.privateValues.forgetTitle}
              onClick={() =>
                void run(() => clientFor(assistant).api.forgetValue(value.placeholder))
              }
              className="shrink-0 text-stone-500 underline"
            >
              {m.room.privateValues.forget}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={m.room.privateValues.placeholder}
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={text.trim().length < 2}
          className="shrink-0 rounded border px-2 text-sm disabled:opacity-50"
        >
          {m.room.privateValues.hide}
        </button>
      </form>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

function NudgesPanel({ view }: { view: RoomView }) {
  const { assistant } = Route.useParams();
  const [error, setError] = useState<string>();

  async function onCancel(id: string) {
    setError(undefined);
    try {
      await clientFor(assistant).api.cancelNudge(id);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  // Nudges can only be scheduled from chat, not this panel, so there's nothing to show for an
  // empty list beyond the chat itself already being silent about it.
  if (view.nudges.length === 0) return null;

  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.room.nudges.title}
      </h3>
      <ul className="flex flex-col gap-1">
        {view.nudges.map((nudge) => (
          <li key={nudge.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span>
              {new Date(nudge.fireAt).toLocaleString(dateLocale())} — {nudge.message}
              {nudge.privateTo !== undefined && (
                <span className="text-violet-700">{m.room.nudges.onlyYou}</span>
              )}
            </span>
            <button
              type="button"
              onClick={() => void onCancel(nudge.id)}
              className="shrink-0 text-stone-500 underline"
            >
              {m.common.cancel}
            </button>
          </li>
        ))}
      </ul>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

/** Which installed extensions this room uses; anyone in the room may change it. */
function ExtensionsPanel() {
  const { assistant, room } = Route.useParams();
  const queryClient = useQueryClient();
  const key = [assistant, "room-extensions", room];
  const extensions = useQuery({
    queryKey: key,
    queryFn: () => clientFor(assistant).api.roomExtensions(room),
  });
  const [error, setError] = useState<string>();

  async function set(name: string, enabled: boolean | null) {
    setError(undefined);
    try {
      await clientFor(assistant).api.setRoomExtension(room, name, enabled);
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  if (extensions.data === undefined || extensions.data.length === 0) return null;
  return (
    <section className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.room.extensions.title}
      </h3>
      <ul className="flex flex-col gap-1">
        {extensions.data.map((extension) => (
          <li key={extension.name} className="flex items-center justify-between gap-2 text-sm">
            <label
              className="flex min-w-0 items-center gap-2"
              title={
                extension.error === undefined
                  ? extension.description
                  : m.room.extensions.failedTitle(extension.error)
              }
            >
              <input
                type="checkbox"
                className="size-4 shrink-0"
                checked={extension.enabled}
                disabled={extension.error !== undefined}
                onChange={(event) => void set(extension.name, event.target.checked)}
              />
              <span className="truncate">{extension.name}</span>
              {extension.error !== undefined && (
                <span className="shrink-0 text-xs text-red-700">{m.room.extensions.failed}</span>
              )}
            </label>
            {extension.error === undefined && extension.enabled !== extension.byDefault && (
              <button
                type="button"
                onClick={() => void set(extension.name, null)}
                className="shrink-0 text-xs text-stone-500 underline"
              >
                {m.room.extensions.reset}
              </button>
            )}
          </li>
        ))}
      </ul>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
