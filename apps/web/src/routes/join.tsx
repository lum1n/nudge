import type { Sealed } from "@nudge/client";
import { useQuery } from "@tanstack/react-query";
import { createFileRoute, Link, useNavigate } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import { joinHere } from "../api.ts";
import { readJoinPage } from "../joining.ts";
import { assistantsQuery } from "../queries.ts";

export const Route = createFileRoute("/join")({ component: Join });

/**
 * Where a player's home sends the browser to join an assistant on this server (`joinPage`): the
 * home vouched for them, sealed for this assistant, in the fragment. Joining takes a click, so a
 * link someone else made doesn't sign the browser in as them unasked.
 */
function Join() {
  const navigate = useNavigate();
  const assistants = useQuery(assistantsQuery());
  const [linked, setLinked] = useState<{ assistant: string; assertion: Sealed } | null>();
  const [remember, setRemember] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    setLinked(readJoinPage(location.hash) ?? null);
    // The assertion works once: keep it out of the history and the address bar.
    history.replaceState(null, "", location.pathname);
  }, []);

  async function join() {
    if (!linked) return;
    setBusy(true);
    setError(undefined);
    try {
      await joinHere(linked.assistant, linked.assertion, remember);
      await navigate({ to: "/$assistant", params: { assistant: linked.assistant } });
    } catch (caught) {
      setError((caught as Error).message);
      setBusy(false);
    }
  }

  const name =
    assistants.data?.assistants.find((item) => item.name === linked?.assistant)?.displayName ??
    linked?.assistant;
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-4 pt-24">
      <h1 className="text-2xl font-semibold">Nudge</h1>
      {linked === undefined ? null : linked === null ? (
        <p className="text-sm text-stone-700">
          This page joins an assistant from your home's Other assistants, under Profile. Open it
          from there again.
        </p>
      ) : (
        <>
          <p className="text-sm text-stone-700">
            Your home assistant vouches for you to <span className="font-medium">{name}</span> on{" "}
            {location.host}. You join with your name and picture from home.
          </p>
          <label className="flex items-center gap-2 text-sm text-stone-700">
            <input
              type="checkbox"
              checked={remember}
              onChange={(event) => setRemember(event.target.checked)}
            />
            Remember this device
          </label>
          <button
            type="button"
            disabled={busy || error !== undefined}
            onClick={() => void join()}
            className="rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-40"
          >
            Join {name}
          </button>
        </>
      )}
      {error !== undefined && (
        <p className="text-sm text-red-700">
          {error} Ask for the link again from your home, under Profile.
        </p>
      )}
      <Link to="/login" className="text-center text-sm text-stone-500 underline">
        Sign in another way
      </Link>
    </main>
  );
}
