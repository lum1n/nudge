import type { SetupInfoResponse } from "@nudge/client";
import { createFileRoute, Link } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { renderSVG } from "uqr";
import {
  ApiError,
  checkSetupCode,
  checkSetupKey,
  clientFor,
  serverApi,
  setupInfo,
  setUpServer,
} from "../api.ts";
import { slugOf } from "../slug.ts";

export const Route = createFileRoute("/setup")({ component: Setup });

/** Where people get a key for each provider setup offers. */
const KEY_PAGES: Record<string, string> = {
  anthropic: "https://console.anthropic.com/settings/keys",
  openai: "https://platform.openai.com/api-keys",
};

type Step = "code" | "assistant" | "model" | "you" | "done";

/**
 * The setup wizard (ADR 11): a server with no config prints a one-time code and a link here. It
 * asks for the code, a name for the assistant, a model and its key, and the person's name; then
 * signs this device in, offers a QR code for the phone, and the recovery kit.
 */
function Setup() {
  const [info, setInfo] = useState<SetupInfoResponse>();
  const [step, setStep] = useState<Step>("code");
  const [code, setCode] = useState("");
  const [name, setName] = useState("");
  const [slug, setSlug] = useState<string>();
  const [provider, setProvider] = useState<string>();
  const [modelId, setModelId] = useState<string>();
  const [key, setKey] = useState("");
  const [keyChecked, setKeyChecked] = useState(false);
  const [you, setYou] = useState("");
  const [backups, setBackups] = useState(true);
  const [done, setDone] = useState<{ assistant: string; playerId: string }>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    void setupInfo("").then(setInfo, (caught: Error) => setError(caught.message));
    // The printed link has the code after `#`, which never reaches the server's logs.
    const linked = new URLSearchParams(location.hash.slice(1)).get("code");
    if (linked !== null) {
      history.replaceState(null, "", location.pathname);
      setCode(linked);
    }
  }, []);

  const local = info?.local.find((server) => server.id === provider);
  const offered = info?.providers.find((p) => p.id === provider);
  const assistant = slug ?? slugOf(name);

  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 410
          ? "Setup closed: the server is set up already, or took too many wrong codes. Restart it for a new code."
          : (caught as Error).message,
      );
    } finally {
      setBusy(false);
    }
  }

  function chooseProvider(id: string) {
    setProvider(id);
    setKeyChecked(false);
    const found = info?.providers.find((p) => p.id === id);
    const server = info?.local.find((s) => s.id === id);
    setModelId(found?.recommended ?? server?.models[0]);
  }

  if (info === undefined)
    return <Page title="Set up Nudge">{error ? <Problem text={error} /> : <p>Loading…</p>}</Page>;
  if (!info.open && step !== "done")
    return (
      <Page title="Nudge is set up">
        <p className="text-stone-700">This server is set up already.</p>
        <Link to="/login" className="underline">
          Sign in
        </Link>
      </Page>
    );

  switch (step) {
    case "code":
      return (
        <Page title="Set up Nudge">
          <Form
            onSubmit={() =>
              run(async () => {
                await checkSetupCode("", code.trim());
                setStep("assistant");
              })
            }
          >
            <Field label="Setup code" hint="The server printed it when it started.">
              <input
                value={code}
                onChange={(event) => setCode(event.target.value)}
                autoComplete="off"
                placeholder="ABCD-EFGH-JKMN"
                className="rounded border border-stone-300 bg-white px-3 py-2 font-mono uppercase"
              />
            </Field>
            <Submit busy={busy} disabled={code.trim() === ""} label="Continue" />
            {error && <Problem text={error} />}
          </Form>
        </Page>
      );
    case "assistant":
      return (
        <Page title="Name your assistant" back={() => setStep("code")}>
          <Form onSubmit={() => setStep("model")}>
            <Field label="Its name" hint="What it calls itself. You can change it later.">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                autoFocus
                placeholder="Robin"
                className="rounded border border-stone-300 bg-white px-3 py-2"
              />
            </Field>
            <Field
              label="In its address"
              hint="Part of every address of the people here, so this one stays."
            >
              <input
                value={assistant}
                onChange={(event) => setSlug(slugOf(event.target.value))}
                className="rounded border border-stone-300 bg-white px-3 py-2 font-mono"
              />
            </Field>
            <Submit disabled={name.trim() === "" || assistant === ""} label="Continue" />
          </Form>
        </Page>
      );
    case "model":
      return (
        <Page title="Choose its model" back={() => setStep("assistant")}>
          <Form
            onSubmit={() =>
              run(async () => {
                if (local === undefined && !keyChecked) {
                  await checkSetupKey("", { code, provider: provider!, key: key.trim() });
                  setKeyChecked(true);
                }
                setStep("you");
              })
            }
          >
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm">Who runs the model</legend>
              {info.providers.map((p) => (
                <Choice
                  key={p.id}
                  checked={provider === p.id}
                  onChange={() => chooseProvider(p.id)}
                  label={p.name}
                  detail="With your own API key"
                />
              ))}
              {info.local.map((server) => (
                <Choice
                  key={server.id}
                  checked={provider === server.id}
                  onChange={() => chooseProvider(server.id)}
                  label={server.name}
                  detail="Running on this machine; no key"
                />
              ))}
            </fieldset>
            {(offered !== undefined || local !== undefined) && (
              <Field label="Model">
                <select
                  value={modelId}
                  onChange={(event) => setModelId(event.target.value)}
                  className="rounded border border-stone-300 bg-white px-3 py-2"
                >
                  {offered?.models.map((model) => (
                    <option key={model.id} value={model.id}>
                      {model.name}
                    </option>
                  ))}
                  {local?.models.map((model) => (
                    <option key={model} value={model}>
                      {model}
                    </option>
                  ))}
                </select>
              </Field>
            )}
            {offered !== undefined && (
              <Field
                label="API key"
                hint={
                  <>
                    Kept encrypted on this server, never shown again.{" "}
                    {KEY_PAGES[offered.id] && (
                      <a
                        href={KEY_PAGES[offered.id]}
                        target="_blank"
                        rel="noreferrer"
                        className="underline"
                      >
                        Get one
                      </a>
                    )}
                  </>
                }
              >
                <input
                  type="password"
                  autoComplete="off"
                  value={key}
                  onChange={(event) => {
                    setKey(event.target.value);
                    setKeyChecked(false);
                  }}
                  className="rounded border border-stone-300 bg-white px-3 py-2 font-mono"
                />
              </Field>
            )}
            <Submit
              busy={busy}
              disabled={
                provider === undefined ||
                modelId === undefined ||
                (local === undefined && key.trim() === "")
              }
              label={busy ? "Trying the key…" : "Continue"}
            />
            {error && <Problem text={error} />}
          </Form>
        </Page>
      );
    case "you":
      return (
        <Page title="And you?" back={() => setStep("model")}>
          <Form
            onSubmit={() =>
              run(async () => {
                setDone(
                  await setUpServer({
                    code,
                    assistant: { name: assistant, displayName: name.trim() },
                    model: { provider: provider!, modelId: modelId! },
                    ...(local === undefined ? { key: key.trim() } : { local: local.id }),
                    you: { displayName: you.trim() },
                    publicUrl: location.origin,
                    backups,
                  }),
                );
                setStep("done");
              })
            }
          >
            <Field
              label="Your name"
              hint={`You will be ${name.trim() || "the assistant"}'s first person, its admin, and this server's owner.`}
            >
              <input
                value={you}
                onChange={(event) => setYou(event.target.value)}
                autoFocus
                className="rounded border border-stone-300 bg-white px-3 py-2"
              />
            </Field>
            <label className="flex items-start gap-2 text-sm text-stone-700">
              <input
                type="checkbox"
                checked={backups}
                onChange={(event) => setBackups(event.target.checked)}
                className="mt-1"
              />
              <span>
                Back up every night, keeping two weeks, beside the data. Copy them somewhere else
                too: a backup on the same disk won't survive the disk.
              </span>
            </label>
            <Submit
              busy={busy}
              disabled={you.trim() === ""}
              label={busy ? "Setting up…" : "Set up"}
            />
            {error && <Problem text={error} />}
          </Form>
        </Page>
      );
    case "done":
      return <Done assistant={done!.assistant} playerId={done!.playerId} name={name.trim()} />;
  }
}

