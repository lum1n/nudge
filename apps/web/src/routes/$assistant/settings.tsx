import type { ExtensionSetup, RoomKind } from "@nudge/client";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { type ReactNode, useEffect, useState } from "react";
import { ApiError, clientFor, useRoomList } from "../../api.ts";
import { type Appearance, lookOf } from "../../avatar/appearance.ts";
import { Avatar } from "../../avatar/Avatar.tsx";
import { LookPicker } from "../../avatar/LookPicker.tsx";
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

const KINDS: { kind: RoomKind; label: string }[] = [
  { kind: "lobby", label: "Everyone" },
  { kind: "personal", label: "Personal" },
  { kind: "shared", label: "Shared" },
];

function draftOf(setup: ExtensionSetup): Draft {
  return {
    from: setup.from,
    enabled: setup.enabled,
    settings: setup.settings,
    ...(setup.rooms === undefined ? {} : { rooms: setup.rooms }),
  };
}

/** What an admin sets up for everyone: how the robot looks, and the extensions. */
function Settings() {
  const { assistant } = Route.useParams();
  const me = useQuery(meQuery(assistant));
  if (me.data !== undefined && !me.data.admin)
    return <Page>Only an admin can change the assistant's settings.</Page>;
  return (
    <>
      <Robot />
      <Extensions />
    </>
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
        <h2 className="text-lg font-medium">Robot</h2>
        <p className="text-sm text-stone-600">
          How the assistant looks to everyone who uses it, in every app.
        </p>
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
              Save
            </button>
            {dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => setDraft(undefined)}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm"
              >
                Discard
              </button>
            )}
            {saved !== undefined && !dirty && (
              <button
                type="button"
                disabled={saving}
                onClick={() => void save(null)}
                className="rounded border border-stone-300 px-3 py-1.5 text-sm"
              >
                Back to the app icon's
              </button>
            )}
            {error !== undefined && <span className="text-sm text-red-700">{error}</span>}
          </div>
        </div>
      </div>
    </section>
  );
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
    return <Page>Only an admin can set up extensions.</Page>;
  if (setups.error)
    return (
      <Page>
        <span className="text-red-700">
          {setups.error instanceof ApiError && setups.error.status === 404
            ? "This server can't set up extensions from the web. Run it with nudge serve."
            : setups.error.message}
        </span>
      </Page>
    );
  if (setups.data === undefined || drafts === undefined) return <Page>Loading…</Page>;

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
          <h2 className="text-lg font-medium">Extensions</h2>
          <p className="text-sm text-stone-600">
            What the assistant can do beyond talking. Saving installs them again right away and
            writes them to the server's nudge.json; if one fails to start, nothing changes. Each
            room can still turn them on or off for itself.
          </p>
        </div>
        {configured.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">Added</h3>
            {configured.map(card)}
          </div>
        )}
        {available.length > 0 && (
          <div className="flex flex-col gap-3">
            <h3 className="text-sm font-medium tracking-wide text-stone-500 uppercase">
              Not added yet
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
                  "Unsaved changes"
                ) : (
                  <span className="text-emerald-700">Saved and installed.</span>
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
                    Discard
                  </button>
                  <button
                    type="button"
                    disabled={saving}
                    onClick={() => void save()}
                    className="rounded bg-stone-900 px-3 py-1.5 text-sm text-white disabled:opacity-50"
                  >
                    {saving ? "Saving…" : "Save"}
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
          <span className="text-sm text-stone-600">{draft.enabled ? "On" : "Off"}</span>
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
          Couldn't load it: {setup.error}
        </p>
      )}
      {setup.missingEnv.length > 0 && (
        <p className="rounded bg-amber-50 px-2 py-1 text-sm text-amber-900">
          Needs {setup.missingEnv.map((name) => `$${name}`).join(", ")} in the server's environment,
          or the value in its settings, before it can start.
        </p>
      )}
      {(hasFields || setup.error === undefined) && (
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
          className="self-start text-sm text-stone-600 underline"
        >
          {open ? "Hide settings" : hasFields ? "Settings" : "Rooms"}
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
            <legend className="text-sm font-medium">On by default in</legend>
            <div className="flex flex-wrap gap-x-4 gap-y-1">
              {KINDS.map(({ kind, label }) => {
                const rooms = draft.rooms ?? KINDS.map((item) => item.kind);
                return (
                  <label key={kind} className="flex items-center gap-2 text-sm">
                    <input
                      type="checkbox"
                      className="size-4"
                      checked={rooms.includes(kind)}
                      onChange={(event) => {
                        const next = event.target.checked
                          ? KINDS.map((item) => item.kind).filter(
                              (item) => item === kind || rooms.includes(item),
                            )
                          : rooms.filter((item) => item !== kind);
                        onChange({ rooms: next.length === KINDS.length ? undefined : next });
                      }}
                    />
                    {label}
                  </label>
                );
              })}
            </div>
            <p className="text-xs text-stone-500">
              People in a room can still turn it on or off there.
            </p>
          </fieldset>
        </div>
      )}
    </article>
  );
}
