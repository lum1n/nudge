import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { pair, signIn } from "../api.ts";

export const Route = createFileRoute("/login")({ component: Login });

/** What `nudge pair` prints: two groups of four, dash optional, any case. */
const PAIRING_CODE = /^[0-9a-z]{4}-?[0-9a-z]{4}$/i;

function Login() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  async function submit(value: string) {
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = value.trim();
      const code = PAIRING_CODE.test(trimmed);
      const assistant = await (code ? pair(trimmed) : signIn(trimmed));
      if (assistant === undefined)
        setError(code ? "That code is unknown or expired." : "No assistant here knows that token.");
      else await navigate({ to: "/$assistant", params: { assistant } });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  // `nudge invite` prints /login#token=…: the fragment never reaches the server or its logs.
  // A link opened in a tab that already shows this page only changes the hash.
  useEffect(() => {
    const fromLink = () => {
      const linked = new URLSearchParams(location.hash.slice(1)).get("token");
      if (linked === null) return;
      history.replaceState(null, "", location.pathname);
      setToken(linked);
      void submit(linked);
    };
    fromLink();
    addEventListener("hashchange", fromLink);
    return () => removeEventListener("hashchange", fromLink);
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() !== "") void submit(token);
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-4 pt-24">
      <h1 className="text-2xl font-semibold">Nudge</h1>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          Token or pairing code
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder="nudge_… or ABCD-1234"
            className="rounded border border-stone-300 bg-white px-3 py-2 font-mono"
          />
        </label>
        <button
          type="submit"
          disabled={busy || token.trim() === ""}
          className="rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? "Signing in…" : "Sign in"}
        </button>
        {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      </form>
      <p className="text-sm text-stone-500">
        Ask the owner for an invite: <code>nudge invite &lt;name&gt;</code> prints a token and a
        sign-in link, <code>nudge pair &lt;player&gt;</code> a pairing code.
      </p>
    </main>
  );
}
