import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { forgetToken } from "../../api.ts";
import {
  keyInput,
  type LiveInput,
  type LiveSocket,
  type SavedLogin,
  useLiveState,
  useLiveView,
} from "../../live-view.ts";
import { dateLocale, m } from "../../i18n/index.ts";

export const Route = createFileRoute("/$assistant/$room_/browser")({ component: Browser });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Browser() {
  const { assistant, room } = Route.useParams();
  const socket = useLiveView(assistant, room);
  const state = useLiveState(socket);
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
        <h2 className="text-lg font-medium">{m.panels.browser.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.browser.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.browser.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : socket === undefined || state.status === "connecting" ? (
        <p className="text-stone-500">{m.panels.browser.starting}</p>
      ) : (
        <Live socket={socket} />
      )}
    </section>
  );
}

function Live({ socket }: { socket: LiveSocket }) {
  const state = useLiveState(socket);
  const canvas = useRef<HTMLCanvasElement>(null);
  const [address, setAddress] = useState("");
  const [remember, setRemember] = useState(true);
  const frame = state.frame;
  const inControl = state.control?.you ?? false;
  // Watchers send nothing that drives the page; the server refuses it anyway.
  const controlRef = useRef(inControl);
  controlRef.current = inControl;
  const drive = (input: LiveInput) => {
    if (controlRef.current) socket.send(input);
  };

  useEffect(() => {
    if (frame === undefined || canvas.current === null) return;
    const element = canvas.current;
    const image = new Image();
    image.onload = () => {
      element.width = frame.width;
      element.height = frame.height;
      element.getContext("2d")?.drawImage(image, 0, 0, frame.width, frame.height);
    };
    image.src = `data:image/jpeg;base64,${frame.data}`;
  }, [frame]);

  useEffect(() => {
    if (frame?.url) setAddress(frame.url);
  }, [frame?.url]);

  // React's wheel handler is passive; this one has to stop the page here from scrolling.
  useEffect(() => {
    const element = canvas.current;
    if (element === null) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      if (!controlRef.current) return;
      const { x, y } = toPage(element, event);
      drive({ type: "wheel", x, y, dx: event.deltaX, dy: event.deltaY });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [socket]);

  const go = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) drive({ type: "navigate", url: address.trim() });
  };

  return (
    // Wider than the page column, up to the remote page's own width, so it is drawn about life-size.
    <div className="relative left-1/2 flex w-[min(1282px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
      {state.control !== undefined && !inControl && (
        <div className="flex items-center gap-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {m.panels.browser.watching(state.control.holder ?? m.panels.someoneElse)}
          <button
            onClick={() => socket.send({ type: "take" })}
            className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-100"
          >
            {m.panels.takeControl}
          </button>
        </div>
      )}
      <form onSubmit={go} className="flex gap-2">
        <button
          type="button"
          onClick={() => drive({ type: "navigate", url: "back" })}
          aria-label={m.common.back}
          title={m.common.back}
          className="rounded border border-stone-300 px-2 text-sm"
        >
          ←
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label={m.panels.browser.address}
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button className="rounded border border-stone-300 px-3 text-sm">
          {m.panels.browser.go}
        </button>
      </form>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-disabled={!inControl}
        aria-label={m.panels.browser.canvas}
        className={`w-full rounded border border-stone-300 bg-white focus:outline-2 focus:outline-sky-600 ${inControl ? "cursor-pointer" : "cursor-not-allowed opacity-90"}`}
        onClick={(event) => {
          event.currentTarget.focus();
          drive({ type: "click", ...toPage(event.currentTarget, event) });
        }}
        onDoubleClick={(event) =>
          drive({ type: "click", double: true, ...toPage(event.currentTarget, event) })
        }
        onContextMenu={(event) => {
          event.preventDefault();
          drive({ type: "click", button: "right", ...toPage(event.currentTarget, event) });
        }}
        onKeyDown={(event) => {
          const input = keyInput(event);
          if (input === undefined) return;
          event.preventDefault();
          drive(input);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text");
          if (text) drive({ type: "text", text });
        }}
      />
      {frame === undefined && <p className="text-stone-500">{m.panels.browser.waiting}</p>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {m.panels.browser.remember}
        </label>
        <button
          onClick={() => socket.send({ type: "done", remember })}
          disabled={!inControl}
          className="rounded bg-stone-800 px-3 py-1 text-sm text-white hover:bg-stone-700 disabled:opacity-40"
        >
          {m.panels.browser.done}
        </button>
        {state.saved !== undefined && (
          <span className="text-sm text-stone-600">
            {state.saved.length
              ? m.panels.browser.savedFor(state.saved.join(", "))
              : m.panels.browser.nothingToSave}{" "}
            {m.panels.browser.askAgain}
          </span>
        )}
      </div>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
      <SavedLogins socket={socket} logins={state.logins ?? []} />
    </div>
  );
}

function SavedLogins({ socket, logins }: { socket: LiveSocket; logins: SavedLogin[] }) {
  return (
    <div className="mt-2 flex flex-col gap-1">
      <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
        {m.panels.browser.savedLogins}
      </h3>
      {logins.length === 0 ? (
        <p className="text-sm text-stone-500">{m.panels.browser.noLogins}</p>
      ) : (
        <ul className="flex flex-col gap-1">
          {logins.map((login) => (
            <li key={login.host} className="flex items-center gap-3 text-sm">
              <span className="font-medium">{login.host}</span>
              {login.username && <span className="text-stone-600">{login.username}</span>}
              <span className="text-stone-500">
                {m.panels.browser.saved(new Date(login.savedAt).toLocaleDateString(dateLocale()))}
              </span>
              <button
                onClick={() => socket.send({ type: "forget", host: login.host })}
                className="rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100"
              >
                {m.panels.browser.forget}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A pointer position on the canvas in the page's own pixels. */
function toPage(
  element: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * element.width),
    y: Math.round(((event.clientY - box.top) / box.height) * element.height),
  };
}
