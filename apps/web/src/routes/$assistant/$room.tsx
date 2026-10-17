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
  useState,
} from "react";
import { clientFor, forgetToken, useConnection, useRoom } from "../../api.ts";
import {
  appendText,
  buildQueueAdapter,
  type Lane,
  PLACEHOLDER,
  toThreadMessageLike,
} from "../../assistant-runtime.ts";
import { meQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

/** `CLOSE.unauthorized` in the protocol: the token the tab has no longer works. */
const UNAUTHORIZED = 4401;

/** The room's view, for the parts deep in the chat that need it, such as approval cards. */
const ViewContext = createContext<RoomView | undefined>(undefined);

function Room() {
  const { assistant, room } = Route.useParams();
  const held = useRoom(assistant, room);
  const connection = useConnection(assistant);
  const navigate = useNavigate();
  // Below `md` the sidebar is a drawer over the chat.
  const [drawer, setDrawer] = useState(false);

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
        {held.state.reason === "removed" ? "You were removed from this room." : "No such room."}
      </p>
    );
  if (held === undefined || view === undefined)
    return (
      <p className="p-4 text-stone-500">
        {connection.kind === "closed" ? `Disconnected: ${connection.reason}.` : "Connecting…"}
      </p>
    );

  const waiting = view.approvals.filter((item) => item.status === "pending").length;
  return (
    <ViewContext value={view}>
      <div className="relative flex h-full min-h-0">
        {drawer && (
          <button
            type="button"
            aria-label="Close the room's details"
            onClick={() => setDrawer(false)}
            className="fixed inset-0 z-20 bg-stone-900/30 md:hidden"
          />
        )}
        <aside
          className={`${
            drawer ? "fixed inset-y-0 left-0 z-30 flex w-[min(22rem,88vw)] shadow-xl" : "hidden"
          } flex-col gap-4 overflow-y-auto border-r border-stone-200 bg-stone-50 p-4 pt-[max(1rem,env(safe-area-inset-top))] pb-[max(1rem,env(safe-area-inset-bottom))] md:static md:flex md:w-80 md:shrink-0 md:pt-4 md:pb-4 md:shadow-none`}
        >
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <RoomName view={view} />
              <p className="text-sm text-stone-600">
                {view.room.members.map((member) => member.displayName).join(", ")}
              </p>
            </div>
            <button
              type="button"
              onClick={() => setDrawer(false)}
              className="shrink-0 rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-200 md:hidden"
            >
              Close
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            <Link
              to="/$assistant/$room/browser"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              Browser
            </Link>
            <Link
              to="/$assistant/$room/connectors"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              Connectors
            </Link>
            <Link
              to="/$assistant/$room/lists"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              Lists
            </Link>
            <Link
              to="/$assistant/$room/documents"
              params={{ assistant, room }}
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              Documents
            </Link>
            <Link
              to="/$assistant/$room/model"
              params={{ assistant, room }}
              title="What the model sees of this room"
              className="rounded border border-stone-300 px-3 py-1 text-sm hover:bg-stone-100"
            >
              Model view
            </Link>
          </div>
          <ApprovalsPanel approvals={view.approvals} />
          <MemoryPanel view={view} />
          <PrivateValuesPanel />
          <NudgesPanel view={view} />
          <ExtensionsPanel />
        </aside>
        <div className="flex min-h-0 min-w-0 flex-1 flex-col px-2 pt-2 pb-[max(0.5rem,env(safe-area-inset-bottom))] sm:px-4 sm:pt-4 sm:pb-4">
          <div className="mb-2 flex items-center justify-between gap-2 md:hidden">
            <h2 className="truncate font-medium">{view.room.name}</h2>
            <button
              type="button"
              onClick={() => setDrawer(true)}
              className="flex shrink-0 items-center gap-1.5 rounded border border-stone-300 bg-white px-3 py-1 text-sm"
            >
              Room
              {waiting > 0 && (
                <span className="rounded-full bg-amber-600 px-1.5 text-xs text-white">
                  {waiting}
                </span>
              )}
            </button>
          </div>
          {connection.kind === "waiting" ? (
            <p className="text-sm text-stone-500">Reconnecting…</p>
          ) : connection.kind === "closed" ? (
            <p className="text-sm text-red-700">Disconnected: {connection.reason}.</p>
          ) : null}
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
            type="button"
            onClick={() => setDraft(view.room.name)}
            className="text-sm text-stone-500 hover:text-stone-800"
          >
            Rename
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
          aria-label="Room name"
          autoFocus
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || draft.trim() === ""}
          className="rounded border px-2 py-1 text-sm disabled:opacity-50"
        >
          Save
        </button>
        <button
          type="button"
          onClick={() => {
            setDraft(undefined);
            setError(undefined);
          }}
          className="rounded px-2 py-1 text-sm text-stone-600 hover:bg-stone-200"
        >
          Cancel
        </button>
      </div>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </form>
  );
}

