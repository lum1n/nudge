import type {
  BackupState,
  ExtensionSetup,
  RoomKind,
  ServerAssistant,
  SetBackupRemoteRequest,
  TokenInfo,
} from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, type ReactNode, useEffect, useState } from "react";
import { ApiError, asOwner, clientFor, serverApi, signInToServer, useRoomList } from "../../api.ts";
import { type Appearance, lookOf } from "../../avatar/appearance.ts";
import { Avatar } from "../../avatar/Avatar.tsx";
import { LookPicker } from "../../avatar/LookPicker.tsx";
import { invite, pairAnotherDevice, type Pairing, PairingCard } from "../../pairing.tsx";
import { BUDGET_DEFAULTS, type BudgetDraft, budgetDraftOf, budgetOf } from "../../budget.ts";
import { dateLocale, m } from "../../i18n/index.ts";
import { meQuery } from "../../queries.ts";
import { ObjectFields, RoomsContext, type Schema, withoutDefaults } from "../../schema-form.tsx";

export const Route = createFileRoute("/$assistant/settings")({ component: Settings });

/** One extension as the page edits it, before it is saved. */
type Draft = {
  from: string;
  enabled: boolean;
  settings: Record<string, unknown>;
  rooms?: RoomKind[];
};

const KINDS: RoomKind[] = ["lobby", "personal", "shared"];

function draftOf(setup: ExtensionSetup): Draft {
  return {
    from: setup.from,
    enabled: setup.enabled,
    settings: setup.settings,
    ...(setup.rooms === undefined ? {} : { rooms: setup.rooms }),
  };
}

/**
 * What an admin sets up for everyone: how the robot looks, who uses it and is signed in, what it
 * may spend, the extensions.
 */
function Settings() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  if (me.data !== undefined && !me.data.admin) return <Page>{m.settings.onlyAdmin}</Page>;
  return (
    <>
      <Robot />
      <People />
      <Budget />
      <Clients />
      <Backups />
      <Extensions />
    </>
  );
}

/** A remote target as the form edits it, credentials included. */
type RemoteDraft = {
  type: "s3" | "webdav";
  endpoint: string;
  bucket: string;
  region: string;
  prefix: string;
  url: string;
  user: string;
  secret: string;
};

function remoteDraft(state: BackupState | undefined): RemoteDraft {
  const remote = state?.remote;
  return {
    type: remote?.type ?? "s3",
    endpoint: remote?.type === "s3" ? remote.endpoint : "",
    bucket: remote?.type === "s3" ? remote.bucket : "",
    region: remote?.type === "s3" ? (remote.region ?? "") : "",
    prefix: remote?.type === "s3" ? (remote.prefix ?? "") : "",
    url: remote?.type === "webdav" ? remote.url : "",
    user: state?.credentials?.user ?? "",
    secret: "",
  };
}

/** What the server is sent for a draft: empty fields left out, so their defaults apply. */
function remoteRequest(draft: RemoteDraft): SetBackupRemoteRequest {
  const credentials = {
    ...(draft.user.trim() === "" ? {} : { user: draft.user.trim() }),
    ...(draft.secret === "" ? {} : { secret: draft.secret }),
  };
  if (draft.type === "webdav") return { type: "webdav", url: draft.url.trim(), ...credentials };
  return {
    type: "s3",
    endpoint: draft.endpoint.trim(),
    bucket: draft.bucket.trim(),
    ...(draft.region.trim() === "" ? {} : { region: draft.region.trim() }),
    ...(draft.prefix.trim() === "" ? {} : { prefix: draft.prefix.trim() }),
    ...credentials,
  };
}

/**
 * The server's backups (ADR 8), for its owners: how they go, and where they are copied off the
 * server. They are encrypted before they leave, so the bucket or folder only holds ciphertext.
 */
