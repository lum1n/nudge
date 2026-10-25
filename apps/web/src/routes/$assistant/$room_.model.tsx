import { createFileRoute, Link } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { clientFor } from "../../api.ts";
import { m } from "../../i18n/index.ts";

export const Route = createFileRoute("/$assistant/$room_/model")({ component: ModelView });

type Message = Awaited<ReturnType<ReturnType<typeof clientFor>["api"]["modelView"]>>[number];

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
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">{m.panels.model.title}</h2>
        <div className="flex gap-3 text-sm">
          <button
            type="button"
            onClick={() => setLoads((n) => n + 1)}
            className="text-stone-600 hover:underline"
          >
            {m.panels.model.refresh}
          </button>
          <Link
            to="/$assistant/$room"
            params={{ assistant, room }}
            className="text-stone-600 hover:underline"
          >
            {m.panels.backToRoom}
          </Link>
        </div>
      </div>
      <p className="text-sm text-stone-600">{m.panels.model.intro}</p>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      {messages === undefined ? (
        error === undefined && <p className="text-stone-500">{m.common.loading}</p>
      ) : messages.length === 0 ? (
        <p className="text-stone-500">{m.panels.model.empty}</p>
      ) : (
        <ol className="flex flex-col gap-2">
          {messages.map((message, index) => (
            <li key={index} className="rounded border border-stone-200 bg-white p-3">
              <div className="mb-1 text-xs font-medium tracking-wide text-stone-500 uppercase">
                {m.panels.model.role[message.role]}
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
