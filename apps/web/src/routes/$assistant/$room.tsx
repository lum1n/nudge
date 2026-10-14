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
import type {
  Approval,
  PendingMessage,
  RoomState,
  RoomStore,
  RoomView,
  Status,
} from "@nudge/client";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { createContext, type FormEvent, useCallback, useContext, useEffect, useState } from "react";
import { clientFor, forgetToken, useConnection, useRoom } from "../../api.ts";
import {
  appendText,
  buildQueueAdapter,
  type Lane,
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

  return (
    <ViewContext value={view}>
      <div className="flex h-full min-h-0">
        <aside className="flex w-80 shrink-0 flex-col gap-4 overflow-y-auto border-r border-stone-200 p-4">
          <div>
            <h2 className="text-lg font-medium">{view.room.name}</h2>
            <p className="text-sm text-stone-600">
              {view.room.members.map((member) => member.displayName).join(", ")}
            </p>
          </div>
          <div className="flex gap-2">
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
          </div>
          <ApprovalsPanel approvals={view.approvals} />
          <MemoryPanel view={view} />
          <NudgesPanel view={view} />
        </aside>
        <div className="flex min-h-0 flex-1 flex-col p-4">
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

function Chat({ store, state, view }: { store: RoomStore; state: RoomState; view: RoomView }) {
  const { assistant, room } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const dispatch = useCallback(
    (message: AppendMessage, lane: Lane) => {
      const text = appendText(message).trim();
      if (text === "") return;
      // A failed send stays in the store's `pending` with its error; the page offers it again.
      clientFor(assistant)
        .send(room, text, lane === "steer" ? { whenBusy: "steer" } : {})
        .catch(() => {});
    },
    [assistant, room],
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
        <ThreadPrimitive.Viewport className="flex min-h-0 flex-1 flex-col gap-2 overflow-y-auto">
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
            {view.live.running ? (
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
          <span>
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
  const custom = message.metadata.custom as { author?: string; mine?: boolean } | undefined;
  const mine = custom?.mine ?? false;
  return (
    <MessagePrimitive.Root>
      <div className={`flex ${mine ? "justify-end" : "justify-start"}`}>
        <div
          className={`max-w-[75%] rounded-2xl px-3 py-2 ${
            mine ? "bg-sky-600 text-white" : "bg-stone-200 text-stone-900"
          }`}
        >
          {!mine && (
            <p className="mb-0.5 text-xs font-medium text-stone-600">
              {custom?.author ?? "Someone"}
            </p>
          )}
          <MessagePrimitive.Parts components={{ Text: TextPart }} />
        </div>
      </div>
    </MessagePrimitive.Root>
  );
}

function AssistantMessage({ message }: { message: Extract<MessageState, { role: "assistant" }> }) {
  return (
    <MessagePrimitive.Root>
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl border border-stone-200 bg-white px-3 py-2">
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
    return <p className="text-center text-sm text-stone-600 italic">Nudge: {custom.text}</p>;
  if (custom?.kind === "marker") return <hr className="border-stone-200" />;
  if (custom?.kind === "approval") {
    const data = custom as { summary: string; status: string; decidedBy?: string };
    return (
      <p className="text-center text-sm text-stone-600 italic">
        {data.decidedBy ?? "Someone"} {data.status === "denied" ? "denied" : "approved"}{" "}
        {data.summary}
        {data.status === "failed" ? " — it failed" : ""}
      </p>
    );
  }
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
  const approval = (artifact as { approval?: string } | undefined)?.approval;
  if (typeof approval === "string") return <ApprovalCard id={approval} />;
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
        <span>{approval.summary}</span>
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