function Backups() {
  const { assistant } = Route.useParams();
  const queryClient = useQueryClient();
  const key = ["server", "backups"];
  const state = useQuery({ queryKey: key, queryFn: () => serverApi().backups(), retry: false });
  const [draft, setDraft] = useState<RemoteDraft>();
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();
  const [note, setNote] = useState<string>();

  useEffect(() => {
    if (state.data !== undefined) setDraft(remoteDraft(state.data));
  }, [state.data]);

  async function run(what: string, work: () => Promise<string | undefined>) {
    setBusy(what);
    setError(undefined);
    setNote(undefined);
    try {
      setNote(await work());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  const status = state.error instanceof ApiError ? state.error.status : undefined;
  // Not the server's own backups to show: nudge-server's API without them, or another host.
  if (status === 404) return null;
  const intro = (
    <div>
      <h2 className="text-lg font-medium">{m.settings.backups.title}</h2>
      <p className="text-sm text-stone-600">{m.settings.backups.intro}</p>
    </div>
  );
  if (status === 401 || status === 403)
    return (
      <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
        {intro}
        <p className="text-sm text-stone-600">{m.settings.backups.ownersOnly}</p>
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="button"
            disabled={busy !== undefined}
            onClick={() =>
              void run("sign-in", async () => {
                await signInToServer(assistant);
                await queryClient.invalidateQueries({ queryKey: key });
                return undefined;
              })
            }
            className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy === "sign-in" ? m.settings.backups.signingIn : m.settings.backups.signIn}
          </button>
          {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </section>
    );
  if (state.error) return <Page>{state.error.message}</Page>;
  if (state.data === undefined || draft === undefined) return <Page>{m.common.loading}</Page>;

  const backups = state.data;
  const saved = (next: BackupState) => {
    queryClient.setQueryData(key, next);
    setDraft(remoteDraft(next));
  };
  const field = (
    name: keyof RemoteDraft,
    label: string,
    options: { placeholder?: string; type?: string; hint?: string } = {},
  ) => (
    <label className="flex flex-col gap-1 text-sm">
      <span className="font-medium">{label}</span>
      <input
        type={options.type ?? "text"}
        value={draft[name]}
        placeholder={options.placeholder}
        autoComplete={options.type === "password" ? "new-password" : "off"}
        onChange={(event) => setDraft({ ...draft, [name]: event.target.value })}
        className="rounded border border-stone-300 bg-white px-3 py-2"
      />
      {options.hint !== undefined && <span className="text-stone-500">{options.hint}</span>}
    </label>
  );
  const keptSecret = backups.credentials !== undefined && draft.type === backups.remote?.type;

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      {intro}
      <div className="flex flex-col gap-1 rounded border border-stone-200 bg-white p-3 text-sm">
        <p>
          {backups.on
            ? m.settings.backups.on(backups.everyHours, backups.keep, backups.dir)
            : m.settings.backups.off}
        </p>
        {backups.on && (
          <p className="text-stone-600">
            {backups.lastBackupAt === undefined
              ? m.settings.backups.noneMade
              : m.settings.backups.newest(ago(backups.lastBackupAt))}
            {backups.remote !== undefined &&
              (backups.lastUploadAt === undefined
                ? m.settings.backups.noneUploaded
                : m.settings.backups.lastUploaded(ago(backups.lastUploadAt)))}
          </p>
        )}
        {backups.lastError !== undefined && (
          <p className="text-red-700">
            {m.settings.backups.uploadFailed(
              backups.lastErrorAt ? ago(backups.lastErrorAt) : undefined,
            )}
            : {backups.lastError}
          </p>
        )}
      </div>
      <form
        className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3"
        onSubmit={(event) => {
          event.preventDefault();
          void run("save", async () => {
            saved(await serverApi().setBackupRemote(remoteRequest(draft)));
            return m.settings.backups.savedRemote;
          });
        }}
      >
        <fieldset className="flex flex-wrap gap-4 text-sm">
          <legend className="mb-1 font-medium">{m.settings.backups.copyTo}</legend>
          {(
            [
              ["s3", m.settings.backups.s3],
              ["webdav", m.settings.backups.webdav],
            ] as const
          ).map(([type, label]) => (
            <label key={type} className="flex items-center gap-2">
              <input
                type="radio"
                name="remote-type"
                checked={draft.type === type}
                onChange={() => setDraft({ ...draft, type })}
              />
              {label}
            </label>
          ))}
        </fieldset>
        {draft.type === "s3" ? (
          <div className="grid gap-3 sm:grid-cols-2">
            {field("endpoint", m.settings.backups.endpoint, {
              placeholder: "https://s3.eu-north-1.amazonaws.com",
            })}
            {field("bucket", m.settings.backups.bucket)}
            {field("region", m.settings.backups.region, { hint: m.settings.backups.regionHint })}
            {field("prefix", m.settings.backups.prefix, { placeholder: "nudge/" })}
            {field("user", m.settings.backups.accessKey)}
            {field("secret", m.settings.backups.secretKey, {
              type: "password",
              ...(keptSecret ? { placeholder: m.settings.backups.kept } : {}),
            })}
          </div>
        ) : (
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="sm:col-span-2">
              {field("url", m.settings.backups.url, {
                placeholder: "https://cloud.example/remote.php/dav/files/me/nudge/",
              })}
            </div>
            {field("user", m.settings.backups.user)}
            {field("secret", m.settings.backups.password, {
              type: "password",
              hint: m.settings.backups.passwordHint,
              ...(keptSecret ? { placeholder: m.settings.backups.kept } : {}),
            })}
          </div>
        )}
        {backups.credentials?.from === "env" && (
          <p className="text-sm text-stone-600">{m.settings.backups.fromEnv}</p>
        )}
        <div className="flex flex-wrap items-center gap-2">
          <button
            type="submit"
            disabled={busy !== undefined}
            className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
          >
            {busy === "save" ? m.settings.backups.checking : m.settings.backups.checkAndSave}
          </button>
          {backups.remote !== undefined && (
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() =>
                void run("remove", async () => {
                  saved(await serverApi().removeBackupRemote());
                  return m.settings.backups.stopped;
                })
              }
              className="rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {m.settings.backups.stopCopying}
            </button>
          )}
          {backups.on && (
            <button
              type="button"
              disabled={busy !== undefined}
              onClick={() =>
                void run("now", async () => {
                  const made = await serverApi().backUpNow();
                  await queryClient.invalidateQueries({ queryKey: key });
                  if (made.uploadError !== undefined) throw new Error(made.uploadError);
                  return backups.remote === undefined
                    ? m.settings.backups.made(made.file)
                    : m.settings.backups.madeAndUploaded(made.file);
                })
              }
              className="rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-50"
            >
              {busy === "now" ? m.settings.backups.backingUp : m.settings.backups.backUpNow}
            </button>
          )}
        </div>
        {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
        {note !== undefined && <p className="text-sm text-emerald-700">{note}</p>}
      </form>
    </section>
  );
}

/** How the assistant's robot looks in everyone's apps. Room lists show a change at once. */
function Robot() {
  const { assistant } = Route.useParams();
  const saved = useRoomList(assistant)?.view?.appearance;
  const [draft, setDraft] = useState<Appearance>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const look = draft ?? lookOf(saved);
  const dirty = draft !== undefined && stable(draft) !== stable(lookOf(saved));

  async function save(appearance: Appearance | null) {
    setSaving(true);
    setError(undefined);
    try {
      await clientFor(assistant).api.setAppearance(appearance);
      setDraft(undefined);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.settings.robot.title}</h2>
        <p className="text-sm text-stone-600">{m.settings.robot.intro}</p>
      </div>
      <div className="flex flex-col items-center gap-4 rounded border border-stone-200 bg-white p-4 sm:flex-row sm:items-start">
        <Avatar mood="idle" appearance={look} size={150} className="shrink-0" />
        <div className="flex w-full min-w-0 flex-col gap-3">
          <LookPicker look={look} onChange={setDraft} />
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save(look)}
              className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {m.common.save}
            </button>
            {dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => setDraft(undefined)}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm"
              >
                {m.settings.discard}
              </button>
            )}
            {saved !== undefined && !dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(null)}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm"
              >
                {m.settings.robot.appIcon}
              </button>
            )}
            {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * Pairing codes, each with its QR code for the apps: for someone new, made a player here first, or
 * for another device of the admin's own.
 */
function People() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const queryClient = useQueryClient();
  const [name, setName] = useState("");
  const [pairing, setPairing] = useState<Pairing>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function make(pair: () => Promise<Pairing>) {
    setBusy(true);
    setError(undefined);
    try {
      setPairing(await pair());
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  function onInvite(event: FormEvent) {
    event.preventDefault();
    void make(async () => {
      const made = await invite(clientFor(assistant).api, name);
      setName("");
      await queryClient.invalidateQueries({ queryKey: [assistant, "players"] });
      return made;
    });
  }

  function onAnotherDevice() {
    const self = me.data?.player;
    if (self !== undefined) void make(() => pairAnotherDevice(clientFor(assistant).api, self));
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.settings.people.title}</h2>
        <p className="text-sm text-stone-600">{m.settings.people.intro}</p>
      </div>
      <form onSubmit={onInvite} className="flex flex-wrap gap-2">
        <input
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder={m.settings.people.name}
          aria-label={m.settings.people.name}
          className="min-w-0 flex-1 rounded border border-stone-300 bg-white px-3 py-1.5"
        />
        <button
          type="submit"
          disabled={busy || name.trim() === ""}
          className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
        >
          {m.settings.people.invite}
        </button>
        <button
          type="button"
          disabled={busy || me.data === undefined}
          onClick={onAnotherDevice}
          className="rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-40"
        >
          {m.settings.people.anotherDevice}
        </button>
      </form>
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
      {pairing !== undefined && (
        <PairingCard pairing={pairing} onDone={() => setPairing(undefined)} />
      )}
    </section>
  );
}

/** The budget's fields, in the current language. */
function budgetFields(): { key: keyof BudgetDraft; label: string; hint: string; unit: string }[] {
  const words = m.settings.budget;
  return [
    { key: "monthlyUsd", label: words.monthly, hint: words.monthlyHint, unit: "$" },
    { key: "perPlayerUsd", label: words.perPerson, hint: words.perPersonHint, unit: "$" },
    {
      key: "warnAtPercent",
      label: words.warnAt,
      hint: words.warnAtHint(BUDGET_DEFAULTS.warnAtPercent),
      unit: "%",
    },
    {
      key: "warnUsd",
      label: words.warnUsd,
      hint: words.warnUsdHint(BUDGET_DEFAULTS.warnUsd),
      unit: "$",
    },
  ];
}

/**
 * What the assistant may spend on models a month. It is the server's setting, so only its owners
 * change it: through the server's own API, signed in with this device's server token or the
 * player's own.
 */
function Budget() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const queryClient = useQueryClient();
  const key = [assistant, "server-assistant"];
  const settings = useQuery({
    queryKey: key,
    queryFn: () =>
      asOwner(assistant, async (api) => {
        const found = (await api.assistants()).find((item) => item.name === assistant);
        if (found === undefined) throw new Error(m.settings.budget.noAssistant(assistant));
        return found;
      }),
    enabled: me.data?.admin === true,
    retry: false,
  });
  const [draft, setDraft] = useState<BudgetDraft>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  const savedDraft = budgetDraftOf(settings.data?.budget);
  const shown = draft ?? savedDraft;
  const dirty = draft !== undefined && stable(draft) !== stable(savedDraft);

  async function save() {
    const parsed = budgetOf(shown);
    if ("error" in parsed) {
      setError(parsed.error);
      return;
    }
    setSaving(true);
    setError(undefined);
    try {
      const next = await asOwner(assistant, (api) =>
        api.updateAssistant(assistant, { budget: parsed.budget }),
      );
      queryClient.setQueryData<ServerAssistant>(key, next);
      setDraft(undefined);
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.settings.budget.title}</h2>
        <p className="text-sm text-stone-600">{m.settings.budget.intro}</p>
      </div>
      {settings.error ? (
        <p className="text-sm text-stone-600">
          {settings.error instanceof ApiError && settings.error.status === 403
            ? m.settings.budget.ownerOnly
            : settings.error instanceof ApiError && settings.error.status === 404
              ? m.settings.budget.notHere
              : settings.error.message}
        </p>
      ) : settings.data === undefined ? (
        <p className="text-sm text-stone-600">{m.common.loading}</p>
      ) : (
        <div className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-4">
          <div className="grid gap-3 sm:grid-cols-2">
            {budgetFields().map((field) => (
              <label key={field.key} className="flex flex-col gap-1 text-sm">
                <span className="font-medium">{field.label}</span>
                <span className="flex items-center gap-1">
                  {field.unit === "$" && <span className="text-stone-500">$</span>}
                  <input
                    type="number"
                    inputMode="decimal"
                    min={0}
                    step="any"
                    max={field.unit === "%" ? 100 : undefined}
                    value={shown[field.key]}
                    onChange={(event) => {
                      setSaved(false);
                      setError(undefined);
                      setDraft({ ...shown, [field.key]: event.target.value });
                    }}
                    className="w-32 rounded border border-stone-300 px-2 py-1"
                  />
                  {field.unit === "%" && <span className="text-stone-500">%</span>}
                </span>
                <span className="text-xs text-stone-500">{field.hint}</span>
              </label>
            ))}
          </div>
          <div className="flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!dirty || saving}
              onClick={() => void save()}
              className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-40"
            >
              {saving ? m.settings.saving : m.common.save}
            </button>
            {dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => {
                  setDraft(undefined);
                  setError(undefined);
                }}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm"
              >
                {m.settings.discard}
              </button>
            )}
            {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
            {saved && !dirty && error === undefined && (
              <span className="text-sm text-emerald-700">{m.settings.saved}</span>
            )}
          </div>
        </div>
      )}
    </section>
  );
}

