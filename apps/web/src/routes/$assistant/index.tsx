import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link } from "@tanstack/react-router";
import type { MeResponse } from "../../api.ts";
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
  if (me.isPending) return <p className="text-stone-500">Loading…</p>;
  if (!me.data) return null;
  return (
    <section className="flex flex-col gap-2">
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
    </section>
  );
}
