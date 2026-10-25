import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { clientFor, useRoomList } from "../../api.ts";
import { m } from "../../i18n/index.ts";
import { usePush } from "../../push.ts";

export const Route = createFileRoute("/$assistant/")({ component: Rooms });

function Rooms() {
  const { assistant } = Route.useParams();
  const roomList = useRoomList(assistant);
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

  const view = roomList?.view;
  if (view === undefined) return <p className="p-4 text-stone-500">{m.common.loading}</p>;
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-3 sm:p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
          {m.profile.rooms.title}
        </h2>
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
                    <span className="text-amber-700">
                      {m.profile.rooms.toApprove(pendingApprovals)}
                    </span>
                  )}
                  {running && <span>{m.profile.rooms.answering}</span>}
                  <span>{m.profile.rooms.kinds[room.kind]}</span>
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
          {m.profile.rooms.openMine}
        </button>
        <form
          onSubmit={(event) => void create(event)}
          className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3"
        >
          <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
            {m.profile.rooms.newShared}
          </h3>
          <input
            value={name}
            onChange={(event) => setName(event.target.value)}
            placeholder={m.profile.rooms.name}
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <input
            value={members}
            onChange={(event) => setMembers(event.target.value)}
            placeholder={m.profile.rooms.members}
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          />
          <button
            type="submit"
            disabled={busy || name.trim() === ""}
            className="self-start rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50"
          >
            {m.profile.rooms.create}
          </button>
        </form>
        {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      </div>
      <Notifications assistant={assistant} />
    </section>
  );
}

/** Turns this browser's notifications for the assistant's rooms on or off. */
function Notifications({ assistant }: { assistant: string }) {
  const push = usePush(assistant);
  if (push.state === undefined && push.error === undefined) return null;
  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.profile.notifications.title}
      </h3>
      {push.state === "on" || push.state === "off" ? (
        <div className="flex items-center justify-between gap-2 text-sm">
          <span>
            {push.state === "on" ? m.profile.notifications.on : m.profile.notifications.off}
          </span>
          <button
            type="button"
            onClick={push.toggle}
            disabled={push.busy}
            className="shrink-0 rounded border px-3 py-1 disabled:opacity-50"
          >
            {push.state === "on" ? m.profile.notifications.turnOff : m.profile.notifications.turnOn}
          </button>
        </div>
      ) : (
        push.state !== undefined && (
          <p className="text-sm text-stone-500">{m.profile.notifications[push.state]}</p>
        )
      )}
      {push.error !== undefined && <p className="text-sm text-red-700">{push.error}</p>}
    </div>
  );
}
