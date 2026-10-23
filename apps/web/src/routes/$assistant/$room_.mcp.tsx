import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { type McpSocket, type PanelServer, useMcpServers } from "../../mcp.ts";

export const Route = createFileRoute("/$assistant/$room_/mcp")({ component: McpServers });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

const APPROVALS: { value: PanelServer["approval"]; label: string }[] = [
  { value: "writes", label: "Ask before calls that change something" },
  { value: "always", label: "Ask before every call" },
  { value: "never", label: "Never ask" },
];

function McpServers() {
  const { assistant, room } = Route.useParams();
  const [socket, state] = useMcpServers(assistant, room);
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
        <h2 className="text-lg font-medium">MCP servers</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          Back to the room
        </Link>
      </div>
      <p className="text-sm text-stone-600">
        MCP servers this room's assistant can use. Ask it in the chat to add one. Keys and sign-ins
        go here only: the assistant never sees them.
      </p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? "This assistant has no MCP extension here, or you are not in this room."
            : `Disconnected${state.error ? `: ${state.error}` : ""}.`}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">Connecting…</p>
      ) : (
        <>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {state.view.length === 0 ? (
            <p className="text-stone-500">No MCP servers yet.</p>
          ) : (
            <ul className="flex flex-col gap-3">
              {state.view.map((server) => (
                <li key={server.id}>
                  <ServerCard socket={socket} server={server} />
                </li>
              ))}
            </ul>
          )}
        </>
      )}
    </section>
  );
}

function ServerCard({ socket, server }: { socket: McpSocket; server: PanelServer }) {
  const id = server.id;

  const signIn = async () => {
    // Opened now, while the click still counts, so the browser doesn't block it.
    const window_ = window.open("", "_blank");
    const reply = await socket.request({ type: "signIn", server: id, base: location.origin });
    if (reply.type === "signIn" && window_ !== null) window_.location.href = reply.url;
    else window_?.close();
  };

  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 p-3">
      <div className="flex items-baseline justify-between gap-2">
        <div className="min-w-0">
          <span className="font-medium">{server.name}</span>{" "}
          <span className="break-all text-xs text-stone-500">
            {server.command === undefined ? server.runs : <code>{server.runs}</code>}
          </span>
        </div>
        <button
          type="button"
          onClick={() => {
            if (confirm(`Remove ${server.name}, with its keys and sign-in?`))
              socket.send({ type: "remove", server: id });
          }}
          className="text-sm text-stone-600 hover:text-red-700"
        >
          Remove
        </button>
      </div>
      <p className="text-sm text-stone-700">{server.useFor}</p>
      <p className="text-xs text-stone-500">
        Added by {server.addedBy}
        {server.tools === undefined
          ? ""
          : ` · ${server.tools} ${server.tools === 1 ? "tool" : "tools"}`}
      </p>
      {server.problem ? <p className="text-sm text-amber-700">{server.problem}</p> : null}
      {server.keys.map((key) => (
        <KeyForm key={key.name} socket={socket} server={id} serverKey={key} />
      ))}
      {server.url !== undefined && server.keys.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-stone-600">
            {server.signedIn ? "Signed in." : "Not signed in. Servers that need it ask for it."}
          </span>
          <button
            type="button"
            onClick={() => void signIn()}
            className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100"
          >
            {server.signedIn ? "Sign in again" : "Sign in"}
          </button>
          {server.signedIn ? (
            <button
              type="button"
              onClick={() => socket.send({ type: "signOut", server: id })}
              className="text-stone-600 hover:underline"
            >
              Sign out
            </button>
          ) : null}
        </div>
      ) : null}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        <select
          value={server.approval}
          onChange={(event) =>
            socket.send({
              type: "setApproval",
              server: id,
              approval: event.target.value as PanelServer["approval"],
            })
          }
          className="rounded border border-stone-300 px-2 py-1"
        >
          {APPROVALS.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label}
            </option>
          ))}
        </select>
        {server.approval === "writes" ? (
          <label className="flex items-center gap-1 text-stone-600">
            <input
              type="checkbox"
              checked={server.trustReadOnlyHint === true}
              onChange={(event) =>
                socket.send({
                  type: "setTrustReadOnlyHint",
                  server: id,
                  trust: event.target.checked,
                })
              }
            />
            Trust the server's read-only marks
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => socket.send({ type: "refresh", server: id })}
          className="text-stone-600 hover:underline"
        >
          Try again
        </button>
      </div>
    </div>
  );
}

function KeyForm({
  socket,
  server,
  serverKey,
}: {
  socket: McpSocket;
  server: string;
  serverKey: PanelServer["keys"][number];
}) {
  const [value, setValue] = useState("");
  const save = (event: FormEvent) => {
    event.preventDefault();
    if (value.trim() === "") return;
    socket.send({ type: "setKey", server, key: serverKey.name, value });
    setValue("");
  };
  return (
    <form onSubmit={save} className="flex flex-wrap items-center gap-2 text-sm">
      <span className="text-stone-600">
        {serverKey.in === "header" ? "Header" : "Variable"} <code>{serverKey.name}</code>:{" "}
        {serverKey.set ? "set" : <span className="text-amber-700">not set</span>}
      </span>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={
          serverKey.set
            ? "Replace it"
            : `Paste it${serverKey.prefix ? ` (without "${serverKey.prefix.trim()}")` : ""}`
        }
        className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
      />
      <button
        type="submit"
        className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100"
      >
        Save
      </button>
      {serverKey.set ? (
        <button
          type="button"
          onClick={() => socket.send({ type: "clearKey", server, key: serverKey.name })}
          className="text-stone-600 hover:underline"
        >
          Clear
        </button>
      ) : null}
    </form>
  );
}
