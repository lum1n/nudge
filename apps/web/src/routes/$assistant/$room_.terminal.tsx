import type { Approval } from "@nudge/client";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { clientFor, forgetToken, useRoom } from "../../api.ts";
import { dateLocale, m } from "../../i18n/index.ts";
import { type TerminalCommand, useTerminal } from "../../terminal.ts";

export const Route = createFileRoute("/$assistant/$room_/terminal")({ component: Terminal });

const UNAUTHORIZED = 4401;
const NOT_FOUND = 4404;

/** The room's terminal, live: the commands the assistant ran, their output, and approvals. */
function Terminal() {
  const { assistant, room } = Route.useParams();
  const state = useTerminal(assistant, room);
  const approvals = useRoom(assistant, room)?.state.view?.approvals ?? [];
  const navigate = useNavigate();

  useEffect(() => {
    if (state.status === "closed" && state.closeCode === UNAUTHORIZED) {
      forgetToken(assistant);
      void navigate({ to: "/login" });
    }
  }, [assistant, navigate, state.status, state.closeCode]);

  // Newest first: what runs now is what one comes here for.
  const commands = [...(state.view ?? [])].reverse();
  return (
    <section className="mx-auto flex max-w-4xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">{m.panels.terminal.title}</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          {m.panels.backToRoom}
        </Link>
      </div>
      <p className="text-sm text-stone-600">{m.panels.terminal.intro}</p>
      {state.status === "closed" ? (
        <p className="text-red-700">
          {state.closeCode === NOT_FOUND
            ? m.panels.terminal.notFound
            : m.panels.disconnected(state.error)}
        </p>
      ) : state.view === undefined ? (
        <p className="text-stone-500">{m.panels.connecting}</p>
      ) : commands.length === 0 ? (
        <p className="text-stone-500">{m.panels.terminal.empty}</p>
      ) : (
        <ul className="flex flex-col gap-3">
          {commands.map((command) => (
            <li key={command.id}>
              <CommandCard
                command={command}
                approval={approvals.find((item) => item.id === command.approval)}
              />
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

const STATUS_CLASS: Record<TerminalCommand["status"], string> = {
  waiting: "text-amber-700",
  running: "text-sky-700",
  done: "text-emerald-700",
  failed: "text-red-700",
  stopped: "text-red-700",
  denied: "text-stone-500",
};

function CommandCard({ command, approval }: { command: TerminalCommand; approval?: Approval }) {
  const words = m.panels.terminal;
  const label =
    command.status === "failed" && command.exitCode !== undefined
      ? words.exit(command.exitCode)
      : words.status[command.status];
  return (
    <div className="overflow-hidden rounded border border-stone-300">
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 bg-stone-100 px-3 py-2 text-sm">
        <code className="min-w-0 font-mono [overflow-wrap:anywhere]">
          {command.cwd ? <span className="text-stone-500">{command.cwd} </span> : null}${" "}
          {command.command}
        </code>
        <span className="shrink-0 text-xs text-stone-500">
          <span className={STATUS_CLASS[command.status]}>{label}</span>
          {command.decidedBy
            ? ` · ${(command.status === "denied" ? words.deniedBy : words.approvedBy)(command.decidedBy)}`
            : ""}
          {" · "}
          {new Date(command.startedAt).toLocaleTimeString(dateLocale())}
        </span>
      </div>
      {command.ending && <p className="px-3 pt-2 text-xs text-red-700">{command.ending}</p>}
      {command.status === "waiting" && approval?.status === "pending" && (
        <Decide approval={approval} />
      )}
      {command.output !== "" && (
        <Output text={command.output} follow={command.status === "running"} />
      )}
    </div>
  );
}

/** A command's output; it follows the end while the command runs, unless one scrolled up. */
function Output({ text, follow }: { text: string; follow: boolean }) {
  const ref = useRef<HTMLPreElement>(null);
  const atEnd = useRef(true);
  useLayoutEffect(() => {
    const element = ref.current;
    if (element && follow && atEnd.current) element.scrollTop = element.scrollHeight;
  }, [text, follow]);
  return (
    <pre
      ref={ref}
      onScroll={(event) => {
        const element = event.currentTarget;
        atEnd.current = element.scrollTop + element.clientHeight >= element.scrollHeight - 8;
      }}
      className="max-h-96 overflow-auto bg-stone-900 px-3 py-2 font-mono text-xs whitespace-pre-wrap text-stone-100 [overflow-wrap:anywhere]"
    >
      {text}
    </pre>
  );
}

function Decide({ approval }: { approval: Approval }) {
  const { assistant, room } = Route.useParams();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function decide(approve: boolean) {
    setBusy(true);
    setError(undefined);
    try {
      await clientFor(assistant).api.decide(room, approval.id, approve);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-col gap-1 border-b border-amber-300 bg-amber-50 px-3 py-2 text-sm">
      <div className="flex items-baseline justify-between gap-2">
        <span className="min-w-0 [overflow-wrap:anywhere]">{approval.summary}</span>
        <span className="flex shrink-0 gap-2">
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(true)}
            className="rounded bg-emerald-700 px-2 py-0.5 text-white disabled:opacity-50"
          >
            {m.room.approvals.approve}
          </button>
          <button
            type="button"
            disabled={busy}
            onClick={() => void decide(false)}
            className="rounded border border-stone-300 px-2 py-0.5 disabled:opacity-50"
          >
            {m.room.approvals.deny}
          </button>
        </span>
      </div>
      {error !== undefined && <p className="text-red-700">{error}</p>}
    </div>
  );
}
