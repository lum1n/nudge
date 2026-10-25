import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { type McpSocket, type PanelServer, useMcpServers } from "../../mcp.ts";
import { m } from "../../i18n/index.ts";

export const Route = createFileRoute("/$assistant/$room_/mcp")({ component: McpServers });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

const APPROVALS: PanelServer["approval"][] = ["writes", "always", "never"];

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
        <h2 className="text-lg font-medium">{m.panels.mcp.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.mcp.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.mcp.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">{m.panels.connecting}</p>
      ) : (
        <>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {state.view.length === 0 ? (
            <p className="text-stone-500">{m.panels.mcp.empty}</p>
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
            if (confirm(m.panels.mcp.confirmRemove(server.name)))
              socket.send({ type: "remove", server: id });
          }}
          className="text-sm text-stone-600 hover:text-red-700"
        >
          {m.common.remove}
        </button>
      </div>
      <p className="text-sm text-stone-700">{server.useFor}</p>
      <p className="text-xs text-stone-500">
        {m.panels.mcp.addedBy(server.addedBy)}
        {server.tools === undefined ? "" : m.panels.mcp.tools(server.tools)}
      </p>
      {server.problem ? <p className="text-sm text-amber-700">{server.problem}</p> : null}
      {server.keys.map((key) => (
        <KeyForm key={key.name} socket={socket} server={id} serverKey={key} />
      ))}
      {server.url !== undefined && server.keys.length === 0 ? (
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <span className="text-stone-600">
            {server.signedIn ? m.panels.mcp.signedIn : m.panels.mcp.notSignedIn}
          </span>
          <button
            type="button"
            onClick={() => void signIn()}
            className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100"
          >
            {server.signedIn ? m.panels.mcp.signInAgain : m.panels.mcp.signIn}
          </button>
          {server.signedIn ? (
            <button
              type="button"
              onClick={() => socket.send({ type: "signOut", server: id })}
              className="text-stone-600 hover:underline"
            >
              {m.panels.mcp.signOut}
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
          {APPROVALS.map((approval) => (
            <option key={approval} value={approval}>
              {m.panels.mcp.approvals[approval]}
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
            {m.panels.mcp.trustReadOnly}
          </label>
        ) : null}
        <button
          type="button"
          onClick={() => socket.send({ type: "refresh", server: id })}
          className="text-stone-600 hover:underline"
        >
          {m.panels.mcp.tryAgain}
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
        {serverKey.in === "header" ? m.panels.mcp.header : m.panels.mcp.variable}{" "}
        <code>{serverKey.name}</code>:{" "}
        {serverKey.set ? m.panels.set : <span className="text-amber-700">{m.panels.notSet}</span>}
      </span>
      <input
        type="password"
        autoComplete="off"
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={serverKey.set ? m.panels.mcp.replace : m.panels.mcp.paste(serverKey.prefix)}
        className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1"
      />
      <button
        type="submit"
        className="rounded border border-stone-300 px-3 py-1 hover:bg-stone-100"
      >
        {m.common.save}
      </button>
      {serverKey.set ? (
        <button
          type="button"
          onClick={() => socket.send({ type: "clearKey", server, key: serverKey.name })}
          className="text-stone-600 hover:underline"
        >
          {m.panels.clear}
        </button>
      ) : null}
    </form>
  );
}
