import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { clientFor } from "../../api.ts";

export const Route = createFileRoute("/$assistant/$room_/model")({ component: ModelView });

type Message = Awaited<ReturnType<ReturnType<typeof clientFor>["api"]["modelView"]>>[number];

const ROLE: Record<Message["role"], string> = {
  system: "Instructions",
  user: "In",
  assistant: "Model",
  toolResult: "Tool result",
};

/** The room as the model sees it: what its next request sends, personal values as placeholders. */
function ModelView() {
  const { assistant, room } = Route.useParams();
  const [messages, setMessages] = useState<Message[]>();
  const [error, setError] = useState<string>();
  const [loads, setLoads] = useState(0);

  useEffect(() => {
    let live = true;
    setError(undefined);
    clientFor(assistant)
      .api.modelView(room)
      .then(
        (next) => live && setMessages(next),
        (caught: unknown) => live && setError((caught as Error).message),
      );
    return () => {
      live = false;
    };
  }, [assistant, room, loads]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-4">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium">What the model sees</h2>
        <div className="flex gap-3 text-sm">
          <button
            type="button"
            onClick={() => setLoads((n) => n + 1)}
            className="text-stone-600 hover:underline"
          >
            Refresh
          </button>
          <Link
            to="/$assistant/$room"
            params={{ assistant, room }}
            className="text-stone-600 hover:underline"
          >
            Back to the room
          </Link>
        </div>
      </div>
      <p className="text-sm text-stone-600">
        This room's next request to the model, as the provider gets it. Names, addresses, numbers
        and anything else marked private go out as placeholders such as ⟦NAME1⟧, and are put back
        only here, on the host. The tools' descriptions go out too; they hold nothing personal.
      </p>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      {messages === undefined ? (
        error === undefined && <p className="text-stone-500">Loading…</p>
      ) : messages.length === 0 ? (
        <p className="text-stone-500">Nothing yet: the room has had no turn.</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((message, index) => (
            <li key={index} className="rounded border border-stone-200 bg-white p-3">
              <div className="mb-1 text-xs font-medium tracking-wide text-stone-500 uppercase">
                {ROLE[message.role]}
              </div>
              <pre className="font-mono text-xs break-words whitespace-pre-wrap text-stone-800">
                {message.text}
              </pre>
            </li>
          ))}
        </ol>
      )}
    </section>
  );
}
