import type { Membership, PlayerSettingsSchema, Profile } from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { ApiError, clientFor } from "../../api.ts";
import { meQuery } from "../../queries.ts";
import { ObjectFields, type Schema, withoutDefaults } from "../../schema-form.tsx";

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
  if (draft === undefined) return <Page>Loading…</Page>;
  // A guest's profile comes from their home, which sends it again whenever it changes there.
  const home = me.data?.player.address;
  if (home !== undefined)
    return (
      <Page>
        <p className="rounded border border-stone-200 bg-white p-3 text-sm text-stone-600">
          You joined from your home assistant, as <span className="font-mono">{home}</span>. Your
          name, picture, time zone, language and settings come from there: change them in your
          home's app.
        </p>
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
      setError("That image could not be read.");
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
            Choose a picture
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
              Remove
            </button>
          )}
        </div>
        <label className={label}>
          Name
          <input
            value={draft.displayName}
            onChange={(event) => change({ displayName: event.target.value })}
            className={input}
          />
        </label>
        <label className={label}>
          Time zone
          <select
            value={draft.timeZone}
            onChange={(event) => change({ timeZone: event.target.value })}
            className={input}
          >
            <option value="">The assistant's</option>
            {TIME_ZONES.map((zone) => (
              <option key={zone} value={zone}>
                {zone}
              </option>
            ))}
          </select>
        </label>
        <label className={label}>
          Language
          <input
            value={draft.language}
            onChange={(event) => change({ language: event.target.value })}
            placeholder="Such as en, nb or de"
            className={input}
          />
        </label>
        <fieldset className="flex flex-col gap-1 text-sm">
          <legend className="mb-1">Notifications</legend>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.answers}
              onChange={(event) => change({ answers: event.target.checked })}
            />
            Answers and nudges
          </label>
          <label className="flex items-center gap-2">
            <input
              type="checkbox"
              checked={draft.approvals}
              onChange={(event) => change({ approvals: event.target.checked })}
            />
            Actions waiting for approval
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
            Save
          </button>
          {saved && <span className="text-sm text-stone-600">Saved.</span>}
          {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
        </div>
      </form>
      <Memberships assistant={assistant} />
    </Page>
  );
}

/**
 * Where the player joined from here, through the federation extension: whether their own memory
 * goes along, and leaving. Not shown on an assistant without the extension.
 */
function Memberships({ assistant }: { assistant: string }) {
  const queryClient = useQueryClient();
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

  const api = clientFor(assistant).api;
  return (
    <div className="flex flex-col gap-3 rounded border border-stone-200 bg-white p-3">
      <div>
        <h3 className="text-sm font-medium">Other assistants</h3>
        <p className="text-xs text-stone-500">
          Your address is <span className="font-mono">{address}</span>. An admin of another
          assistant can invite you by it, and you join from the Nudge app.
        </p>
      </div>
      {memberships.data.memberships.length === 0 ? (
        <p className="text-sm text-stone-600">You haven't joined any yet.</p>
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
                      at {new URL(membership.server).host}, since{" "}
                      {new Date(membership.since).toLocaleDateString()}
                    </span>
                  </span>
                  <button
                    type="button"
                    disabled={busy === id}
                    onClick={() => {
                      if (
                        confirm(
                          `Stop sending your profile and memory to ${membership.assistant}? You stay a member there.`,
                        )
                      )
                        void change(membership, () => api.leave(membership));
                    }}
                    className="text-stone-600 underline disabled:opacity-50"
                  >
                    Leave
                  </button>
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
                  Take my own memory there (not what I made private)
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
        <h2 className="text-lg font-medium">Profile</h2>
        <p className="text-sm text-stone-600">
          How the assistant knows you: it reads your nudges' times in your time zone and answers you
          in your language.
        </p>
      </div>
      {children}
    </section>
  );
}
