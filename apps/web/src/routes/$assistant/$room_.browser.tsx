import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { forgetToken } from "../../api.ts";
import { keyInput, type LiveSocket, useLiveState, useLiveView } from "../../live-view.ts";

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
    <section className="flex flex-col gap-3">
      <div className="flex items-center justify-between gap-4">
        <h2 className="text-lg font-medium">Browser</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          Back to the room
        </Link>
      </div>
      <p className="text-sm text-stone-600">
        This is the room's own browser. Log in to a site here when the assistant asks you to. What
        you type goes to this browser only; the assistant never sees passwords.
      </p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? "This assistant has no browser extension, or you are not in this room."
            : `Disconnected${state.error ? `: ${state.error}` : ""}.`}
        </p>
      ) : socket === undefined || state.status === "connecting" ? (
        <p className="text-stone-500">Starting the browser…</p>
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
      const { x, y } = toPage(element, event);
      socket.send({ type: "wheel", x, y, dx: event.deltaX, dy: event.deltaY });
    };
    element.addEventListener("wheel", wheel, { passive: false });
    return () => element.removeEventListener("wheel", wheel);
  }, [socket]);

  const go = (event: FormEvent) => {
    event.preventDefault();
    if (address.trim()) socket.send({ type: "navigate", url: address.trim() });
  };

  return (
    // Wider than the page column, up to the remote page's own width, so it is drawn about life-size.
    <div className="relative left-1/2 flex w-[min(1282px,calc(100vw-2rem))] -translate-x-1/2 flex-col gap-2">
      <form onSubmit={go} className="flex gap-2">
        <button
          type="button"
          onClick={() => socket.send({ type: "navigate", url: "back" })}
          className="rounded border border-stone-300 px-2 text-sm"
        >
          ←
        </button>
        <input
          value={address}
          onChange={(event) => setAddress(event.target.value)}
          aria-label="Address"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 text-sm"
        />
        <button className="rounded border border-stone-300 px-3 text-sm">Go</button>
      </form>
      <canvas
        ref={canvas}
        tabIndex={0}
        aria-label="The room's browser. Click to focus, then type."
        className="w-full cursor-pointer rounded border border-stone-300 bg-white focus:outline-2 focus:outline-sky-600"
        onClick={(event) => {
          event.currentTarget.focus();
          socket.send({ type: "click", ...toPage(event.currentTarget, event) });
        }}
        onDoubleClick={(event) =>
          socket.send({ type: "click", double: true, ...toPage(event.currentTarget, event) })
        }
        onContextMenu={(event) => {
          event.preventDefault();
          socket.send({ type: "click", button: "right", ...toPage(event.currentTarget, event) });
        }}
        onKeyDown={(event) => {
          const input = keyInput(event);
          if (input === undefined) return;
          event.preventDefault();
          socket.send(input);
        }}
        onPaste={(event) => {
          event.preventDefault();
          const text = event.clipboardData.getData("text");
          if (text) socket.send({ type: "text", text });
        }}
      />
      {frame === undefined && <p className="text-stone-500">Waiting for the page…</p>}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 text-sm">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          Remember logins I type here, so the assistant can log in by itself next time
        </label>
        <button
          onClick={() => socket.send({ type: "done", remember })}
          className="rounded bg-stone-800 px-3 py-1 text-sm text-white hover:bg-stone-700"
        >
          Done
        </button>
        {state.saved !== undefined && (
          <span className="text-sm text-stone-600">
            {state.saved.length
              ? `Saved the login for ${state.saved.join(", ")}.`
              : "Nothing to save."}{" "}
            Ask the assistant to try again.
          </span>
        )}
      </div>
      {state.error && <p className="text-sm text-red-700">{state.error}</p>}
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
