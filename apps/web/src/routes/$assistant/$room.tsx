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
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useCallback, useEffect, useMemo, useState } from "react";
import {
  appendText,
  buildQueueAdapter,
  type PendingSend,
  toThreadMessageLike,
} from "../../assistant-runtime.ts";
import { forgetToken } from "../../api.ts";
import { meQuery, roomQuery } from "../../queries.ts";
import { type RoomSocket, useRoomSocket, useRoomState } from "../../room-socket.ts";
import { type RoomStatus, ThreadReader } from "../../thread.ts";

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

/** `CLOSE.unauthorized` in `@nudge/server`'s protocol: the token the tab has no longer works. */
const UNAUTHORIZED = 4401;

function Room() {
  const { assistant, room } = Route.useParams();
  const query = useQuery(roomQuery(assistant, room));
  const socket = useRoomSocket(assistant, room);
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
      <div>
        <h2 className="text-lg font-medium">{info.name}</h2>
        <p className="text-sm text-stone-600">
          {members.map((member) => member.displayName).join(", ")}
        </p>
      </div>
      {socket === undefined ? (
        <p className="text-stone-500">Connecting…</p>
      ) : state.status === "closed" ? (
        <p className="text-red-700">Disconnected{state.error ? `: ${state.error}` : ""}.</p>
      ) : (
        <Chat socket={socket} />
      )}
    </section>
  );
}

function Chat({ socket }: { socket: RoomSocket }) {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const state = useRoomState(socket);
  const reader = useMemo(() => new ThreadReader(), [socket]);
  const thread = useMemo(
    () => (state.view === undefined ? undefined : reader.read(state.view, me)),
    [reader, state.view, me],
  );
  const { pending, dispatch } = usePendingSends(socket);

  const runtime = useExternalStoreRuntime({
    messages: thread?.messages ?? [],
    convertMessage: toThreadMessageLike,
    isRunning: thread?.isRunning ?? false,
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
            Text: TextPart,
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

function ReasoningPart() {
  return <MessagePartPrimitive.Text component="p" className="text-sm text-stone-500" />;
}

function ToolCallPart({ toolName, status, result, isError }: ToolCallMessagePartProps) {
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
