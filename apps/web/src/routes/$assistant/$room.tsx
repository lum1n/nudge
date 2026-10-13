import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { roomQuery } from "../../queries.ts";

export const Route = createFileRoute("/$assistant/$room")({ component: Room });

function Room() {
  const { assistant, room } = Route.useParams();
  const query = useQuery(roomQuery(assistant, room));
  if (query.isPending) return <p className="text-stone-500">Loading…</p>;
  if (query.error) return <p className="text-red-700">{query.error.message}</p>;
  const { room: info, members } = query.data;
  return (
    <section className="flex flex-col gap-2">
      <h2 className="text-lg font-medium">{info.name}</h2>
      <p className="text-sm text-stone-600">
        {members.map((member) => member.displayName).join(", ")}
      </p>
      <p className="text-stone-500">The chat comes next.</p>
    </section>
  );
}
