import type {
  Membership,
  PersonalDetails,
  PlaceRequest,
  PlayerSettingsSchema,
  Profile,
} from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, clientFor, joinHere, remembered, tokenFor } from "../../api.ts";
import { dateLocale, m } from "../../i18n/index.ts";
import { isThisServer, joinPage, parseJoinLink } from "../../joining.ts";
import { meQuery } from "../../queries.ts";
import { ObjectFields, type Schema, withoutDefaults } from "../../schema-form.tsx";
import { dollars, monthLabel, shareOf } from "../../spend.ts";

export const Route = createFileRoute("/$assistant/profile")({ component: ProfilePage });

type Draft = {
  displayName: string;
  timeZone: string;
  language: string;
  avatar?: string;
  answers: boolean;
  approvals: boolean;
  /** What the player chose per extension, by name. */
  extensions: Record<string, Record<string, unknown>>;
};

function draftOf(profile: Profile): Draft {
  return {
    displayName: profile.displayName,
    timeZone: profile.timeZone ?? "",
    language: profile.language ?? "",
    ...(profile.avatar === undefined ? {} : { avatar: profile.avatar }),
    answers: profile.notifications?.answers ?? true,
    approvals: profile.notifications?.approvals ?? true,
    extensions: structuredClone(profile.extensions ?? {}),
  };
}

const TIME_ZONES = Intl.supportedValuesOf("timeZone");

/** Avatars are kept small: a 128 px square, as a data URL. */
async function shrink(file: File): Promise<string> {
  const bitmap = await createImageBitmap(file);
  const side = Math.min(bitmap.width, bitmap.height);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 128;
  canvas
    .getContext("2d")!
    .drawImage(
      bitmap,
      (bitmap.width - side) / 2,
      (bitmap.height - side) / 2,
      side,
      side,
      0,
      0,
      128,
      128,
    );
  return canvas.toDataURL("image/webp", 0.85);
}

