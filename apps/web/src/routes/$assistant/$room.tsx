import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useMemo, useState } from "react";
import { meQuery, roomQuery } from "../../queries.ts";
import { type RoomSocket, useRoomSocket, useRoomState } from "../../room-socket.ts";
import { type ThreadMessage, ThreadReader } from "../../thread.ts";

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

function Room() {
  const { assistant, room } = Route.useParams();
  const query = useQuery(roomQuery(assistant, room));
  const socket = useRoomSocket(assistant, room);
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
      {socket && <Chat socket={socket} />}
    </section>
  );
}

// A plain list until the assistant-ui thread replaces it.
function Chat({ socket }: { socket: RoomSocket }) {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant)).data?.player.id ?? "";
  const state = useRoomState(socket);
  const reader = useMemo(() => new ThreadReader(), [socket]);
  const thread = state.view === undefined ? undefined : reader.read(state.view, me);
  const [draft, setDraft] = useState("");

  const send = (event: FormEvent) => {
    event.preventDefault();
    if (draft.trim() === "") return;
    void socket.submit(draft);
    setDraft("");
  };

  if (state.status === "closed")
    return <p className="text-red-700">Disconnected{state.error ? `: ${state.error}` : ""}.</p>;
  if (thread === undefined) return <p className="text-stone-500">Connecting…</p>;
  return (
    <div className="flex flex-col gap-3">
      <ol className="flex flex-col gap-2" data-testid="messages">
        {thread.messages.map((message) => (
          <li key={message.id}>
            <MessageRow message={message} />
          </li>
        ))}
      </ol>
      {thread.queue.map((item) => (
        <p key={item.id} className="text-sm text-stone-500">
          Waiting: {item.author?.displayName ?? "Nudge"}: {item.text}
        </p>
      ))}
      <form onSubmit={send} className="flex gap-2">
        <input
          value={draft}
          onChange={(event) => setDraft(event.target.value)}
          className="flex-1 rounded border border-stone-300 px-2 py-1"
          placeholder="Message"
        />
        {thread.isRunning ? (
          <button type="button" onClick={() => socket.abort()} className="rounded border px-3">
            Stop
          </button>
        ) : (
          <button type="submit" className="rounded border px-3">
            Send
          </button>
        )}
      </form>
    </div>
  );
}

function MessageRow({ message }: { message: ThreadMessage }) {
  switch (message.role) {
    case "user":
      return (
        <p>
          <b>{message.mine ? "You" : (message.author?.displayName ?? "Someone")}:</b> {message.text}
        </p>
      );
    case "nudge":
      return <p className="italic">Nudge: {message.text}</p>;
    case "marker":
      return <hr />;
    case "assistant":
      return (
        <div className="rounded bg-stone-100 px-3 py-2">
          {message.parts.map((part, index) =>
            part.type === "tool-call" ? (
              <p key={index} className="text-sm text-stone-500">
                {part.toolName} — {part.status}
              </p>
            ) : (
              <p key={index} className={part.type === "reasoning" ? "text-sm text-stone-500" : ""}>
                {part.text}
              </p>
            ),
          )}
          {message.status !== "done" && <p className="text-xs text-stone-500">{message.status}</p>}
        </div>
      );
  }
}