/** Every signed-in app, browser and script, by player, with when each was last used. */
function Clients() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const queryClient = useQueryClient();
  const key = [assistant, "tokens"];
  const enabled = me.data?.admin === true;
  const tokens = useQuery({
    queryKey: key,
    queryFn: () => clientFor(assistant).api.listTokens(),
    enabled,
  });
  const players = useQuery({
    queryKey: [assistant, "players"],
    queryFn: () => clientFor(assistant).api.players(),
    enabled,
  });
  const [revoking, setRevoking] = useState<string>();
  const [error, setError] = useState<string>();

  async function revoke(token: TokenInfo) {
    setRevoking(token.clientId);
    setError(undefined);
    try {
      await clientFor(assistant).api.revoke(token.clientId);
      queryClient.setQueryData<TokenInfo[]>(key, (current) =>
        current?.filter((t) => t.clientId !== token.clientId),
      );
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setRevoking(undefined);
    }
  }

  const names = new Map(players.data?.map((player) => [player.id, player.displayName]));
  // Most recently used first; never used last.
  const sorted = [...(tokens.data ?? [])].sort(
    (a, b) => (b.lastUsedAt ?? 0) - (a.lastUsedAt ?? 0) || b.createdAt - a.createdAt,
  );
  return (
    <section className="mx-auto flex max-w-3xl flex-col gap-3 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.settings.clients.title}</h2>
        <p className="text-sm text-stone-600">{m.settings.clients.intro}</p>
      </div>
      {tokens.error ? (
        <p className="text-sm text-red-700">{tokens.error.message}</p>
      ) : tokens.data === undefined ? (
        <p className="text-sm text-stone-600">{m.common.loading}</p>
      ) : (
        <ul className="divide-y divide-stone-200 rounded border border-stone-200 bg-white">
          {sorted.map((token) => {
            const expired = token.expiresAt !== undefined && token.expiresAt <= Date.now();
            return (
              <li key={token.clientId} className="flex items-center gap-3 p-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate font-medium">
                    {names.get(token.playerId) ?? token.playerId}
                    <span className="font-normal text-stone-600">
                      {" · "}
                      {token.client === undefined
                        ? m.settings.clients.token
                        : `${token.client.name} (${token.client.platform})`}
                    </span>
                    {token.clientId === me.data?.clientId && (
                      <span className="ml-2 text-xs text-emerald-700">
                        {m.settings.clients.thisBrowser}
                      </span>
                    )}
                  </p>
                  <p className="text-sm text-stone-500">
                    {token.lastUsedAt === undefined
                      ? m.settings.clients.neverUsed
                      : m.settings.clients.lastUsed(ago(token.lastUsedAt))}
                    {m.settings.clients.added}
                    {new Date(token.createdAt).toLocaleDateString(dateLocale())}
                    {token.expiresAt !== undefined && (
                      <span className={expired ? "text-red-700" : undefined}>
                        {expired ? m.settings.clients.expired : m.settings.clients.expires}
                        {new Date(token.expiresAt).toLocaleString(dateLocale())}
                      </span>
                    )}
                  </p>
                </div>
                {token.clientId !== me.data?.clientId && (
                  <button
                    type="button"
                    disabled={revoking !== undefined}
                    onClick={() => void revoke(token)}
                    className="shrink-0 rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {revoking === token.clientId
                      ? m.settings.clients.revoking
                      : m.settings.clients.revoke}
                  </button>
                )}
              </li>
            );
          })}
        </ul>
      )}
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