/** After setup: the phone's QR code, the recovery kit, and the way in. */
function Done({
  assistant,
  playerId,
  name,
}: {
  assistant: string;
  playerId: string;
  name: string;
}) {
  const [pairing, setPairing] = useState<{ link: string; code: string }>();
  const [passphrase, setPassphrase] = useState("");
  const [again, setAgain] = useState("");
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<string>();

  useEffect(() => {
    void clientFor(assistant)
      .api.pairingCode(playerId)
      .then(setPairing, (caught: Error) => setError(caught.message));
  }, [assistant, playerId]);

  async function saveKit(event: FormEvent) {
    event.preventDefault();
    setError(undefined);
    try {
      const { kit } = await serverApi().recoveryKit(passphrase);
      const url = URL.createObjectURL(new Blob([kit], { type: "application/json" }));
      const link = document.createElement("a");
      link.href = url;
      link.download = `nudge-recovery-kit-${location.hostname}.json`;
      link.click();
      URL.revokeObjectURL(url);
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    }
  }

  return (
    <Page title={`${name} is ready`}>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Your phone</h2>
        <p className="text-sm text-stone-700">
          Scan this with the Nudge app, or type the code {pairing?.code ?? "…"} in it. It works
          once, for ten minutes.
        </p>
        {pairing && (
          <div
            className="w-48 self-center"
            // uqr's SVG, from a link the server made.
            dangerouslySetInnerHTML={{ __html: renderSVG(pairing.link, { border: 1 }) }}
          />
        )}
      </section>
      <section className="flex flex-col gap-2">
        <h2 className="font-medium">Recovery kit</h2>
        <p className="text-sm text-stone-700">
          With it and a backup, everything here can be brought back. Keep it somewhere other than
          this server, with the passphrase in your password manager.
        </p>
        <form onSubmit={saveKit} className="flex flex-col gap-2">
          <input
            type="password"
            placeholder="Passphrase, 8 characters or more"
            value={passphrase}
            onChange={(event) => setPassphrase(event.target.value)}
            autoComplete="new-password"
            className="rounded border border-stone-300 bg-white px-3 py-2"
          />
          <input
            type="password"
            placeholder="The same again"
            value={again}
            onChange={(event) => setAgain(event.target.value)}
            autoComplete="new-password"
            className="rounded border border-stone-300 bg-white px-3 py-2"
          />
          <Submit
            disabled={passphrase.length < 8 || passphrase !== again}
            label={saved ? "Saved; save it again" : "Save the recovery kit"}
          />
        </form>
      </section>
      {error && <Problem text={error} />}
      <Link
        to="/$assistant"
        params={{ assistant }}
        className="rounded bg-stone-900 px-3 py-2 text-center text-white"
      >
        Open {name}
      </Link>
    </Page>
  );
}

