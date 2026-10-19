import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { type ConnectorsSocket, type PanelConnector, useConnectors } from "../../connectors.ts";

export const Route = createFileRoute("/$assistant/$room_/connectors")({ component: Connectors });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Connectors() {
  const { assistant, room } = Route.useParams();
  const [socket, state] = useConnectors(assistant, room);
  const navigate = useNavigate();

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">Connectors</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          Back to the room
        </Link>
      </div>
      <p className="text-sm text-stone-600">
        APIs this room's assistant can call. Ask it in the chat to add one, and say what for. Tick
        "Always use it first" to have it try one before anything else for those tasks. API keys go
        here only: the assistant never sees them.
      </p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? "This assistant has no connectors extension here, or you are not in this room."
            : `Disconnected${state.error ? `: ${state.error}` : ""}.`}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">Connecting…</p>
      ) : (
        <>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {state.view.length === 0 ? (
            <p className="text-stone-500">No connectors yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {state.view.map((connector) => (
                <li key={connector.id}>
                  <ConnectorCard socket={socket} connector={connector} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ConnectorCard({
  socket,
  connector,
}: {
  socket: ConnectorsSocket;
  connector: PanelConnector;
}) {
  const id = connector.id;
  const [key, setKey] = useState("");
  const [readPaths, setReadPaths] = useState(connector.readPaths.join("\n"));
  useEffect(() => setReadPaths(connector.readPaths.join("\n")), [connector.readPaths]);
  const [useFor, setUseFor] = useState(connector.useFor);
  useEffect(() => setUseFor(connector.useFor), [connector.useFor]);

  const saveKey = (event: FormEvent) => {
    event.preventDefault();
    if (key.trim() === "") return;
    socket.send({ type: "setKey", connector: id, value: key });
    setKey("");
  };
  const saveUseFor = (event: FormEvent) => {
    event.preventDefault();
    if (useFor.trim() === "") return;
    socket.send({ type: "setUseFor", connector: id, useFor });
  };
  const saveReadPaths = (event: FormEvent) => {
    event.preventDefault();
    socket.send({ type: "setReadPaths", connector: id, readPaths: readPaths.split("\n") });
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div>
          <span className="font-medium">{connector.name}</span>{" "}
          <span className="text-xs text-stone-500">
            {id} · {connector.baseUrl}
          </span>
        </div>
        {connector.shared ? (
          <span className="text-xs text-stone-500">Shared with every room</span>
        ) : (
          <button
            type="button"
            onClick={() => {
              if (confirm(`Remove ${connector.name}?`))
                socket.send({ type: "remove", connector: id });
            }}
            className="text-sm text-stone-600 hover:text-red-700"
          >
            Remove
          </button>
        )}
      </div>
      {connector.shared ? (
        <p className="text-sm text-stone-700">
          {connector.alwaysFirst ? "Used first for: " : null}
          {connector.useFor}
        </p>
      ) : null}
      {connector.notes ? (
        <p className="text-xs text-stone-500">Learned: {connector.notes}</p>
      ) : null}
      {connector.shared ? null : (
        <>
          <form onSubmit={saveUseFor} className="flex flex-col gap-1 text-sm">
            <span className="text-stone-600">Use it for</span>
            <div className="flex flex-wrap items-center gap-2">
              <input
                value={useFor}
                onChange={(event) => setUseFor(event.target.value)}
                className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
              />
              <button
                type="submit"
                disabled={useFor.trim() === "" || useFor.trim() === connector.useFor}
                className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100 disabled:opacity-50"
              >
                Save
              </button>
            </div>
          </form>
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={connector.alwaysFirst === true}
              onChange={(event) =>
                socket.send({
                  type: "setAlwaysFirst",
                  connector: id,
                  alwaysFirst: event.target.checked,
                })
              }
            />
            Always use it first for this, before browsing or answering from memory
          </label>
          {connector.auth === undefined ? null : (
            <form onSubmit={saveKey} className="flex flex-wrap items-center gap-2 text-sm">
              <span className="text-stone-600">
                API key ({connector.auth.in} <code>{connector.auth.name}</code>):{" "}
                {connector.hasKey ? "set" : <span className="text-amber-700">not set</span>}
              </span>
              <input
                type="password"
                autoComplete="off"
                value={key}
                onChange={(event) => setKey(event.target.value)}
                placeholder={connector.hasKey ? "Replace the key" : "Paste the key"}
                className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
              />
              <button
                type="submit"
                className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100"
              >
                Save
              </button>
              {connector.hasKey ? (
                <button
                  type="button"
                  onClick={() => socket.send({ type: "clearKey", connector: id })}
                  className="text-stone-600 hover:underline"
                >
                  Clear
                </button>
              ) : null}
            </form>
          )}
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={connector.allowPrivateNetwork}
              onChange={(event) =>
                socket.send({
                  type: "setPrivateNetwork",
                  connector: id,
                  allow: event.target.checked,
                })
              }
            />
            May reach this machine and the local network (Home Assistant, a NAS)
          </label>
          <form onSubmit={saveReadPaths} className="flex flex-col gap-1 text-sm">
            <span className="text-stone-600">
              Calls that only read, though not GET: one <code>METHOD /path</code> per line, such as{" "}
              <code>POST /graphql</code>. They run without asking.
            </span>
            <textarea
              value={readPaths}
              onChange={(event) => setReadPaths(event.target.value)}
              rows={Math.max(2, connector.readPaths.length + 1)}
              className="rounded border border-stone-300 px-2 py-1 font-mono text-xs"
            />
            <button
              type="submit"
              disabled={readPaths === connector.readPaths.join("\n")}
              className="self-start rounded border border-stone-300 px-3 py-1 hover:bg-stone-100 disabled:opacity-50"
            >
              Save read paths
            </button>
          </form>
        </>
      )}
    </div>
  );
}
