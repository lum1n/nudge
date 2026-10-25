import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { forgetToken } from "../../api.ts";
import { type ListsSocket, type PanelList, useLists } from "../../lists.ts";
import { m } from "../../i18n/index.ts";

export const Route = createFileRoute("/$assistant/$room_/lists")({ component: Lists });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Lists() {
  const { assistant, room } = Route.useParams();
  const [socket, state] = useLists(assistant, room);
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  /** A list started here that has no item yet; it exists once one is added. */
  const [started, setStarted] = useState("");

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  function create(event: FormEvent) {
    event.preventDefault();
    if (draft.trim() === "") return;
    setStarted(draft.trim().toLowerCase().replace(/\s+/g, " "));
    setDraft("");
  }

  const lists = state.view ?? [];
  const pending = started !== "" && !lists.some((list) => list.name === started);
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">{m.panels.lists.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.lists.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.lists.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : socket === undefined || state.view === undefined ? (
        <p className="text-stone-500">{m.panels.connecting}</p>
      ) : (
        <>
          {state.error ? <p className="text-sm text-red-700">{state.error}</p> : null}
          {lists.length === 0 && !pending && (
            <p className="text-stone-500">{m.panels.lists.empty}</p>
          )}
          {lists.map((list) => (
            <ListCard key={list.name} list={list} socket={socket} />
          ))}
          {pending && <ListCard list={{ name: started, items: [] }} socket={socket} />}
          <form onSubmit={create} className="flex gap-2">
            <input
              value={draft}
              onChange={(event) => setDraft(event.target.value)}
              placeholder={m.panels.lists.newList}
              className="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
            />
            <button type="submit" className="rounded border px-3 py-1 text-sm">
              {m.panels.lists.start}
            </button>
          </form>
        </>
      )}
    </section>
  );
}

function ListCard({ list, socket }: { list: PanelList; socket: ListsSocket }) {
  const [text, setText] = useState("");
  const done = list.items.filter((item) => item.done).length;

  function add(event: FormEvent) {
    event.preventDefault();
    if (text.trim() === "") return;
    socket.send({ type: "add", list: list.name, text: text.trim() });
    setText("");
  }

  return (
    <div className="flex flex-col gap-2 rounded border border-stone-200 bg-white p-3">
      <div className="flex items-baseline justify-between gap-2">
        <h3 className="font-medium capitalize">{list.name}</h3>
        <div className="flex gap-3 text-xs text-stone-500">
          {done > 0 && (
            <button
              type="button"
              onClick={() => socket.send({ type: "clearDone", list: list.name })}
              className="hover:underline"
            >
              {m.panels.lists.clearDone(done)}
            </button>
          )}
          {list.items.length > 0 && (
            <button
              type="button"
              onClick={() => {
                if (confirm(m.panels.lists.confirmDelete(list.name)))
                  socket.send({ type: "deleteList", list: list.name });
              }}
              className="hover:underline"
            >
              {m.panels.lists.deleteList}
            </button>
          )}
        </div>
      </div>
      <ul className="flex flex-col gap-1">
        {list.items.map((item) => (
          <li key={item.id} className="group flex items-center gap-2 text-sm">
            <input
              type="checkbox"
              checked={item.done}
              onChange={() => socket.send({ type: "toggle", list: list.name, id: item.id })}
            />
            <span className={item.done ? "text-stone-400 line-through" : ""}>{item.text}</span>
            <span className="text-xs text-stone-400">{item.by}</span>
            <button
              type="button"
              onClick={() => socket.send({ type: "remove", list: list.name, id: item.id })}
              className="ml-auto text-xs text-stone-400 opacity-0 group-hover:opacity-100 hover:text-red-700"
              aria-label={m.panels.lists.removeItem(item.text)}
            >
              {m.common.remove}
            </button>
          </li>
        ))}
      </ul>
      <form onSubmit={add} className="flex gap-2">
        <input
          value={text}
          onChange={(event) => setText(event.target.value)}
          placeholder={m.panels.lists.addItem}
          className="flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button
          type="submit"
          disabled={text.trim() === ""}
          className="rounded bg-stone-900 px-3 py-1 text-sm text-white disabled:opacity-50"
        >
          {m.panels.lists.add}
        </button>
      </form>
    </div>
  );
}
