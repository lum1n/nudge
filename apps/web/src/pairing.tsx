import type { Api, PairingCodeResponse, Player } from "@nudge/client";
import { useEffect, useState } from "react";
import { renderSVG } from "uqr";
import { dateLocale, m } from "./i18n/index.ts";

/** A pairing code an admin made: whom it signs in, and whether that is the admin themselves. */
export type Pairing = PairingCodeResponse & { displayName: string; self: boolean };

type Pairs = Pick<Api, "createPlayer" | "pairingCode">;

/** Makes a player called `displayName`, and a pairing code that signs their app in as them. */
export async function invite(api: Pairs, displayName: string): Promise<Pairing> {
  const name = displayName.trim();
  if (name === "") throw new Error(m.setup.pairing.noName);
  const player = await api.createPlayer(name);
  return { ...(await api.pairingCode(player.id)), displayName: player.displayName, self: false };
}

/** A pairing code that signs another of `me`'s devices in as them. */
export async function pairAnotherDevice(api: Pairs, me: Player): Promise<Pairing> {
  return { ...(await api.pairingCode(me.id)), displayName: me.displayName, self: true };
}

/** The server a pairing link names, which the apps ask for beside the code; undefined if none. */
export function serverOf(link: string): string | undefined {
  try {
    return new URL(link).searchParams.get("server") ?? undefined;
  } catch {
    return undefined;
  }
}

/**
 * A pairing code with its QR code: the `nudge://pair` link the apps scan, as `nudge pair` prints
 * it. On the phone itself, a tap on the QR code opens the app.
 */
export function PairingCard({ pairing, onDone }: { pairing: Pairing; onDone?: () => void }) {
  const expired = useExpired(pairing.expiresAt);
  const server = serverOf(pairing.link);
  const until = new Date(pairing.expiresAt).toLocaleTimeString(dateLocale(), {
    hour: "2-digit",
    minute: "2-digit",
  });
  const [copied, setCopied] = useState(false);

  async function copy() {
    await navigator.clipboard.writeText(pairing.link);
    setCopied(true);
  }

  return (
    <div className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-4">
      <p className="text-sm text-stone-700">
        {pairing.self ? m.setup.pairing.scanSelf : m.setup.pairing.scanOther(pairing.displayName)}
        {server !== undefined && (
          <>
            {" "}
            {m.setup.pairing.serverBefore}
            <span className="font-mono">{server}</span>
            {m.setup.pairing.serverAfter}
          </>
        )}
      </p>
      {expired ? (
        <p className="text-sm text-red-700">{m.setup.pairing.expired}</p>
      ) : (
        <>
          <a
            href={pairing.link}
            aria-label={m.setup.pairing.qr(pairing.displayName)}
            className="w-48 self-center"
            // uqr's SVG, from a link the server made.
            dangerouslySetInnerHTML={{ __html: renderSVG(pairing.link, { border: 1 }) }}
          />
          <p className="text-center font-mono text-2xl tracking-widest">{pairing.code}</p>
          <p className="text-center text-sm text-stone-500">
            {m.setup.pairing.once(until, pairing.displayName)}
          </p>
        </>
      )}
      <div className="flex flex-wrap justify-center gap-2">
        {!expired && (
          <button
            type="button"
            onClick={() => void copy()}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm"
          >
            {copied ? m.setup.pairing.copied : m.setup.pairing.copy}
          </button>
        )}
        {onDone !== undefined && (
          <button
            type="button"
            onClick={onDone}
            className="rounded border border-stone-300 px-3 py-1.5 text-sm"
          >
            {m.setup.pairing.done}
          </button>
        )}
      </div>
    </div>
  );
}

/** Whether `at` has passed, turning true when it does. */
function useExpired(at: number): boolean {
  const [expired, setExpired] = useState(() => at <= Date.now());
  useEffect(() => {
    setExpired(at <= Date.now());
    const timer = setTimeout(() => setExpired(true), Math.max(0, at - Date.now()));
    return () => clearTimeout(timer);
  }, [at]);
  return expired;
}
