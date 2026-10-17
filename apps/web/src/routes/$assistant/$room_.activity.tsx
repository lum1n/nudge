import type { TimelineItem, ToolPart } from "@nudge/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { useMemo } from "react";
import { useRoom } from "../../api.ts";
import { activity, progressLine } from "../../assistant-runtime.ts";

export const Route = createFileRoute("/$assistant/$room_/activity")({ component: Activity });

/** What happened behind the room's chat: tool calls, thinking, nudges, watches, approvals. */
function Activity() {
  const { assistant, room } = Route.useParams();
  const held = useRoom(assistant, room);
  const timeline = held?.state.timeline;
  // Newest first: what the assistant is doing now is what one comes here for.
  const items = useMemo(
    () => (timeline === undefined ? [] : activity(timeline).reverse()),
    [timeline],
  );

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-1">
        <h2 className="text-lg font-medium">Activity</h2>
        <Link
          to="/$assistant/$room"
          params={{ assistant, room }}
          className="text-sm text-stone-600 hover:underline"
        >
          Back to the room
        </Link>
      </div>
      {held?.state.status === "gone" ? (
        <p className="text-red-700">
          {held.state.reason === "removed" ? "You were removed from this room." : "No such room."}
        </p>
      ) : held?.state.view === undefined ? (
        <p className="text-stone-500">Connecting…</p>
      ) : (
        <>
          {items.length === 0 && (
            <p className="text-sm text-stone-500">
              Nothing yet: tool calls, nudges, watches and approvals show up here.
            </p>
          )}
          <ul className="flex flex-col gap-2">
            {items.map((item) => (
              <li key={item.id}>
                <ActivityRow item={item} />
              </li>
            ))}
          </ul>
          {held.state.canLoadEarlier && (
            <button
              type="button"
              onClick={() => held.store.loadEarlier()}
              className="self-center text-sm text-stone-500 underline"
            >
              Load earlier
            </button>
          )}
          {held.state.earlierError !== undefined && (
            <p className="self-center text-sm text-red-700">{held.state.earlierError}</p>
          )}
        </>
      )}
    </section>
  );
}

function ActivityRow({ item }: { item: TimelineItem }) {
  switch (item.type) {
    case "nudge":
      return (
        <p className="rounded border border-amber-200 bg-amber-50 px-3 py-2 text-sm [overflow-wrap:anywhere]">
          <span className="text-stone-500">{new Date(item.firedAt).toLocaleString()} · </span>
          {item.privateTo !== undefined && item.text === ""
            ? `A nudge for ${item.privateTo.displayName}`
            : item.text}
        </p>
      );
    case "approval":
      return (
        <p className="rounded border border-stone-200 bg-white px-3 py-2 text-sm [overflow-wrap:anywhere]">
          {item.privateTo !== undefined && item.summary === ""
            ? `An approval for ${item.privateTo.displayName} ended`
            : `${item.decidedBy ?? "Someone"} ${item.status === "denied" ? "denied" : "approved"} ${item.summary}${item.status === "failed" ? " — it failed" : ""}`}
        </p>
      );
    case "answer":
      return (
        <div className="flex flex-col gap-1 rounded border border-stone-200 bg-white px-3 py-2">
          {item.parts.map((part, index) =>
            part.type === "tool" ? (
              <ToolRow key={part.callId} part={part} />
            ) : part.type === "reasoning" ? (
              <details key={index} className="text-sm text-stone-500">
                <summary className="cursor-pointer">Thinking</summary>
                <p className="whitespace-pre-wrap">{part.text}</p>
              </details>
            ) : null,
          )}
          {item.status === "running" && <p className="text-xs text-stone-500">Working…</p>}
        </div>
      );
    default:
      return null;
  }
}

function ToolRow({ part }: { part: ToolPart }) {
  const state =
    part.result !== undefined
      ? part.isError
        ? "failed"
        : "done"
      : ((part.output === undefined ? undefined : progressLine(part.output)) ?? part.status);
  return (
    <details className="text-sm">
      <summary className="cursor-pointer [overflow-wrap:anywhere]">
        <span className="font-mono">{part.name}</span>{" "}
        <span className={part.isError ? "text-red-700" : "text-stone-500"}>— {state}</span>
      </summary>
      <pre className="mt-1 max-h-60 overflow-auto rounded bg-stone-100 p-2 text-xs whitespace-pre-wrap">
        {JSON.stringify(part.args, null, 2)}
      </pre>
      {(part.result ?? part.output) !== undefined && (
        <pre className="mt-1 max-h-60 overflow-auto rounded bg-stone-100 p-2 text-xs whitespace-pre-wrap">
          {part.result ?? part.output}
        </pre>
      )}
    </details>
  );
}