function Page({
  title,
  back,
  children,
}: {
  title: string;
  back?: () => void;
  children: ReactNode;
}) {
  return (
    <main className="mx-auto flex max-w-sm flex-col gap-5 px-4 pt-16 pb-16">
      {back && (
        <button type="button" onClick={back} className="self-start text-sm text-stone-500">
          ← Back
        </button>
      )}
      <h1 className="text-2xl font-semibold">{title}</h1>
      {children}
    </main>
  );
}

function Form({ onSubmit, children }: { onSubmit: () => void; children: ReactNode }) {
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        onSubmit();
      }}
      className="flex flex-col gap-4"
    >
      {children}
    </form>
  );
}

function Field({
  label,
  hint,
  children,
}: {
  label: string;
  hint?: ReactNode;
  children: ReactNode;
}) {
  return (
    <label className="flex flex-col gap-1 text-sm">
      {label}
      {children}
      {hint && <span className="text-stone-500">{hint}</span>}
    </label>
  );
}

function Choice(props: { checked: boolean; onChange: () => void; label: string; detail: string }) {
  return (
    <label className="flex items-center gap-3 rounded border border-stone-300 bg-white px-3 py-2">
      <input type="radio" checked={props.checked} onChange={props.onChange} />
      <span className="flex flex-col">
        <span>{props.label}</span>
        <span className="text-xs text-stone-500">{props.detail}</span>
      </span>
    </label>
  );
}

function Submit({ busy, disabled, label }: { busy?: boolean; disabled?: boolean; label: string }) {
  return (
    <button
      type="submit"
      disabled={busy || disabled}
      className="rounded bg-stone-900 px-3 py-2 text-white disabled:opacity-50"
    >
      {label}
    </button>
  );
}

function Problem({ text }: { text: string }) {
  return <p className="text-sm text-red-700">{text}</p>;
}