function Chat({ store, state, view }: { store: RoomStore; state: RoomState; view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  // Only in a shared room is there anyone to keep a message from.
  const shared = view.room.kind !== "personal";
  const [secret, setSecret] = useState(false);
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

  const runtime = useExternalStoreRuntime({
    messages: state.timeline,
    convertMessage,
    isRunning: view.live.running,
    hasEarlier: state.canLoadEarlier,
    onLoadEarlier: () => store.loadEarlier(),
    onNew: async (message) => dispatch(message, message.steer ? "steer" : "queue"),
    onCancel: async () => {
      await clientFor(assistant).api.abort(room);
    },
    queue: buildQueueAdapter(view.queue, state.pending, dispatch),
  });

  return (
    <AssistantRuntimeProvider runtime={runtime}>
      <div className="flex h-full min-h-0 flex-col gap-3">
        <StatusLine status={view.live.status} />
        <ThreadPrimitive.Viewport className="flex min-h-0 min-w-0 flex-1 flex-col gap-2 overflow-x-hidden overflow-y-auto">
          <ThreadPrimitive.LoadEarlier className="self-center text-sm text-stone-500 underline disabled:text-stone-300 disabled:no-underline">
            Load earlier
          </ThreadPrimitive.LoadEarlier>
          {state.earlierError !== undefined && (
            <p className="self-center text-sm text-red-700">{state.earlierError}</p>
          )}
          <ThreadPrimitive.Messages>
            {({ message }) => <MessageRow message={message} />}
          </ThreadPrimitive.Messages>
        </ThreadPrimitive.Viewport>
        <FailedSends store={store} pending={state.pending} />
        <ComposerPrimitive.Root className="flex shrink-0 flex-col gap-2">
          <ComposerPrimitive.Queue>
            {({ queueItem }) => (
              <p key={queueItem.id} className="text-sm [overflow-wrap:anywhere] text-stone-500">
                Waiting: {queueItem.prompt}
              </p>
            )}
          </ComposerPrimitive.Queue>
          <div className="flex gap-2">
            {shared && (
              <button
                type="button"
                aria-pressed={secret}
                onClick={() => setSecret((on) => !on)}
                title="Only you see a private message and the answer to it; the others see that there was one"
                className={`shrink-0 rounded border px-2 text-sm ${
                  secret ? "border-violet-700 bg-violet-700 text-white" : "bg-white text-stone-600"
                }`}
              >
                Private
              </button>
            )}
            <ComposerPrimitive.Input
              placeholder={
                secret && shared ? "Private message: only you see it and the answer" : "Message"
              }
              className="max-h-40 min-w-0 flex-1 resize-none rounded border border-stone-300 bg-white px-2 py-1.5"
            />
            {view.live.running ? (
              <ComposerPrimitive.Cancel className="shrink-0 rounded border bg-white px-3">
                Stop
              </ComposerPrimitive.Cancel>
            ) : (
              <ComposerPrimitive.Send className="shrink-0 rounded border bg-white px-3">
                Send
              </ComposerPrimitive.Send>
            )}
          </div>
        </ComposerPrimitive.Root>
      </div>
    </AssistantRuntimeProvider>
  );
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
            Not sent: {message.text} <span className="text-red-700">({message.error})</span>
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
              Retry
            </button>
            <button
              type="button"
              onClick={() => store.dismiss(message.requestId)}
              className="text-stone-500 underline"
            >
              Dismiss
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
  const custom = message.metadata.custom as
    | { author?: string; mine?: boolean; private?: boolean }
    | undefined;
  const mine = custom?.mine ?? false;
  return (
    <MessagePrimitive.Root>
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[85%] min-w-0 rounded-2xl px-3 py-2 [overflow-wrap:anywhere] md:max-w-[75%] ${
            mine ? "bg-sky-600 text-white" : "bg-stone-200 text-stone-900"
          }`}
        >
          {!mine && (
            <p className="mb-0.5 text-xs font-medium text-stone-600">
              {custom?.author ?? "Someone"}
            </p>
          )}
          {custom?.private === true && <OnlyYou light={mine} />}
          <MessagePrimitive.Parts components={{ Text: TextPart }} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ message }: { message: Extract<MessageState, { role: "assistant" }> }) {
  const secret = (message.metadata.custom as { private?: boolean } | undefined)?.private === true;
  return (
    <MessagePrimitive.Root>
      <div className="flex justify-start">
        <div className="max-w-full min-w-0 rounded-2xl border border-stone-200 bg-white px-3 py-2 [overflow-wrap:anywhere] md:max-w-[85%]">
          {secret && <OnlyYou />}
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
      </div>
    </MessagePrimitive.Root>
  );
}

function SystemMessage({ message }: { message: MessageState }) {
  // See `toThreadMessageLike`: the line's kind and data are in `metadata.custom`.
  const custom = message.metadata.custom as { kind?: string; text?: string } | undefined;
  if (custom?.kind === "nudge")
    return (
      <p className="text-center text-sm [overflow-wrap:anywhere] text-stone-600 italic">
        Nudge: {custom.text}
      </p>
    );
  if (custom?.kind === "marker") return <hr className="border-stone-200" />;
  if (custom?.kind === "private")
    return (
      <p className="text-center text-sm text-violet-700 italic">
        <span aria-hidden>🔒 </span>
        {custom.text}
      </p>
    );
  if (custom?.kind === "approval") {
    const data = custom as { summary: string; status: string; decidedBy?: string };
    return (
      <p className="text-center text-sm [overflow-wrap:anywhere] text-stone-600 italic">
        {data.decidedBy ?? "Someone"} {data.status === "denied" ? "denied" : "approved"}{" "}
        {data.summary}
        {data.status === "failed" ? " — it failed" : ""}
      </p>
    );
  }
  return null;
}

/** Says a message is the reader's alone, so they know the others don't see it. */
function OnlyYou({ light = false }: { light?: boolean }) {
  return (
    <p className={`mb-0.5 text-xs font-medium ${light ? "text-sky-100" : "text-violet-700"}`}>
      🔒 Only you
    </p>
  );
}

/** A value the server hid: someone else made it private, or it was forgotten. */
function Hidden({ placeholder }: { placeholder: string }) {
  return (
    <span
      title={`Hidden from you (${placeholder})`}
      className="mx-0.5 inline-block rounded bg-stone-700 px-1.5 text-xs leading-5 text-white"
    >
      hidden
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
  const approval = (artifact as { approval?: string } | undefined)?.approval;
  if (typeof approval === "string") return <ApprovalCard id={approval} />;
  const progress = (artifact as { progress?: string } | undefined)?.progress;
  return (
    <p className="text-sm [overflow-wrap:anywhere] text-stone-500">
      {toolName} —{" "}
      {result !== undefined
        ? isError
          ? "failed"
          : "done"
        : typeof progress === "string"
          ? progress
          : status.type}
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

/** Approve and Deny for one approval, where the tool asked for it in the chat. */
function ApprovalCard({ id }: { id: string }) {
  const approval = useContext(ViewContext)?.approvals.find((item) => item.id === id);
  if (approval === undefined) return <p className="text-sm text-stone-500">Asked for approval</p>;
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
              Approve
            </button>
            <button
              type="button"
              disabled={busy}
              onClick={() => void decide(false)}
              className="rounded border border-stone-300 px-2 py-0.5 disabled:opacity-50"
            >
              Deny
            </button>
          </span>
        ) : (
          <span className="shrink-0 text-stone-500">
            {approval.status}
            {approval.decidedBy ? ` by ${approval.decidedBy.displayName}` : ""}
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
        Waiting for approval
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
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Memory</h3>
      {view.memory.length === 0 && (
        <p className="text-sm text-stone-500">Nothing remembered yet.</p>
      )}
      <ul className="flex flex-col gap-1">
        {view.memory.map((fact) => (
          <li
            key={`${fact.owner?.id ?? ""}/${fact.id}`}
            className="flex items-baseline justify-between gap-2 text-sm"
          >
            <span>
              {fact.text}
              {fact.owner !== undefined && (
                <span className="text-stone-500"> · {fact.owner.displayName}'s own</span>
              )}
              {fact.privateTo !== undefined && (
                <span className="text-violet-700"> · 🔒 only you</span>
              )}
            </span>
            {(fact.owner === undefined || fact.owner.id === me) && (
              <button
                type="button"
                onClick={() => void onForget(fact)}
                className="shrink-0 text-stone-500 underline"
              >
                Forget
              </button>
            )}
          </li>
        ))}
      </ul>
      <form onSubmit={(event) => void submit(event)} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder="Remember something"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={busy || text.trim() === ""}
          className="shrink-0 rounded border px-2 text-sm disabled:opacity-50"
        >
          Add
        </button>
      </form>
      {mine.data !== undefined && (
        <label className="flex items-center gap-2 text-sm text-stone-600">
          <input
            type="checkbox"
            checked={mine.data.shared}
            onChange={(event) => void onShare(event.target.checked)}
          />
          Share my own facts ({mine.data.facts.length}) with all my rooms
        </label>
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
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Only you see</h3>
      {values.data?.length === 0 && (
        <p className="text-sm text-stone-500">
          Hide an address, a name or a number: others and the model see a placeholder.
        </p>
      )}
      <ul className="flex flex-col gap-1">
        {values.data?.map((value) => (
          <li key={value.placeholder} className="flex items-baseline justify-between gap-2 text-sm">
            <span className="min-w-0 [overflow-wrap:anywhere]">{value.value}</span>
            <button
              type="button"
              title="Forget it for good: from now on everyone sees only the placeholder"
              onClick={() =>
                void run(() => clientFor(assistant).api.forgetValue(value.placeholder))
              }
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
          placeholder="Hide a value"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={text.trim().length < 2}
          className="shrink-0 rounded border px-2 text-sm disabled:opacity-50"
        >
          Hide
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
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Nudges</h3>
      <ul className="flex flex-col gap-1">
        {view.nudges.map((nudge) => (
          <li key={nudge.id} className="flex items-baseline justify-between gap-2 text-sm">
            <span>
              {new Date(nudge.fireAt).toLocaleString()} — {nudge.message}
              {nudge.privateTo !== undefined && (
                <span className="text-violet-700"> · 🔒 only you</span>
              )}
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
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Extensions</h3>
      <ul className="flex flex-col gap-1">
        {extensions.data.map((extension) => (
          <li key={extension.name} className="flex items-center justify-between gap-2 text-sm">
            <label className="flex min-w-0 items-center gap-2" title={extension.description}>
              <input
                type="checkbox"
                className="size-4 shrink-0"
                checked={extension.enabled}
                onChange={(event) => void set(extension.name, event.target.checked)}
              />
              <span className="truncate">{extension.name}</span>
            </label>
            {extension.enabled !== extension.byDefault && (
              <button
                type="button"
                onClick={() => void set(extension.name, null)}
                className="shrink-0 text-xs text-stone-500 underline"
              >
                Reset
              </button>
            )}
          </li>
        ))}
      </ul>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}
