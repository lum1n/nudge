import type { Profile } from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type FormEvent, useEffect, useState } from "react";
import { clientFor } from "../../api.ts";

export const Route = createFileRoute("/$assistant/profile")({ component: ProfilePage });

type Draft = {
  displayName: string;
  timeZone: string;
  language: string;
  avatar?: string;
  answers: boolean;
  approvals: boolean;
};

function draftOf(profile: Profile): Draft {
  return {
    displayName: profile.displayName,
    timeZone: profile.timeZone ?? "",
    language: profile.language ?? "",
    ...(profile.avatar === undefined ? {} : { avatar: profile.avatar }),
    answers: profile.notifications?.answers ?? true,
    approvals: profile.notifications?.approvals ?? true,
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
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    if (profile.data !== undefined) setDraft(draftOf(profile.data));
  }, [profile.data]);

  if (profile.error) return <Page>{profile.error.message}</Page>;
  if (draft === undefined) return <Page>Loading…</Page>;
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
    </Page>
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
