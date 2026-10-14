import type { RoomKind } from "@nudge/client";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { clientFor, useHome } from "../../api.ts";
import { type PushState, usePush } from "../../push.ts";

export const Route = createFileRoute("/$assistant/")({ component: Rooms });

const KIND_LABEL: Record<RoomKind, string> = {
  lobby: "Everyone",
  personal: "Personal",
  shared: "Shared",
};

function Rooms() {
  const { assistant } = Route.useParams();
  const home = useHome(assistant);
  const navigate = useNavigate();
  const [name, setName] = useState("");
  const [members, setMembers] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function enter(open: () => Promise<{ id: string }>): Promise<boolean> {
    setBusy(true);
    setError(undefined);
    try {
      const room = await open();
      await navigate({ to: "/$assistant/$room", params: { assistant, room: room.id } });
      return true;
    } catch (caught) {
      setError((caught as Error).message);
      return false;
    } finally {
      setBusy(false);
    }
  }

  async function create(event: FormEvent) {
    event.preventDefault();
    if (name.trim() === "") return;
    const ids = members
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id !== "");
    if (
      await enter(() =>
        clientFor(assistant).api.createRoom({
          name: name.trim(),
          ...(ids.length === 0 ? {} : { members: ids }),
        }),
      )
    ) {
      setName("");
      setMembers("");
    }
  }

  const view = home?.view;
  if (view === undefined) return <p className="p-4 text-stone-500">Loading…</p>;
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Rooms</h2>
        <ul className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
          {view.rooms.map(({ room, running, pendingApprovals }) => (
            <li key={room.id}>
              <Link
                to="/$assistant/$room"
                params={{ assistant, room: room.id }}
                className="flex items-baseline justify-between gap-2 px-4 py-3 hover:bg-stone-100"
              >
                <span>{room.name}</span>
                <span className="flex items-baseline gap-3 text-sm text-stone-500">
                  {pendingApprovals > 0 && (
                    <span className="text-amber-700">{pendingApprovals} to approve</span>
                  )}
                  {running && <span>answering…</span>}
                  <span>{KIND_LABEL[room.kind]}</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => void enter(() => clientFor(assistant).api.personalRoom())}
          disabled={busy}
          className="self-start rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          Open my room
        </button>
        <form
          onSubmit={(event) => void create(event)}
          className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3"
        >
          <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
            New shared room
          </h3>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder="Room name"
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <input
            value={members}
            onChange={(event) => setMembers(event.target.value)}
            placeholder="Member ids, comma-separated (optional)"
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="self-start rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            Create
          </button>
        </form>
        {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      </div>
      <Notifications assistant={assistant} />
    </section>
  );
}

const PUSH_NOTE: Record<Exclude<PushState, "on" | "off">, string> = {
  unsupported:
    "This browser can't show notifications. On an iPhone, add Nudge to the home screen first.",
  blocked: "Notifications are blocked for this site in the browser's settings.",
  unavailable: "This server sends no notifications.",
};

/** Turns this browser's notifications for the assistant's rooms on or off. */
function Notifications({ assistant }: { assistant: string }) {
  const push = usePush(assistant);
  if (push.state === undefined && push.error === undefined) return null;
  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Notifications</h3>
      {push.state === "on" || push.state === "off" ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            {push.state === "on"
              ? "This browser gets answers, nudges and approvals from your rooms."
              : "Get answers, nudges and approvals from your rooms on this browser."}
          </span>
          <button
            type="button"
            onClick={push.toggle}
            disabled={push.busy}
            className="shrink-0 rounded border px-3 py-1 disabled:opacity-50"
          >
            {push.state === "on" ? "Turn off" : "Turn on"}
          </button>
        </div>
      ) : (
        push.state !== undefined && (
          <p className="text-sm text-stone-500">{PUSH_NOTE[push.state]}</p>
        )
      )}
      {push.error !== undefined && <p className="text-sm text-red-700">{push.error}</p>}
    </div>
  );
}
