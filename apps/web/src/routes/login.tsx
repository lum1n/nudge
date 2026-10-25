import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useRef, useState } from "react";
import { renderSVG } from "uqr";
import {
  ApiError,
  finishQrSignIn,
  pair,
  type SignInResponse,
  signIn,
  startQrSignIn,
} from "../api.ts";
import { m } from "../i18n/index.ts";

export const Route = createFileRoute("/login")({ component: Login });

/** A pairing code, from the apps or `nudge pair`: two groups of four, dash optional, any case. */
const PAIRING_CODE = /^[0-9a-z]{4}-?[0-9a-z]{4}$/i;
/** How often the page asks whether the app approved its QR code. */
const POLL_MS = 2000;

function Login() {
  const navigate = useNavigate();
  const [token, setToken] = useState("");
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [remember, setRemember] = useState(false);
  // Read when the app approves, which may be after the box was ticked.
  const rememberRef = useRef(remember);
  rememberRef.current = remember;

  async function submit(value: string) {
    setBusy(true);
    setError(undefined);
    try {
      const trimmed = value.trim();
      const code = PAIRING_CODE.test(trimmed);
      const assistant = await (code ? pair(trimmed, remember) : signIn(trimmed, remember));
      if (assistant === undefined)
        setError(code ? m.setup.login.unknownCode : m.setup.login.unknownToken);
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

  // A QR code for the Nudge app on a phone that is signed in: it approves, and this page pairs.
  const [qr, setQr] = useState<SignInResponse>();
  const [qrError, setQrError] = useState<string>();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let started: SignInResponse | undefined;
    const tick = async () => {
      try {
        if (started === undefined || started.expiresAt <= Date.now()) {
          started = await startQrSignIn();
          if (stopped) return;
          setQr(started);
        } else {
          const assistant = await finishQrSignIn(started, rememberRef.current);
          if (stopped) return;
          if (assistant !== undefined) {
            await navigate({ to: "/$assistant", params: { assistant } });
            return;
          }
        }
      } catch (caught) {
        if (stopped) return;
        // Expired or used, such as after a restart of the server: show a new one.
        if (caught instanceof ApiError && caught.status === 404) started = undefined;
        else if (caught instanceof ApiError && caught.status === 401) {
          // Approved, but its pairing code no longer works: start over.
          started = undefined;
          setQrError(m.setup.login.qrFailed);
        } else setQrError((caught as Error).message);
      }
      timer = setTimeout(() => void tick(), POLL_MS);
    };
    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  function onSubmit(event: FormEvent) {
    event.preventDefault();
    if (token.trim() !== "") void submit(token);
  }

  return (
    <main className="mx-auto flex max-w-sm flex-col gap-4 px-4 pt-24">
      <h1 className="text-2xl font-semibold">Nudge</h1>
      <section className="flex flex-col gap-2">
        <p className="text-sm text-stone-700">{m.setup.login.scan}</p>
        {qr === undefined ? (
          <div className="aspect-square w-48 self-center rounded bg-stone-100" />
        ) : (
          // On the phone itself, a tap opens the app.
          <a
            href={qr.link}
            aria-label={m.setup.login.qr}
            className="w-48 self-center"
            // uqr's SVG, from a link the server made.
            dangerouslySetInnerHTML={{ __html: renderSVG(qr.link, { border: 1 }) }}
          />
        )}
        {qrError !== undefined && <p className="text-sm text-red-700">{qrError}</p>}
      </section>
      <p className="text-center text-sm text-stone-500">{m.setup.login.or}</p>
      <form onSubmit={onSubmit} className="flex flex-col gap-3">
        <label className="flex flex-col gap-1 text-sm">
          {m.setup.login.token}
          <input
            type="password"
            autoComplete="off"
            value={token}
            onChange={(event) => setToken(event.target.value)}
            placeholder={m.setup.login.tokenPlaceholder}
            className="rounded border border-stone-300 bg-white px-3 py-2 font-mono"
          />
        </label>
        <label className="flex items-center gap-2 text-sm text-stone-700">
          <input
            type="checkbox"
            checked={remember}
            onChange={(event) => setRemember(event.target.checked)}
          />
          {m.setup.login.remember}
        </label>
        <button
          type="submit"
          disabled={busy || token.trim() === ""}
          className="rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
        >
          {busy ? m.setup.login.signingIn : m.setup.login.signIn}
        </button>
        {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      </form>
      <p className="text-sm text-stone-500">{m.setup.login.newHere}</p>
    </main>
  );
}
