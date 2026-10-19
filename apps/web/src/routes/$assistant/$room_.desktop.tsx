import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useRef } from "react";
import { forgetToken } from "../../api.ts";
import {
  type DesktopInput,
  type DesktopSocket,
  desktopKey,
  useDesktopState,
  useDesktopView,
} from "../../desktop-view.ts";

export const Route = createFileRoute("/$assistant/$room_/desktop")({ component: Desktop });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

function Desktop() {
  const { assistant, room } = Route.useParams();
  const socket = useDesktopView(assistant, room);
  const state = useDesktopState(socket);
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
        <h2 className="text-lg font-medium">Desktop</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          Back to the room
        </Link>
      </div>
      <p className="text-sm text-stone-600">
        This is the room's own desktop, where the assistant uses apps. Watch it work, or take
        control and use the apps yourself. The assistant reads the apps as text and never sees this
        picture.
      </p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? "This assistant has no desktop extension, or you are not in this room."
            : `Disconnected${state.error ? `: ${state.error}` : ""}.`}
        </p>
      ) : socket === undefined || state.status === "connecting" ? (
        <p className="text-stone-500">Starting the desktop…</p>
      ) : (
        <Live socket={socket} />
      )}
    </section>
  );
}

function Live({ socket }: { socket: DesktopSocket }) {
  const state = useDesktopState(socket);
  const holder = useRef<HTMLDivElement>(null);
  const canvas = socket.canvas;
  const inControl = state.control?.you ?? false;
  // Watchers send nothing that drives the desktop; the server refuses it anyway.
  const controlRef = useRef(inControl);
  controlRef.current = inControl;
  const drive = (input: DesktopInput) => {
    if (controlRef.current) socket.send(input);
  };

  // The socket draws on its own canvas from the first frame; here it is only put on the page.
  useEffect(() => {
    const element = holder.current;
    if (element === null) return;
    canvas.tabIndex = 0;
    canvas.className =
      "block w-full rounded border border-stone-300 bg-black focus:outline-2 focus:outline-sky-600";
    element.appendChild(canvas);
    const at = (event: MouseEvent) => toScreen(canvas, event);
    // A press moved more than a few pixels before its release is a drag, not a click.
    let pressed: { x: number; y: number } | undefined;
    let dragged = false;
    const down = (event: MouseEvent) => {
      if (event.button === 0) pressed = at(event);
    };
    const up = (event: MouseEvent) => {
      const from = pressed;
      pressed = undefined;
      if (event.button !== 0 || from === undefined) return;
      const to = at(event);
      dragged = Math.hypot(to.x - from.x, to.y - from.y) > 4;
      if (dragged) drive({ type: "drag", from, to });
    };
    const click = (event: MouseEvent) => {
      canvas.focus();
      if (dragged) dragged = false;
      else drive({ type: "click", ...at(event) });
    };
    const double = (event: MouseEvent) => drive({ type: "click", double: true, ...at(event) });
    const menu = (event: MouseEvent) => {
      event.preventDefault();
      drive({ type: "click", button: "right", ...at(event) });
    };
    // Menus open on hover; a move at most every 100 ms is enough for that.
    let movedAt = 0;
    const move = (event: MouseEvent) => {
      if (Date.now() - movedAt < 100) return;
      movedAt = Date.now();
      drive({ type: "move", ...at(event) });
    };
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      drive({ type: "wheel", ...at(event), dx: event.deltaX, dy: event.deltaY });
    };
    const key = (event: KeyboardEvent) => {
      const input = desktopKey(event);
      if (input === undefined) return;
      event.preventDefault();
      drive(input);
    };
    const paste = (event: ClipboardEvent) => {
      event.preventDefault();
      const text = event.clipboardData?.getData("text");
      if (text) drive({ type: "text", text });
    };
    canvas.addEventListener("mousedown", down);
    canvas.addEventListener("mouseup", up);
    canvas.addEventListener("click", click);
    canvas.addEventListener("dblclick", double);
    canvas.addEventListener("contextmenu", menu);
    canvas.addEventListener("mousemove", move);
    canvas.addEventListener("wheel", wheel, { passive: false });
    canvas.addEventListener("keydown", key);
    canvas.addEventListener("paste", paste);
    return () => {
      canvas.removeEventListener("mousedown", down);
      canvas.removeEventListener("mouseup", up);
      canvas.removeEventListener("click", click);
      canvas.removeEventListener("dblclick", double);
      canvas.removeEventListener("contextmenu", menu);
      canvas.removeEventListener("mousemove", move);
      canvas.removeEventListener("wheel", wheel);
      canvas.removeEventListener("keydown", key);
      canvas.removeEventListener("paste", paste);
      canvas.remove();
    };
  }, [canvas, socket]);

  useEffect(() => {
    canvas.setAttribute("aria-disabled", String(!inControl));
    canvas.setAttribute(
      "aria-label",
      "The room's desktop. Click to focus, then type; the window under the pointer gets the keys.",
    );
    canvas.style.cursor = inControl ? "default" : "not-allowed";
  }, [canvas, inControl]);

  return (
    // Wider than the page column, up to the screen's own width, so it is drawn about life-size.
    <div
      className="relative left-1/2 flex -translate-x-1/2 flex-col gap-2"
      style={{ width: `min(${(state.screen?.width ?? 1280) + 2}px, calc(100vw - 2rem))` }}
    >
      {state.control !== undefined && !inControl && (
        <div className="flex items-center gap-3 rounded bg-amber-50 px-3 py-2 text-sm text-amber-900">
          {state.control.holder ?? "Someone else"} is using the desktop; you are watching.
          <button
            onClick={() => socket.send({ type: "take" })}
            className="rounded border border-amber-700 px-2 py-0.5 hover:bg-amber-100"
          >
            Take control
          </button>
        </div>
      )}
      <div className="flex flex-wrap items-center gap-2 text-sm">
        {(state.apps ?? []).map((app) => (
          <button
            key={app}
            onClick={() => drive({ type: "launch", app })}
            disabled={!inControl}
            title={`Start ${app}`}
            className="rounded border border-stone-300 px-2 py-0.5 hover:bg-stone-100 disabled:opacity-40"
          >
            Start {app}
          </button>
        ))}
        {(state.windows ?? []).length > 0 && <span className="ml-2 text-stone-500">Windows:</span>}
        {(state.windows ?? []).map((window) => (
          <button
            key={window.ref}
            onClick={() => drive({ type: "raise", ref: window.ref })}
            disabled={!inControl}
            title={`Bring ${window.title || window.app} to the front`}
            className="max-w-48 truncate rounded bg-stone-100 px-2 py-0.5 hover:bg-stone-200 disabled:opacity-40"
          >
            {window.title || window.app}
          </button>
        ))}
      </div>
      <div ref={holder} />
      {state.screen === undefined && <p className="text-stone-500">Waiting for the screen…</p>}
      {state.working && (
        <p className="text-sm text-stone-600">
          <span className="font-medium">The assistant:</span> {state.working}
        </p>
      )}
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
    </div>
  );
}

/** A pointer position on the canvas in the screen's own pixels. */
function toScreen(
  element: HTMLCanvasElement,
  event: { clientX: number; clientY: number },
): { x: number; y: number } {
  const box = element.getBoundingClientRect();
  return {
    x: Math.round(((event.clientX - box.left) / box.width) * element.width),
    y: Math.round(((event.clientY - box.top) / box.height) * element.height),
  };
}