/** `at` as "just now", "5 minutes ago", "yesterday", or a date once over a month ago. */
function ago(at: number): string {
  const relative = new Intl.RelativeTimeFormat(dateLocale(), { numeric: "auto" });
  const minutes = Math.round((Date.now() - at) / 60_000);
  if (minutes < 1) return m.settings.justNow;
  if (minutes < 60) return relative.format(-minutes, "minute");
  const hours = Math.round(minutes / 60);
  if (hours < 24) return relative.format(-hours, "hour");
  const days = Math.round(hours / 24);
  if (days <= 30) return relative.format(-days, "day");
  return m.settings.onDate(new Date(at).toLocaleDateString(dateLocale()));
}

/** The assistant's extensions, set up by an admin: on or off, their settings and rooms. */
function Extensions() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  const queryClient = useQueryClient();
  const key = [assistant, "extension-setups"];
  const setups = useQuery({
    queryKey: key,
    queryFn: () => clientFor(assistant).api.extensionSetups(),
    enabled: me.data?.admin === true,
  });
  // For settings that pick rooms, such as which rooms may use a mail account.
  const rooms = useQuery({
    queryKey: [assistant, "all-rooms"],
    queryFn: () => clientFor(assistant).api.allRooms(),
    enabled: me.data?.admin === true,
  });
  const [drafts, setDrafts] = useState<Draft[]>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (setups.data !== undefined) setDrafts(setups.data.map(draftOf));
  }, [setups.data]);

  if (me.data !== undefined && !me.data.admin)
    return <Page>{m.settings.extensions.onlyAdmin}</Page>;
  if (setups.error)
    return (
      <Page>
        <span className="text-red-700">
          {setups.error instanceof ApiError && setups.error.status === 404
            ? m.settings.extensions.notHere
            : setups.error.message}
        </span>
      </Page>
    );
  if (setups.data === undefined || drafts === undefined) return <Page>{m.common.loading}</Page>;

  const dirty = stable(drafts) !== stable(setups.data.map(draftOf));
  const update = (from: string, change: Partial<Draft>) => {
    setSaved(false);
    setDrafts((current) =>
      current?.map((draft) => (draft.from === from ? { ...draft, ...change } : draft)),
    );
  };

  async function save() {
    if (drafts === undefined || setups.data === undefined) return;
    setSaving(true);
    setError(undefined);
    try {
      const byFrom = new Map(setups.data.map((setup) => [setup.from, setup]));
      const next = await clientFor(assistant).api.saveExtensionSetups(
        drafts
          // One found beside the config is only added once it is turned on.
          .filter((draft) => draft.enabled || byFrom.get(draft.from)?.configured)
          .map((draft) => ({
            from: draft.from,
            enabled: draft.enabled,
            settings: withoutDefaults(draft.settings, byFrom.get(draft.from)?.schema as Schema),
            ...(draft.rooms === undefined ? {} : { rooms: draft.rooms }),
          })),
      );
      queryClient.setQueryData(key, next);
      // Rooms' own lists of extensions changed with it.
      void queryClient.invalidateQueries({ queryKey: [assistant, "room-extensions"] });
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setSaving(false);
    }
  }

  const configured = setups.data.filter((setup) => setup.configured);
  const available = setups.data.filter((setup) => !setup.configured);
  const card = (setup: ExtensionSetup) => (
    <ExtensionCard
      key={setup.from}
      setup={setup}
      draft={drafts.find((draft) => draft.from === setup.from)!}
      onChange={(change) => update(setup.from, change)}
    />
  );

  return (
    <RoomsContext value={rooms.data ?? []}>
      <section className="mx-auto flex max-w-3xl flex-col gap-4 p-3 pb-28 sm:p-4 sm:pb-28">
        <div>
          <h2 className="text-lg font-medium">{m.settings.extensions.title}</h2>
          <p className="text-sm text-stone-600">{m.settings.extensions.intro}</p>
        </div>
        {configured.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
              {m.settings.extensions.added}
            </h3>
            {configured.map(card)}
          </div>
        )}
        {available.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
              {m.settings.extensions.notAdded}
            </h3>
            {available.map(card)}
          </div>
        )}
        {(dirty || error !== undefined || saved) && (
          <div className="fixed inset-x-0 bottom-0 z-10 border-t border-stone-200 bg-white/95 pb-[env(safe-area-inset-bottom)] backdrop-blur">
            <div className="mx-auto flex max-w-3xl flex-wrap items-center gap-3 px-3 py-3 sm:px-4">
              <p className="min-w-0 flex-1 text-sm">
                {error !== undefined ? (
                  <span className="text-red-700">{error}</span>
                ) : dirty ? (
                  m.settings.extensions.unsaved
                ) : (
                  <span className="text-emerald-700">{m.settings.extensions.installed}</span>
                )}
              </p>
              {dirty && (
                <span className="flex shrink-0 gap-2">
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => {
                      setError(undefined);
                      setDrafts(setups.data.map(draftOf));
                    }}
                    className="rounded border border-stone-300 px-3 py-1.5 text-sm disabled:opacity-50"
                  >
                    {m.settings.discard}
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {saving ? m.settings.saving : m.common.save}
                  </button>
                </span>
              )}
            </div>
          </div>
        )}
      </section>
    </RoomsContext>
  );
}

