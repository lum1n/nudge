import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useState } from "react";
import { createSharedRoom, type MeResponse, openPersonalRoom } from "../../api.ts";
import { meQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant/")({ component: Rooms });

const KIND_LABEL: Record<MeResponse["rooms"][number]["kind"], string> = {
  lobby: "Everyone",
  personal: "Personal",
  shared: "Shared",
};

function Rooms() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const queryClient = useQueryClient();
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
      await queryClient.invalidateQueries({ queryKey: [assistant, "me"] });
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
    if (await enter(() => createSharedRoom(assistant, name.trim(), ids))) {
      setName("");
      setMembers("");
    }
  }

  if (me.isPending) return <p className="p-4 text-stone-500">Loading…</p>;
  if (!me.data) return null;
  return (
    <section className="mx-auto flex max-w-2xl flex-col gap-4 p-4">
      <div className="flex flex-col gap-2">
        <h2 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Rooms</h2>
        <ul className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
          {me.data.rooms.map((room) => (
            <li key={room.id}>
              <Link
                to="/$assistant/$room"
                params={{ assistant, room: room.id }}
                className="flex items-baseline justify-between px-4 py-3 hover:bg-stone-100"
              >
                <span>{room.name}</span>
                <span className="text-sm text-stone-500">{KIND_LABEL[room.kind]}</span>
              </Link>
            </li>
          ))}
        </ul>
      </div>
      <div className="flex flex-col gap-3">
        <button
          type="button"
          onClick={() => void enter(() => openPersonalRoom(assistant))}
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
    </section>
  );
}