function ProfilePage() {
  const { assistant } = Route.useParams();
  const queryClient = useQueryClient();
  const key = [assistant, "profile"];
  const profile = useQuery({ queryKey: key, queryFn: () => clientFor(assistant).api.profile() });
  const extensions = useQuery({
    queryKey: [assistant, "player-settings"],
    queryFn: () => clientFor(assistant).api.playerSettings(),
  });
  const me = useQuery(meQuery(assistant));
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile.data !== undefined) setDraft(draftOf(profile.data));
  }, [profile.data]);

  if (profile.error) return <Page>{profile.error.message}</Page>;
  if (draft === undefined) return <Page>{m.common.loading}</Page>;
  // A guest's profile comes from their home, which sends it again whenever it changes there.
  const home = me.data?.player.address;
  if (home !== undefined)
    return (
      <Page>
        <p className="rounded border border-stone-200 bg-white p-3 text-sm text-stone-600">
          {m.profile.page.guestBefore}
          <span className="font-mono">{home}</span>
          {m.profile.page.guestAfter}
        </p>
        <Spend assistant={assistant} />
      </Page>
    );
  const change = (part: Partial<Draft>) => {
    setSaved(false);
    setDraft({ ...draft, ...part });
  };

  async function save(event: FormEvent) {
    event.preventDefault();
    if (draft === undefined) return;
    setBusy(true);
    setError(undefined);
    try {
      const next = await clientFor(assistant).api.updateProfile({
        displayName: draft.displayName.trim(),
        timeZone: draft.timeZone === "" ? null : draft.timeZone,
        language: draft.language.trim() === "" ? null : draft.language.trim(),
        avatar: draft.avatar ?? null,
        notifications: { answers: draft.answers, approvals: draft.approvals },
        extensions: Object.fromEntries(
          (extensions.data ?? []).map(({ name, schema }) => {
            const chosen = withoutDefaults(draft.extensions[name] ?? {}, schema as Schema);
            return [name, Object.keys(chosen).length === 0 ? null : chosen];
          }),
        ),
      });
      queryClient.setQueryData(key, next);
      // The name shows in the header and in rooms.
      void queryClient.invalidateQueries({ queryKey: [assistant, "me"] });
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  async function pick(file: File | undefined) {
    if (file === undefined) return;
    setError(undefined);
    try {
      change({ avatar: await shrink(file) });
    } catch {
      setError(m.profile.page.unreadableImage);
    }
  }

  const label = "flex flex-col gap-1 text-sm";
  const input = "rounded border border-stone-300 px-2 py-1 text-sm";
  return (
    <Page>
      <form
        onSubmit={(event) => void save(event)}
        className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3"
      >
        <div className="flex items-center gap-3">
          {draft.avatar === undefined ? (
            <div className="size-16 rounded-full bg-stone-200" />
          ) : (
            <img src={draft.avatar} alt="" className="size-16 rounded-full object-cover" />
          )}
          <label className="cursor-pointer text-sm underline">
            {m.profile.page.choosePicture}
            <input
              type="file"
              accept="image/*"
              className="hidden"
              onChange={(event) => void pick(event.target.files?.[0])}
            />
          </label>
          {draft.avatar !== undefined && (
            <button
              type="button"
              onClick={() => change({ avatar: undefined })}
              className="text-sm text-stone-600 underline"
            >
              {m.common.remove}
            </button>
          )}
        </div>
        <label className={label}>
          {m.profile.page.name}
          <input
            value={draft.displayName}
            onChange={(event) => change({ displayName: event.target.value })}
            className={input}
          />
        </label>
        <label className={label}>
          {m.profile.page.timeZone}
          <select
            value={draft.timeZone}
            onChange={(event) => change({ timeZone: event.target.value })}
            className={input}
          >
            <option value="">{m.profile.page.assistantsTimeZone}</option>
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          {m.profile.page.language}
          <input
            value={draft.language}
            onChange={(event) => change({ language: event.target.value })}
            placeholder={m.profile.page.languageExample}
            className={input}
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1">{m.profile.page.notifications}</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.answers}
              onChange={(event) => change({ answers: event.target.checked })}
            />
            {m.profile.page.answers}
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.approvals}
              onChange={(event) => change({ approvals: event.target.checked })}
            />
            {m.profile.page.approvals}
          </label>
        </fieldset>
        {(extensions.data ?? []).map((extension) => (
          <ExtensionFields
            key={extension.name}
            extension={extension}
            value={draft.extensions[extension.name] ?? {}}
            onChange={(next) =>
              change({ extensions: { ...draft.extensions, [extension.name]: next } })
            }
          />
        ))}
        <div className="flex items-center gap-3">
          <button
            type="submit"
            disabled={busy || draft.displayName.trim() === ""}
            className="rounded border px-3 py-1 text-sm disabled:opacity-50"
          >
            {m.common.save}
          </button>
          {saved && <span className="text-sm text-stone-600">{m.profile.page.saved}</span>}
          {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </form>
      <Personal assistant={assistant} />
      <Spend assistant={assistant} />
      <Places assistant={assistant} />
      <Memberships assistant={assistant} />
    </Page>
  );
}

const PERSONAL_FIELDS = [
  { field: "fullName", type: "text", autoComplete: "name" },
  { field: "email", type: "email", autoComplete: "email" },
  { field: "phone", type: "tel", autoComplete: "tel" },
  { field: "address", type: "text", autoComplete: "street-address" },
] as const;

type PersonalField = (typeof PERSONAL_FIELDS)[number]["field"];

/**
 * The player's personal details, for forms, mail and what is near them. The model only ever sees
 * placeholders for them, in the player's own room and private messages.
 */
function Personal({ assistant }: { assistant: string }) {
  const queryClient = useQueryClient();
  const key = [assistant, "personal"];
  const details = useQuery({ queryKey: key, queryFn: () => clientFor(assistant).api.personal() });
  const [draft, setDraft] = useState<Record<PersonalField, string>>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (details.data !== undefined)
      setDraft({
        fullName: details.data.fullName ?? "",
        email: details.data.email ?? "",
        phone: details.data.phone ?? "",
        address: details.data.address ?? "",
      });
  }, [details.data]);

  if (details.error) return <p className="text-sm text-red-700">{details.error.message}</p>;
  if (draft === undefined) return null;

  async function update(work: () => Promise<PersonalDetails>) {
    setBusy(true);
    setError(undefined);
    setSaved(false);
    try {
      queryClient.setQueryData(key, await work());
      setSaved(true);
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const api = clientFor(assistant).api;
  const save = (event: FormEvent) => {
    event.preventDefault();
    void update(() => api.updatePersonal(draft));
  };
  const locate = () => {
    setError(undefined);
    if (!("geolocation" in navigator)) return setError(m.profile.personal.noGeolocation);
    navigator.geolocation.getCurrentPosition(
      ({ coords }) =>
        void update(() =>
          api.updatePersonal({
            location: { latitude: coords.latitude, longitude: coords.longitude },
          }),
        ),
      (failed) => setError(failed.message),
      { enableHighAccuracy: false, timeout: 15_000 },
    );
  };
  const location = details.data?.location;
  return (
    <form
      onSubmit={save}
      className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3"
    >
      <div>
        <h3 className="text-sm font-medium">{m.profile.personal.title}</h3>
        <p className="text-xs text-stone-500">{m.profile.personal.intro}</p>
      </div>
      {PERSONAL_FIELDS.map(({ field, type, autoComplete }) => (
        <label key={field} className="flex flex-col gap-1 text-sm">
          {m.profile.personal.fields[field]}
          <input
            type={type}
            autoComplete={autoComplete}
            value={draft[field]}
            onChange={(event) => {
              setSaved(false);
              setDraft({ ...draft, [field]: event.target.value });
            }}
            className="rounded border border-stone-300 px-2 py-1 text-sm"
          />
        </label>
      ))}
      <div className="flex flex-col gap-1 text-sm">
        {m.profile.personal.whereYouAre}
        <span className="text-stone-600">
          {location === undefined
            ? m.profile.personal.notShared
            : `${location.text}, ${new Date(location.at).toLocaleString(dateLocale())}`}
        </span>
        <span className="flex gap-3">
          <button
            type="button"
            disabled={busy}
            onClick={locate}
            className="underline disabled:opacity-50"
          >
            {m.profile.personal.shareNow}
          </button>
          {location !== undefined && (
            <button
              type="button"
              disabled={busy}
              onClick={() => void update(() => api.updatePersonal({ location: null }))}
              className="text-stone-600 underline disabled:opacity-50"
            >
              {m.profile.personal.forget}
            </button>
          )}
        </span>
      </div>
      <div className="flex items-center gap-3">
        <button
          type="submit"
          disabled={busy}
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {m.common.save}
        </button>
        {saved && <span className="text-sm text-stone-600">{m.profile.page.saved}</span>}
        {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
      </div>
    </form>
  );
}

/**
 * Where the player joined from here, through the federation extension: whether their own memory
 * goes along, and leaving. Not shown on an assistant without the extension.
 */
/**
 * The places the player saved and their reminders for getting somewhere (ADR 18), to forget or
 * cancel. The assistant adds them when asked in chat; nothing shows without the places extension.
 */
function Places({ assistant }: { assistant: string }) {
  const queryClient = useQueryClient();
  const key = [assistant, "places"];
  const api = clientFor(assistant).api;
  const places = useQuery({ queryKey: key, queryFn: () => api.places(), retry: false });
  const [error, setError] = useState<string>();
  if (places.data === undefined) return null;
  const { places: saved, reminders } = places.data;
  const act = async (work: () => Promise<void>) => {
    setError(undefined);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (caught) {
      setError((caught as Error).message);
    }
  };
  return (
    <section className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3">
      <div>
        <h3 className="text-sm font-medium">{m.profile.places.title}</h3>
        <p className="text-xs text-stone-500">{m.profile.places.intro}</p>
      </div>
      {saved.length === 0 && reminders.length === 0 && (
        <p className="text-sm text-stone-500">{m.profile.places.none}</p>
      )}
      {saved.length > 0 && (
        <ul className="flex flex-col gap-1">
          {saved.map((place) => (
            <li key={place.name} className="flex items-center justify-between gap-2 text-sm">
              <span>
                <span className="font-medium">{place.name}</span>{" "}
                <span className="text-stone-500">{place.address}</span>
              </span>
              <button
                type="button"
                onClick={() => void act(() => api.forgetPlace(place.name))}
                className="text-xs text-red-700 hover:underline"
              >
                {m.profile.places.forget}
              </button>
            </li>
          ))}
        </ul>
      )}
      {reminders.length > 0 && (
        <ul className="flex flex-col gap-1">
          {reminders.map((reminder) => (
            <li key={reminder.id} className="flex items-center justify-between gap-2 text-sm">
              <span>
                {reminder.on === "arrive" ? m.profile.places.arriving : m.profile.places.leaving}{" "}
                {reminder.place ?? m.profile.places.anyKind(reminder.kind)}
                {reminder.repeat === "always" ? m.profile.places.everyTime : ""}: {reminder.message}
              </span>
              <button
                type="button"
                onClick={() => void act(() => api.cancelArrivalReminder(reminder.id))}
                className="text-xs text-red-700 hover:underline"
              >
                {m.common.cancel}
              </button>
            </li>
          ))}
        </ul>
      )}
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </section>
  );
}

function Memberships({ assistant }: { assistant: string }) {
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const key = [assistant, "memberships"];
  const memberships = useQuery({
    queryKey: key,
    queryFn: () => clientFor(assistant).api.memberships(),
    retry: (count, error) => !(error instanceof ApiError && error.status === 404) && count < 3,
  });
  const [busy, setBusy] = useState<string>();
  const [error, setError] = useState<string>();

  if (memberships.error instanceof ApiError && memberships.error.status === 404) return null;
  if (memberships.error) return <p className="text-sm text-red-700">{memberships.error.message}</p>;
  if (memberships.data === undefined) return null;
  const { address } = memberships.data;

  async function change(membership: Membership, work: () => Promise<unknown>) {
    const id = `${membership.server}|${membership.assistant}`;
    setBusy(id);
    setError(undefined);
    try {
      await work();
      await queryClient.invalidateQueries({ queryKey: key });
    } catch (caught) {
      setError((caught as Error).message);
    } finally {
      setBusy(undefined);
    }
  }

  // Signed in there already, it opens; else home vouches for the player again, as joining does.
  async function open(membership: Membership) {
    if (isThisServer(membership.server, location.origin) && tokenFor(membership.assistant)) {
      await navigate({ to: "/$assistant", params: { assistant: membership.assistant } });
      return;
    }
    await change(membership, () => joinFrom(assistant, membership, navigate));
  }

  const api = clientFor(assistant).api;
  return (
    <div className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3">
      <div>
        <h3 className="text-sm font-medium">{m.profile.memberships.title}</h3>
        <p className="text-xs text-stone-500">
          {m.profile.memberships.addressBefore}
          <span className="font-mono">{address}</span>
          {m.profile.memberships.addressAfter}
        </p>
      </div>
      <JoinForm assistant={assistant} />
      {memberships.data.memberships.length === 0 ? (
        <p className="text-sm text-stone-600">{m.profile.memberships.none}</p>
      ) : (
        <ul className="flex flex-col gap-2">
          {memberships.data.memberships.map((membership) => {
            const id = `${membership.server}|${membership.assistant}`;
            return (
              <li key={id} className="flex flex-col gap-1 border-t border-stone-100 pt-2 text-sm">
                <div className="flex items-baseline justify-between gap-2">
                  <span>
                    <span className="font-medium">{membership.assistant}</span>{" "}
                    <span className="text-stone-500">
                      {m.profile.memberships.where(
                        new URL(membership.server).host,
                        new Date(membership.since).toLocaleDateString(dateLocale()),
                      )}
                    </span>
                  </span>
                  <span className="flex shrink-0 gap-3">
                    <button
                      type="button"
                      disabled={busy === id}
                      onClick={() => void open(membership)}
                      className="underline disabled:opacity-50"
                    >
                      {m.profile.memberships.open}
                    </button>
                    <button
                      type="button"
                      disabled={busy === id}
                      onClick={() => {
                        if (confirm(m.profile.memberships.confirmLeave(membership.assistant)))
                          void change(membership, () => api.leave(membership));
                      }}
                      className="text-stone-600 underline disabled:opacity-50"
                    >
                      {m.profile.memberships.leave}
                    </button>
                  </span>
                </div>
                <label className="flex items-center gap-2">
                  <input
                    type="checkbox"
                    checked={membership.carryMemory}
                    disabled={busy === id}
                    onChange={(event) =>
                      void change(membership, () =>
                        api.carryMemory(membership, event.target.checked),
                      )
                    }
                  />
                  {m.profile.memberships.carryMemory}
                </label>
              </li>
            );
          })}
        </ul>
      )}
      {error !== undefined && <p className="text-sm text-red-700">{error}</p>}
    </div>
  );
}

/**
 * Joins `place` with `home` vouching for the player. On this server it joins from here, keeping
 * the token where home's is, and opens it; elsewhere, only that server's page can join it, so the
 * browser goes there with the assertion.
 */
async function joinFrom(
  home: string,
  place: PlaceRequest,
  navigate: ReturnType<typeof useNavigate>,
): Promise<void> {
  const here = isThisServer(place.server, location.origin);
  if (here && place.assistant === home) throw new Error(m.profile.memberships.thisAssistant);
  const assertion = await clientFor(home).api.vouchFor(place);
  if (!here) {
    location.assign(joinPage(place, assertion));
    return;
  }
  await joinHere(place.assistant, assertion, remembered(home));
  await navigate({ to: "/$assistant", params: { assistant: place.assistant } });
}

/** A join link an admin elsewhere sent, pasted in: home vouches for the player there. */
function JoinForm({ assistant }: { assistant: string }) {
  const navigate = useNavigate();
  const [link, setLink] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();

  async function submit(event: FormEvent) {
    event.preventDefault();
    const place = parseJoinLink(link);
    if (place === undefined) {
      setError(m.profile.memberships.notJoinLink);
      return;
    }
    setBusy(true);
    setError(undefined);
    try {
      await joinFrom(assistant, place, navigate);
    } catch (caught) {
      setError(
        caught instanceof ApiError && caught.status === 403
          ? m.profile.memberships.notInvited(place.assistant)
          : (caught as Error).message,
      );
      setBusy(false);
    }
  }

  return (
    <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-1 text-sm">
      <span className="flex gap-2">
        <input
          value={link}
          onChange={(event) => {
            setError(undefined);
            setLink(event.target.value);
          }}
          placeholder="nudge://join?server=…"
          aria-label={m.profile.memberships.joinLink}
          autoComplete="off"
          className="min-w-0 flex-1 rounded border border-stone-300 px-2 py-1 font-mono text-xs"
        />
        <button
          type="submit"
          disabled={busy || link.trim() === ""}
          className="rounded border px-3 py-1 text-sm disabled:opacity-50"
        >
          {m.profile.memberships.join}
        </button>
      </span>
      {error !== undefined && <span className="text-red-700">{error}</span>}
    </form>
  );
}

/** This month's model spend: the player's, everyone's, and the limits on them. */
function Spend({ assistant }: { assistant: string }) {
  const usage = useQuery({
    queryKey: [assistant, "usage"],
    queryFn: () => clientFor(assistant).api.usage(),
  });
  if (usage.data === undefined) return null;
  const { mine, total, budget, month } = usage.data;
  const rows: [string, number, number | undefined][] = [
    [m.profile.spend.mine, mine, budget.perPlayerUsd],
    [m.profile.spend.everyone, total, budget.monthlyUsd],
  ];
  return (
    <section className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3">
      <div>
        <h3 className="text-sm font-medium">{monthLabel(month)}</h3>
        <p className="text-xs text-stone-500">{m.profile.spend.intro}</p>
      </div>
      <dl className="flex flex-col gap-2 text-sm">
        {rows.map(([label, spent, limit]) => {
          const share = shareOf(spent, limit);
          return (
            <div key={label} className="flex flex-col gap-1">
              <div className="flex justify-between gap-2">
                <dt>{label}</dt>
                <dd className="tabular-nums">
                  {dollars(spent)}
                  {limit !== undefined && (
                    <span className="text-stone-500">{m.profile.spend.of(dollars(limit))}</span>
                  )}
                </dd>
              </div>
              {share !== undefined && (
                <div
                  role="meter"
                  aria-label={m.profile.spend.ofLimit(label)}
                  aria-valuemin={0}
                  aria-valuemax={100}
                  aria-valuenow={Math.round(share * 100)}
                  className="h-1.5 overflow-hidden rounded bg-stone-100"
                >
                  <div
                    className={`h-full ${share >= 1 ? "bg-red-600" : share >= 0.8 ? "bg-amber-500" : "bg-stone-500"}`}
                    style={{ width: `${share * 100}%` }}
                  />
                </div>
              )}
            </div>
          );
        })}
      </dl>
    </section>
  );
}

/** One extension's settings for the player, in the form the settings page uses. */
function ExtensionFields({
  extension,
  value,
  onChange,
}: {
  extension: PlayerSettingsSchema;
  value: Record<string, unknown>;
  onChange: (next: Record<string, unknown>) => void;
}) {
  return (
    <fieldset className="flex flex-col gap-2 border-t border-stone-200 pt-3">
      <legend className="text-sm font-medium">{extension.name}</legend>
      {extension.description !== undefined && (
        <p className="text-xs text-stone-500">{extension.description}</p>
      )}
      <ObjectFields schema={extension.schema as Schema} value={value} onChange={onChange} />
    </fieldset>
  );
}

function Page({ children }: { children: React.ReactNode }) {
  return (
    <section className="mx-auto flex max-w-xl flex-col gap-4 p-3 sm:p-4">
      <div>
        <h2 className="text-lg font-medium">{m.profile.page.title}</h2>
        <p className="text-sm text-stone-600">{m.profile.page.intro}</p>
      </div>
      {children}
    </section>
  );
}