/** JSON with object keys sorted, so an edit undone compares equal again. */
function stable(value: unknown): string {
  return JSON.stringify(value, (_, item: unknown) =>
    typeof item === "object" && item !== null && !Array.isArray(item)
      ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b)))
      : item,
  );
}

function Page({ children }: { children: ReactNode }) {
  return <p className="mx-auto max-w-3xl p-4 text-stone-600">{children}</p>;
}

function ExtensionCard({
  setup,
  draft,
  onChange,
}: {
  setup: ExtensionSetup;
  draft: Draft;
  onChange: (change: Partial<Draft>) => void;
}) {
  const [open, setOpen] = useState(false);
  const schema = setup.schema as Schema | undefined;
  const hasFields = schema !== undefined && Object.keys(schema.properties ?? {}).length > 0;
  const toggleId = `on-${setup.from}`;
  return (
    <article
      className={`flex flex-col gap-2 rounded border bg-white p-3 ${
        draft.enabled ? "border-stone-300" : "border-stone-200"
      }`}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <h4 className="font-medium">
            {setup.name ?? setup.from}
            {setup.version !== undefined && (
              <span className="ml-2 text-xs font-normal text-stone-500">{setup.version}</span>
            )}
          </h4>
          {setup.description !== undefined && (
            <p className="text-sm text-stone-600">{setup.description}</p>
          )}
        </div>
        <label htmlFor={toggleId} className="flex shrink-0 cursor-pointer items-center gap-2">
          <span className="text-sm text-stone-600">
            {draft.enabled ? m.settings.extensions.on : m.settings.extensions.off}
          </span>
          <input
            id={toggleId}
            type="checkbox"
            role="switch"
            checked={draft.enabled}
            disabled={setup.error !== undefined}
            onChange={(event) => onChange({ enabled: event.target.checked })}
            className="peer sr-only"
          />
          <span
            aria-hidden
            className="relative h-6 w-11 rounded-full bg-stone-300 transition peer-checked:bg-emerald-600 peer-focus-visible:outline-2 peer-focus-visible:outline-sky-600 peer-disabled:opacity-50 after:absolute after:top-0.5 after:left-0.5 after:size-5 after:rounded-full after:bg-white after:shadow after:transition peer-checked:after:translate-x-5"
          />
        </label>
      </div>
      {setup.error !== undefined && (
        <p className="rounded bg-red-50 px-2 py-1 text-sm text-red-800">
          {m.settings.extensions.loadFailed(setup.error)}
        </p>
      )}
      {setup.failed !== undefined && (
        <p className="rounded bg-red-50 px-2 py-1 text-sm text-red-800">
          {m.settings.extensions.startFailed(setup.failed)}
        </p>
      )}
      {setup.missingEnv.length > 0 && (
        <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">
          {m.settings.extensions.needsEnv(setup.missingEnv.map((name) => `$${name}`).join(", "))}
        </p>
      )}
      {(hasFields || setup.error === undefined) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="self-start text-sm text-stone-600 underline"
        >
          {open
            ? m.settings.extensions.hideSettings
            : hasFields
              ? m.settings.extensions.settings
              : m.settings.extensions.rooms}
        </button>
      )}
      {open && (
        <div className="flex flex-col gap-4 border-t border-stone-200 pt-3">
          {hasFields && (
            <ObjectFields
              schema={schema}
              value={draft.settings}
              onChange={(settings) => onChange({ settings })}
            />
          )}
          <fieldset className="flex flex-col gap-1">
            <legend className="text-sm font-medium">{m.settings.extensions.onByDefault}</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {KINDS.map((kind) => {
                const rooms = draft.rooms ?? KINDS;
                return (
                  <label key={kind} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={rooms.includes(kind)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? KINDS.filter((item) => item === kind || rooms.includes(item))
                          : rooms.filter((item) => item !== kind);
                        onChange({ rooms: next.length === KINDS.length ? undefined : next });
                      }}
                    />
                    {m.settings.extensions.kinds[kind]}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-stone-500">{m.settings.extensions.roomsCanChange}</p>
          </fieldset>
        </div>
      )}
    </article>
  );
}
