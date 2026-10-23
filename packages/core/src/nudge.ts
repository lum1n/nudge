import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Context } from "@earendil-works/chord";
import type { TSchema } from "typebox";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { JsonValue, Message, Models } from "@earendil-works/pi-ai";
import {
  type AgentChange,
  type AgentEventStream,
  type Conversation,
  type ConversationId,
  type ConversationWatch,
  type EntryRecord,
  createRegistry,
  Harness,
  type HarnessSettings,
  MemoryStorage,
  type ModelRef,
  type Registry,
  type Storage,
  type Submission,
} from "@earendil-works/pi-durable";
import {
  APPROVAL_ENTRY,
  Approvals,
  ApprovalsDoc,
  type ApprovalsState,
} from "./approvals/approvals.ts";
import { type Change, Changes } from "./changes.ts";
import { createBuiltinExtension } from "./extensions/builtin.ts";
import {
  aboutExtension,
  type HostBase,
  type ExtensionInput,
  type RoomSocketHandler,
  checkPlayerSettings,
  type ExtensionRoute,
  matchRoute,
  type SetUpExtension,
  setUpExtension,
} from "./extensions/define.ts";
import { attach, MESSAGE_ENTRY, type MessageDraft, submitMessage } from "./host-api.ts";
import { DirectoryDoc, type Room } from "./identity/directory.ts";
import { Players } from "./identity/players.ts";
import { Looks } from "./identity/appearance.ts";
import { Personal } from "./identity/personal.ts";
import { Profiles } from "./identity/profiles.ts";
import { Rooms } from "./identity/rooms.ts";
import { Memory } from "./memory/memory.ts";
import { Nudges } from "./nudges/nudges.ts";
import { RedactingModels, type RedactionOptions } from "./models/redacting-models.ts";
import {
  builtinDetectors,
  type PiiDetector,
  quasiIdentifierDetectors,
} from "./privacy/detectors.ts";
import type { DeepDetector } from "./privacy/deep/detector.ts";
import {
  DeepScanner,
  DeepSeenDoc,
  type DeepMode,
  MAX_SEEN,
  textsToScan,
} from "./privacy/deep/scanner.ts";
import { mapStrings, redactContext } from "./privacy/redact.ts";
import { type ToolValues, withToolValues } from "./privacy/tool-values.ts";
import { type Owner, turnOf } from "./privacy/turn.ts";
import { PLACEHOLDER, Vault, type VaultEntry } from "./privacy/vault.ts";
import { READABLE_VERSION, VaultDoc } from "./privacy/vault-doc.ts";
import { openDatabaseStorage } from "./encrypted-storage.ts";
import { lockDatabase } from "./storage-lock.ts";
import { type RoomEvent, RoomEvents } from "./room-events.ts";
import { Presence } from "./presence.ts";
import { type Budget, BudgetReached, Spending, type SpendWarning, usd } from "./spending.ts";
import { FIRE_ENTRY, type FireEntryData } from "./nudges/timer-task.ts";

export type PrivacyOptions = {
  /** Detectors to run instead of the built-in ones. Names are protected separately. */
  readonly detectors?: readonly PiiDetector[];
  readonly onRequest?: RedactionOptions["onRequest"];
  /**
   * The local model that reads requests first (ADR 14), shared by a host's assistants. Without
   * one, as in tests and on Durable Objects, only the rules run.
   */
  readonly deep?: DeepDetector;
  /**
   * Default "off": names, places and organisations are readable (ADR 15). "required" refuses
   * requests while `deep` can't run.
   */
  readonly deepMode?: DeepMode;
  /** Words the local model never hides, such as a shop's name it keeps taking for a person. */
  readonly allow?: readonly string[];
};

export type NudgeOptions = {
  /** Where the assistant lives: a SQLite file path, or `":memory:"` for nothing persisted. */
  readonly database: string;
  /**
   * Storage the host opened and keeps, such as a Durable Object's, used instead of `database`.
   * Nothing is locked or written beside it: the host makes sure only one assistant has it open.
   */
  readonly storage?: Storage;
  /**
   * Whether a database made now is encrypted, under a key of its own in `<database>.key`, when no
   * key is set. A server's are (ADR 11); an existing unencrypted one stays so.
   */
  readonly encryptNew?: boolean;
  /** Model catalog and credentials every request goes through. */
  readonly models: Models;
  /** Model the assistant runs with. */
  readonly model: ModelRef;
  /** The assistant's name in URLs (`/v1/a/<name>`), as the config has it. Default "nudge". */
  readonly name?: string;
  /** What the assistant calls itself. Default "Nudge". */
  readonly displayName?: string;
  /** IANA time zone. Default: the host's. */
  readonly timeZone?: string;
  /** Extra instructions, rendered last in the system prompt. */
  readonly instructions?: string;
  /** Extensions installed after the built-in one, in order. */
  readonly extensions?: readonly ExtensionInput[];
  readonly settings?: HarnessSettings;
  readonly privacy?: PrivacyOptions;
  /** Monthly limits on model spend; none without. */
  readonly budget?: Budget;
  /** Clock for timestamps and timers; tests inject a fake one. */
  readonly now?: () => number;
  readonly onReport?: (error: unknown) => void;
};

/** An installed extension, as `Nudge.extensions` lists it. */
export type InstalledExtension = { readonly name: string; readonly version?: string };

/** An installed extension that takes settings from each player. */
export type PlayerSettingsSchema = InstalledExtension & {
  readonly description?: string;
  /** TypeBox schema of the settings, as `NudgeExtension.playerSettings` declares it. */
  readonly schema: TSchema;
};

/** An installed extension as one room has it. */
export type RoomExtension = InstalledExtension & {
  readonly description?: string;
  /** Whether the room's conversation uses it. */
  readonly enabled: boolean;
  /** Whether it is on in rooms of this kind by default; `enabled` differs when the room chose. */
  readonly byDefault: boolean;
  /** Why its setup failed when the assistant opened; it is off everywhere until it starts. */
  readonly error?: string;
};

/** An extension whose setup threw when the assistant opened, left out so the rest could start. */
export type BrokenExtension = InstalledExtension & {
  readonly description?: string;
  readonly error: string;
};

export class ExtensionNotFound extends Error {
  override name = "ExtensionNotFound";
  constructor(readonly extension: string) {
    super(`No extension "${extension}"`);
  }
}

/** The extension failed to start, so it can't be turned on anywhere. */
export class ExtensionBroken extends Error {
  override name = "ExtensionBroken";
  constructor(
    readonly extension: string,
    readonly reason: string,
  ) {
    super(`Extension "${extension}" failed to start: ${reason}`);
  }
}

type Parts = {
  readonly harness: Harness;
  readonly displayName: string;
  readonly models: RedactingModels;
  readonly agent: AgentChange;
  readonly now: () => number;
  readonly unlock: () => Promise<void>;
  readonly registry: Registry;
  readonly host: HostBase;
  readonly detectors: readonly PiiDetector[];
  readonly installed: readonly SetUpExtension[];
  readonly broken: readonly BrokenExtension[];
  readonly scanner: DeepScanner | undefined;
  readonly report: (error: unknown) => void;
  readonly events: RoomEvents;
  readonly spending: Spending;
  readonly timeZone: string;
};

/** One assistant: one storage, one Harness, one registry. */
export class Nudge {
  readonly harness: Harness;
  /** What the assistant calls itself. */
  readonly displayName: string;
  readonly players: Players;
  /** What each player says about themselves: time zone, language, preferences. */
  readonly profiles: Profiles;
  /** Each player's full name, e-mail, phone, address and location, kept as their private values. */
  readonly personal: Personal;
  /** How its robot looks in the apps. */
  readonly appearance: Looks;
  readonly rooms: Rooms;
  readonly nudges: Nudges;
  readonly memory: Memory;
  readonly approvals: Approvals;
  /** Changes to rooms, memory, nudges and approvals made through the members above. */
  readonly changes = new Changes();
  /** Finished answers and new approvals in every room, for hosts that pass them on. */
  readonly events: RoomEvents;
  /** Model spend by month, room and player, and the budget it is held to. */
  readonly spending: Spending;
  /** Which players have which rooms open on the host's sockets. */
  readonly presence = new Presence();
  private readonly timeZone: string;
  private readonly models: RedactingModels;
  private readonly now: () => number;
  private readonly unlock: () => Promise<void>;
  private readonly registry: Registry;
  private readonly host: Parts["host"];
  /** The assistant's own detectors, without its extensions'. */
  private readonly detectors: readonly PiiDetector[];
  private installed: readonly SetUpExtension[];
  /** Left out at open because their setup threw; a reload that sets them all up clears it. */
  private broken: readonly BrokenExtension[];
  private readonly scanner: DeepScanner | undefined;
  private readonly report: (error: unknown) => void;

  /** Tools whose results the local model leaves to the rules; see `ExtensionParts.publicTools`. */
  private publicTools(): ReadonlySet<string> {
    return publicToolsOf(this.installed);
  }

  /** What reloaded extensions' tools run with; see `withToolValues`. */
  private get toolValues(): ToolValues {
    return {
      turn: (id, context) => turnOf(this.harness, id, context),
      redact: (text) => this.redact(text),
      rehydrate: (viewer, text) => this.models.vault.rehydrateFor(viewer, text),
      models: () => this.models.withValues(),
    };
  }
  private reloading: Promise<unknown> = Promise.resolve();

  private constructor(parts: Parts) {
    const { harness, agent, now } = parts;
    this.harness = harness;
    this.displayName = parts.displayName;
    this.models = parts.models;
    this.now = now;
    this.unlock = parts.unlock;
    this.registry = parts.registry;
    this.host = parts.host;
    this.detectors = parts.detectors;
    this.installed = parts.installed;
    this.broken = parts.broken;
    this.scanner = parts.scanner;
    this.report = parts.report;
    const scanner = this.scanner;
    if (scanner !== undefined)
      this.models.scan = (input) =>
        scanner.protectIn(
          "messages" in input ? textsToScan(input, this.publicTools()) : input,
          this.models.vault,
        );
    this.events = parts.events;
    this.spending = parts.spending;
    this.timeZone = parts.timeZone;
    this.events.subscribe((event) => this.deliver(event));
    this.players = new Players(harness, now);
    const changed = (change: Change) => this.changes.emit(change);
    this.profiles = new Profiles(
      harness,
      this.players,
      (playerId) => changed({ kind: "profile", playerId }),
      (name, chosen) => checkPlayerSettings(this.installed, name, chosen),
    );
    this.personal = new Personal(
      harness,
      this.players,
      {
        protect: (value, kind, owner) => this.protect(value, kind, { owner }),
        readable: async (value, kind) => {
          const vault = this.models.vault;
          const placeholder = vault.protect(value, kind);
          vault.release(placeholder);
          await this.models.flush();
          return placeholder;
        },
        forget: async (placeholder) => {
          await this.forgetValue(placeholder);
        },
        entry: (placeholder) => this.models.vault.get(placeholder),
      },
      now,
      (playerId) => changed({ kind: "location", playerId }),
    );
    this.appearance = new Looks(harness);
    this.rooms = new Rooms(
      harness,
      (room) => ({ ...agent, extensions: this.selection(room) }),
      now,
      changed,
    );
    this.nudges = new Nudges(harness, this.rooms, now, changed);
    this.memory = new Memory(harness, this.rooms, now, changed, (text) => this.redact(text));
    // Looked up when an approval runs, so a reload's handlers take over.
    this.approvals = new Approvals(
      harness,
      this.rooms,
      now,
      // Actions act on values, so their models put them back (ADR 9).
      parts.models.withValues(),
      (extension, kind) =>
        this.installed.find((installed) => installed.extension.name === extension)?.approvals[kind],
      changed,
      (viewer, text) => this.models.vault.rehydrateFor(viewer, text),
      (text) => this.redact(text),
      (playerId, context) => this.players.isAdmin(playerId, context),
      (extension, kind) =>
        this.installed.find((installed) => installed.extension.name === extension)?.denials?.[kind],
      parts.report,
    );
  }

  static async open(options: NudgeOptions, context: Context): Promise<Nudge> {
    const now = options.now ?? Date.now;
    const displayName = options.displayName ?? "Nudge";
    const timeZone = options.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
    const registry = createRegistry();
    // The file the assistant keeps, when it keeps one.
    const file =
      options.storage === undefined && options.database !== ":memory:"
        ? options.database
        : undefined;
    let opened: Nudge | undefined;
    let resolveOpen: (nudge: Nudge) => void = () => {};
    const open = new Promise<Nudge>((resolve) => (resolveOpen = resolve));
    const whenOpen = () => {
      if (opened === undefined) throw new Error("The assistant is not open yet");
      return opened;
    };
    // Tools learn whether they answer something private through `currentTurn()`.
    const turn = (id: ConversationId, context: Context) => turnOf(whenOpen().harness, id, context);
    const values: ToolValues = {
      turn,
      redact: (text) => whenOpen().redact(text),
      rehydrate: (viewer, text) => whenOpen().models.vault.rehydrateFor(viewer, text),
      models: () => whenOpen().models.withValues(),
    };
    registry.install(
      withToolValues(
        createBuiltinExtension({
          displayName,
          timeZone,
          now,
          nudges: () => whenOpen().nudges,
          changed: (change) => whenOpen().changes.emit(change),
          turn,
          describe: (name) =>
            whenOpen().installed.find(({ extension }) => extension.name === name)?.description,
          known: (placeholder) => {
            const entry = whenOpen().models.vault.get(placeholder);
            return entry !== undefined && !entry.forgotten;
          },
        }),
        values,
      ),
    );
    const host: Parts["host"] = {
      name: options.name ?? "nudge",
      displayName,
      timeZone,
      now,
      protect: (value, kind) => whenOpen().protect(value, kind),
      release: (value) => whenOpen().release(value),
      documents: () => whenOpen().harness,
      assistant: whenOpen,
      whenOpen: () => open,
      ...(file === undefined ? {} : { dataRoot: `${file}.extensions` }),
    };
    if (file !== undefined) await mkdir(dirname(file), { recursive: true });
    // Locked first, so an assistant open elsewhere starts none of its extensions here.
    const unlock = file === undefined ? async () => {} : await lockDatabase(file);
    // Extensions are in the registry before the Harness opens, so their tasks resume with it.
    // One extension that fails to start, such as one missing its token, doesn't keep the
    // assistant closed: it is left out, and listed with its error.
    let installed: SetUpExtension[];
    const broken: BrokenExtension[] = [];
    try {
      installed = await setUpAll(options.extensions ?? [], host, (extension, error) => {
        broken.push(extension);
        options.onReport?.(
          new Error(`Extension "${extension.name}" failed to start, left out: ${extension.error}`, {
            cause: error,
          }),
        );
      });
    } catch (error) {
      await unlock();
      throw error;
    }
    for (const { extension } of installed) registry.install(withToolValues(extension, values));
    const deepMode = options.privacy?.deepMode ?? "off";
    const deep = deepMode === "off" ? undefined : options.privacy?.deep;
    // Turning the local model on asks for what ADR 14 hid, the rules for it included.
    const detectors =
      options.privacy?.detectors ??
      (deep === undefined ? builtinDetectors : quasiIdentifierDetectors);
    const models = new RedactingModels(options.models, {
      detectors: withExtensionDetectors(detectors, installed),
      onRequest: options.privacy?.onRequest,
    });
    let harness: Harness;
    try {
      harness = await Harness.open(
        options.storage ?? (await openStorage(options.database, options.encryptNew)),
        {
          models,
          registry,
          settings: options.settings,
          now: options.now,
          onReport: options.onReport,
        },
        context,
      );
    } catch (error) {
      await closeAll(installed, () => {});
      await unlock();
      throw error;
    }
    try {
      const saved = await harness.snapshot(VaultDoc, context);
      models.bind(new Vault(saved?.entries ?? []), (entries) =>
        harness.commit(async (tx) => {
          const doc = await tx.doc(VaultDoc);
          const at = new Map(doc.entries.map((entry, index) => [entry.placeholder, index]));
          for (const entry of entries) {
            const index = at.get(entry.placeholder);
            if (index === undefined) {
              at.set(entry.placeholder, doc.entries.length);
              doc.entries.push({ ...entry });
            } else doc.entries[index] = { ...entry };
          }
        }, BACKGROUND_CONTEXT),
      );
      const agent: AgentChange = {
        model: options.model,
        instructions: options.instructions ?? null,
      };
      const lobby = await harness.root(context, { agent });
      const events = await openRoomEvents(harness, context, options.onReport ?? (() => {}));
      const spending = await Spending.open(
        harness,
        {
          budget: options.budget ?? {},
          timeZone,
          now,
          warn: (warning) => void whenOpen().warnOfSpend(warning),
          report: options.onReport ?? (() => {}),
        },
        await harness.snapshot(DirectoryDoc, context),
        context,
      );
      models.refuse = () => spending.refusal();
      const report = options.onReport ?? (() => {});
      const scanner =
        deep === undefined || deepMode === "off"
          ? undefined
          : new DeepScanner({
              detector: deep,
              mode: deepMode,
              allow: [displayName, ...(options.privacy?.allow ?? [])],
              seen: await harness.snapshot(DeepSeenDoc, context),
              save: (model, keys) =>
                harness.commit(async (tx) => {
                  const doc = await tx.doc(DeepSeenDoc);
                  if (doc.model !== model) {
                    doc.model = model;
                    doc.keys.splice(0);
                  }
                  doc.keys.push(...keys);
                  if (doc.keys.length > MAX_SEEN) doc.keys.splice(0, doc.keys.length - MAX_SEEN);
                }, BACKGROUND_CONTEXT),
              report,
            });
      // Left for later while the local model runs, so turning it off releases them then.
      if (scanner === undefined && (saved?.readable ?? 0) < READABLE_VERSION) {
        await releaseReadable(models);
        await harness.commit(async (tx) => {
          (await tx.doc(VaultDoc)).readable = READABLE_VERSION;
        }, BACKGROUND_CONTEXT);
      }
      const nudge = new Nudge({
        harness,
        displayName,
        models,
        agent,
        now,
        unlock,
        registry,
        host,
        detectors,
        installed,
        broken,
        scanner,
        report,
        events,
        spending,
        timeZone,
      });
      await nudge.rooms.adoptLobby(lobby.id, context);
      const directory = await harness.snapshot(DirectoryDoc, context);
      const conversationIds = [
        ...Object.values(directory?.rooms ?? {}).map((room) => room.conversationId),
        ...Object.keys(directory?.sides ?? {}).map(Number),
      ];
      for (const id of conversationIds) {
        const conversation = await harness.conversation(id as ConversationId, context);
        if (conversation !== undefined) await followConfig(conversation, options, context);
      }
      await nudge.selectExtensions(context);
      await nudge.nudges.reconcile(context);
      opened = nudge;
      resolveOpen(nudge);
      // Pending nudge timers rearm here; those whose time passed while the host was down fire now.
      harness.resume();
      await nudge.approvals.recover(context);
      return nudge;
    } catch (error) {
      await harness.close(context);
      await closeAll(installed, () => {});
      await unlock();
      throw error;
    }
  }

  /** The extensions installed after the built-in one, in order. */
  extensions(): InstalledExtension[] {
    return this.installed.map(({ extension, version }) => ({
      name: extension.name,
      ...(version === undefined ? {} : { version }),
    }));
  }

  /** The extensions whose setup threw when the assistant opened, in order. */
  brokenExtensions(): BrokenExtension[] {
    return [...this.broken];
  }

  /** The installed extensions that take settings from each player, with their schemas. */
  playerSettings(): PlayerSettingsSchema[] {
    return this.installed.flatMap(({ extension, version, description, playerSettings }) =>
      playerSettings === undefined
        ? []
        : [
            {
              name: extension.name,
              ...(version === undefined ? {} : { version }),
              ...(description === undefined ? {} : { description }),
              schema: playerSettings,
            },
          ],
    );
  }

  /**
   * Installs `extensions` in place of the current ones: same names are replaced, new ones added,
   * missing ones removed. Every extension is set up first, so one that fails changes nothing.
   * Conversations pick the change up at their next turn.
   */
  reloadExtensions(extensions: readonly ExtensionInput[]): Promise<InstalledExtension[]> {
    const reload = this.reloading.then(async () => {
      const next = await setUpAll(extensions, this.host);
      const names = new Set(next.map(({ extension }) => extension.name));
      for (const { extension } of this.installed)
        if (!names.has(extension.name)) this.registry.uninstall(extension);
      for (const { extension } of next)
        this.registry.install(withToolValues(extension, this.toolValues));
      this.models.detectors = withExtensionDetectors(this.detectors, next);
      const replaced = this.installed;
      this.installed = next;
      this.broken = [];
      await closeAll(replaced, this.report);
      await this.selectExtensions(BACKGROUND_CONTEXT);
      return this.extensions();
    });
    this.reloading = reload.catch(() => {});
    return reload;
  }

  /**
   * The installed extensions, each on or off in the room, in install order, then those that failed
   * to start, off with their error.
   */
  async roomExtensions(roomId: string, context: Context): Promise<RoomExtension[]> {
    const room = await this.room(roomId, context);
    return [
      ...this.installed.map((installed) => ({
        name: installed.extension.name,
        ...(installed.version === undefined ? {} : { version: installed.version }),
        ...(installed.description === undefined ? {} : { description: installed.description }),
        enabled: enabledIn(room, installed),
        byDefault: onByDefault(room, installed),
      })),
      ...this.broken.map((broken) => ({ ...broken, enabled: false, byDefault: false })),
    ];
  }

  /**
   * Turns an installed extension on or off in a room, or with `undefined` back to the config's
   * default for the room's kind. The built-in extension is always on. The next turn uses it.
   */
  async setRoomExtension(
    roomId: string,
    name: string,
    enabled: boolean | undefined,
    context: Context,
  ): Promise<RoomExtension> {
    await this.room(roomId, context);
    if (!this.installed.some(({ extension }) => extension.name === name)) {
      const broken = this.broken.find((extension) => extension.name === name);
      throw broken === undefined
        ? new ExtensionNotFound(name)
        : new ExtensionBroken(name, broken.error);
    }
    const room = await this.harness.commit(async (tx) => {
      const room = (await tx.doc(DirectoryDoc)).rooms[roomId];
      if (room === undefined) throw new RoomNotFound(roomId);
      const choices = { ...room.extensions };
      if (enabled === undefined) delete choices[name];
      else choices[name] = enabled;
      if (Object.keys(choices).length === 0) delete room.extensions;
      else room.extensions = choices;
      return {
        ...room,
        members: [...room.members],
        ...(room.extensions === undefined ? {} : { extensions: { ...room.extensions } }),
      };
    }, context);
    await this.selectIn(room, context);
    return (await this.roomExtensions(roomId, context)).find(
      (extension) => extension.name === name,
    )!;
  }

  /**
   * Renames a room, keeping its id. A personal room's owner and a shared room's members may, and an
   * admin any room, the lobby only them; without `by`, the host renames it.
   */
  async renameRoom(
    roomId: string,
    name: string,
    context: Context,
    by?: { readonly playerId: string },
  ): Promise<Room> {
    const room = await this.room(roomId, context);
    if (by !== undefined && !(await this.players.isAdmin(by.playerId, context))) {
      if (room.kind === "lobby") throw new NotAllowed("Only an admin may rename the lobby");
      if (!room.members.includes(by.playerId))
        throw new NotAllowed(`Only the room's members may rename "${roomId}"`);
    }
    return this.rooms.rename(roomId, name, context);
  }

  /** Whether the room's conversation uses `name`; the built-in extension always. */
  async extensionEnabled(roomId: string, name: string, context: Context): Promise<boolean> {
    const room = await this.rooms.get(roomId, context);
    const installed = this.installed.find(({ extension }) => extension.name === name);
    return room !== undefined && installed !== undefined && enabledIn(room, installed);
  }

  /** The extensions a room's conversation leaves out, as a change to the host's selection. */
  private selection(room: Pick<Room, "kind" | "extensions">): AgentChange["extensions"] {
    const off = this.installed.filter((installed) => !enabledIn(room, installed));
    return off.length === 0 ? null : { remove: off.map(({ extension }) => extension) };
  }

  /** Brings every room's conversation in line with the installed extensions and its choices. */
  private async selectExtensions(context: Context): Promise<void> {
    for (const room of await this.rooms.list(context)) await this.selectIn(room, context);
  }

  private async selectIn(room: Room, context: Context): Promise<void> {
    for (const id of [room.conversationId, ...(await this.rooms.sides(room.id, context))])
      await this.selectInConversation(room, id, context);
  }

  private async selectInConversation(
    room: Room,
    conversationId: number,
    context: Context,
  ): Promise<void> {
    const conversation = await this.harness.conversation(conversationId as ConversationId, context);
    if (conversation === undefined) return;
    const off = new Set(
      this.installed
        .filter((installed) => !enabledIn(room, installed))
        .map(({ extension }) => extension.name),
    );
    const selected = (await conversation.agent(context)).extensions.map(({ name }) => name);
    const wanted = this.registry
      .snapshot()
      .installed()
      .map(({ name }) => name)
      .filter((name) => !off.has(name));
    if (selected.join("\n") === wanted.join("\n")) return;
    await conversation.configure({ extensions: this.selection(room) }, context);
  }

  /**
   * Tells a player, in their own room, that their budget is nearly spent, or every admin that the
   * assistant's is. It arrives like a fired nudge.
   */
  private async warnOfSpend(warning: SpendWarning): Promise<void> {
    try {
      const players =
        warning.kind === "player"
          ? [warning.playerId!]
          : (await this.players.list(BACKGROUND_CONTEXT)).map((player) => player.id);
      const month = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.timeZone,
        year: "numeric",
        month: "2-digit",
      }).format(this.now());
      const whose = warning.kind === "player" ? "your" : "the assistant's";
      const message = `Spent ${usd(warning.spent)} of ${whose} ${usd(warning.limit)} budget this month`;
      for (const playerId of players) {
        if (
          warning.kind === "assistant" &&
          !(await this.players.isAdmin(playerId, BACKGROUND_CONTEXT))
        )
          continue;
        const room = await this.rooms.ensurePersonal(playerId, BACKGROUND_CONTEXT);
        const conversation = await this.conversation(room.id, BACKGROUND_CONTEXT);
        await conversation.submit(
          {
            type: "input",
            content:
              `${message}. Past the limit, ${warning.kind === "player" ? "their messages are refused" : "nothing more is answered"} ` +
              `until the month ends. Tell them briefly, in your own words.`,
            whenBusy: "followUp",
            requestId: `budget:${month}:${warning.kind}:${warning.playerId ?? ""}`,
            entry: {
              kind: FIRE_ENTRY,
              data: { nudgeId: "budget", message, fireAt: this.now() } satisfies FireEntryData,
            },
          },
          BACKGROUND_CONTEXT,
        );
      }
    } catch (error) {
      this.report(error);
    }
  }

  /** Hands a room event to the extensions on in its room. */
  private deliver(event: RoomEvent): void {
    void (async () => {
      const room = await this.rooms.get(event.roomId, BACKGROUND_CONTEXT);
      if (room === undefined) return;
      for (const installed of this.installed) {
        if (installed.onRoomEvent === undefined || !enabledIn(room, installed)) continue;
        try {
          await installed.onRoomEvent(event);
        } catch (error) {
          this.report(error);
        }
      }
    })().catch(this.report);
  }

  /** The room socket an installed extension serves, if any. */
  roomSocket(extension: string): RoomSocketHandler | undefined {
    return this.installed.find((installed) => installed.extension.name === extension)?.roomSocket;
  }

  /**
   * The route of an installed extension that serves `method` at `path` below its prefix, and the
   * path's params; undefined when there is none.
   */
  extensionRoute(
    extension: string,
    method: string,
    path: string,
  ): { route: ExtensionRoute; params: Record<string, string> } | undefined {
    const installed = this.installed.find((found) => found.extension.name === extension);
    return installed === undefined ? undefined : matchRoute(installed.routes, method, path);
  }

  /** The room's conversation, for what the room API does not cover. */
  async conversation(roomId: string, context: Context): Promise<Conversation> {
    const room = await this.room(roomId, context);
    const conversation = await this.harness.conversation(
      room.conversationId as ConversationId,
      context,
    );
    if (conversation === undefined) throw new Error(`Room "${roomId}" has no conversation`);
    return conversation;
  }

  /** Posts a message to a room. Checking that the author may use the room is the host's job. */
  async submit(roomId: string, draft: MessageDraft, context: Context): Promise<Submission> {
    const room = await this.room(roomId, context);
    const refusal =
      draft.author === undefined
        ? this.spending.refusal()
        : this.spending.refusalFor(draft.author.playerId);
    if (refusal !== undefined) throw new BudgetReached(refusal);
    // Stored with placeholders, so forgetting a value takes it out of history (ADR 9). What a
    // private message reveals for the first time is its author's alone.
    const vault = this.models.vault;
    const before = vault.version;
    const owner = draft.private === true ? draft.author?.playerId : undefined;
    // What the local model finds now is the author's when private. Without it the message is
    // still stored; the request it leads to waits for the model, or is refused.
    await this.scanner?.protectIn([draft.text], vault, {
      ...(owner === undefined ? {} : { owner }),
      quiet: true,
    });
    const text = vault.redact(draft.text, this.models.detectors, owner);
    await this.models.flush();
    if (owner !== undefined && vault.version !== before) this.changes.emit({ kind: "vault" });
    return submitMessage(
      this.harness,
      room.conversationId as ConversationId,
      { ...draft, text },
      this.now(),
      this.timeZone,
      context,
    );
  }

  /** Stops the answer in progress in a room, and drops its queued messages. */
  async abort(roomId: string, context: Context): Promise<void> {
    await (await this.conversation(roomId, context)).abort(context);
  }

  /**
   * Keeps a value from the model, such as an address or a relative's name: from now on it only
   * ever sees the returned placeholder. `kind` is upper-case letters. With `owner`, the value is
   * also hidden from everyone but that player, wherever it shows (see `showTo`).
   */
  async protect(
    value: string,
    kind = "PRIVATE",
    options: { readonly owner?: string } = {},
  ): Promise<string> {
    const vault = this.models.vault;
    const before = vault.version;
    const placeholder = vault.protect(value, kind, options.owner);
    await this.models.flush();
    if (options.owner !== undefined && vault.version !== before)
      this.changes.emit({ kind: "vault" });
    return placeholder;
  }

  /**
   * Makes a hidden value readable again, as names are (ADR 15): text no longer has it replaced,
   * and where its placeholder is stored, the model reads the value. A value someone owns stays
   * hidden. False when there was nothing to release.
   */
  async release(value: string): Promise<boolean> {
    const vault = this.models.vault;
    const placeholder = vault.placeholderOf(value.trim());
    if (placeholder === undefined || !vault.release(placeholder)) return false;
    await this.models.flush();
    this.changes.emit({ kind: "vault" });
    return true;
  }

  /**
   * Drops a value from the vault for good: from now on everyone, the model and tools see only its
   * placeholder. Only its owner may forget a private value; anyone else needs `admin`. False when
   * there is no such value.
   */
  async forgetValue(
    placeholder: string,
    by: { readonly playerId?: string; readonly admin?: boolean } = { admin: true },
  ): Promise<boolean> {
    const vault = this.models.vault;
    const entry = vault.get(placeholder);
    if (entry === undefined || entry.forgotten) return false;
    if (!by.admin && (entry.owner === undefined || entry.owner !== by.playerId))
      throw new NotAllowed(`Only its owner or an admin may forget ${placeholder}`);
    vault.forget(placeholder);
    await this.models.flush();
    this.changes.emit({ kind: "vault" });
    return true;
  }

  /**
   * What the vault holds for each placeholder in `text`, once each, forgotten and private values
   * included; placeholders it doesn't know are left out.
   */
  valuesIn(text: string): VaultEntry[] {
    const vault = this.models.vault;
    const seen = new Set<string>();
    const entries: VaultEntry[] = [];
    for (const [placeholder] of text.matchAll(PLACEHOLDER)) {
      if (seen.has(placeholder)) continue;
      seen.add(placeholder);
      const entry = vault.get(placeholder);
      if (entry !== undefined) entries.push({ ...entry });
    }
    return entries;
  }

  /** The values only `playerId` may see, in the order they were made private. */
  privateValues(playerId: string): PrivateValue[] {
    return this.models.vault.entries.flatMap((entry) =>
      entry.owner === playerId && !entry.forgotten
        ? [{ placeholder: entry.placeholder, kind: entry.kind, value: entry.value }]
        : [],
    );
  }

  /**
   * Text as a player may see it: values others made private become placeholders, and placeholders
   * of values they may see are put back. Hosts run everything they show a person through this.
   */
  showTo(playerId: string | undefined, text: string): string {
    return this.models.vault.showTo(playerId, text);
  }

  /**
   * A JSON text, such as a frame of an extension's room socket, with every string as `showTo`
   * gives it. Very long strings, such as images, pass as they are. Text that isn't JSON passes too.
   */
  showJsonTo(playerId: string | undefined, json: string): string {
    let value: JsonValue;
    try {
      value = JSON.parse(json) as JsonValue;
    } catch {
      return json;
    }
    return JSON.stringify(
      mapStrings(value, (text) => (text.length > SHOWN_LIMIT ? text : this.showTo(playerId, text))),
    );
  }

  /** Goes up whenever `showTo` may give something new for the same text. */
  get vaultVersion(): number {
    return this.models.vault.version;
  }

  /**
   * The room's model context as its next request would send it: every message, sections and
   * tool calls included, with personal values as placeholders. Only what is committed; a request
   * also carries the tools' definitions, which are not personal.
   */
  async modelView(
    roomId: string,
    context: Context,
    /** Leaves out what is private to others: a turn private to someone shows only who it was for. */
    viewer?: string,
  ): Promise<ModelViewMessage[]> {
    const conversation = await this.conversation(roomId, context);
    const view = await conversation.context(context);
    // As a request redacts it, so thinking it leaves out isn't shown either.
    const sent = redactContext(
      { messages: [...view.messages] },
      this.models.vault,
      this.models.detectors,
    );
    const asSent = new Map(view.messages.map((message, i) => [message, sent.messages[i]!]));
    const shown = (message: Message) => ({
      role: message.role,
      text: this.redact(messageText(asSent.get(message) ?? message)),
    });
    if (viewer === undefined) return view.messages.map(shown);
    const out: ModelViewMessage[] = [];
    let owner: Owner | undefined;
    view.entries.forEach((entry, index) => {
      if (TURN_ENTRIES.has(entry.kind)) owner = privateOwner(entry);
      const messages = view.contributions[index] ?? [];
      if (owner === undefined || owner.playerId === viewer) out.push(...messages.map(shown));
      else if (messages.length > 0)
        out.push({
          role: messages[0]!.role,
          text: this.redact(`(Private to ${owner.displayName}.)`),
        });
    });
    return out;
  }

  /** Stores what `redact` and `protect` added to the vault so far. */
  saveVault(): Promise<void> {
    return this.models.flush();
  }

  /** What the model would see for `text`: personal values replaced by placeholders. */
  redact(text: string): string {
    return this.models.vault.redact(text, this.models.detectors);
  }

  async attach(roomId: string, context: Context): Promise<AgentEventStream> {
    const room = await this.room(roomId, context);
    return attach(this.harness, room.conversationId as ConversationId, context);
  }

  /**
   * The room's conversation view: its transcript and live state now, then the Chord ops of every
   * commit that changes it. Holds raw entries and every built-in document, `pi.provider` included.
   */
  async watchRoom(roomId: string, context: Context): Promise<ConversationWatch> {
    return (await this.conversation(roomId, context)).watch(context);
  }

  private async room(roomId: string, context: Context): Promise<Room> {
    const room = await this.rooms.get(roomId, context);
    if (room === undefined) throw new RoomNotFound(roomId);
    return room;
  }

  /**
   * Lets each extension say goodbye before the assistant is deleted, such as federation telling
   * its guests' homes. Waits for each at most `RETIRE_TIMEOUT_MS`; failures are reported.
   */
  async retire(context: Context): Promise<void> {
    for (const { extension, retire } of this.installed) {
      if (retire === undefined) continue;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<void>((resolve) => {
        timer = setTimeout(() => {
          this.report(new Error(`${extension.name} took too long to retire`));
          resolve();
        }, RETIRE_TIMEOUT_MS);
      });
      try {
        await Promise.race([Promise.resolve(retire(context)), late]);
      } catch (error) {
        this.report(error);
      } finally {
        clearTimeout(timer);
      }
    }
  }

  async close(context: Context): Promise<void> {
    try {
      this.events.close();
      await this.spending.flush();
      this.spending.close();
      await this.harness.close(context);
    } finally {
      await closeAll(this.installed, this.report);
      await this.unlock();
    }
  }
}

/** How long an extension may take to retire before an assistant's deletion goes on without it. */
export const RETIRE_TIMEOUT_MS = 15_000;

/** Strings longer than this in a socket frame are data, such as a screenshot, not text. */
const SHOWN_LIMIT = 64 * 1024;

/** Entries that start a turn: what comes after them, up to the next, answers them. */
const TURN_ENTRIES: ReadonlySet<string> = new Set([
  MESSAGE_ENTRY,
  "pi.user",
  FIRE_ENTRY,
  APPROVAL_ENTRY,
  "pi.compaction",
  "pi.reset",
]);

/** Who a turn-starting entry is private to, if anyone. */
function privateOwner(entry: EntryRecord): Owner | undefined {
  const data = entry.data as
    | { private?: true; playerId?: string; displayName?: string; privateTo?: Owner }
    | undefined;
  if (entry.kind === MESSAGE_ENTRY)
    return data?.private === true && data.playerId !== undefined
      ? { playerId: data.playerId, displayName: data.displayName ?? data.playerId }
      : undefined;
  if (entry.kind === FIRE_ENTRY || entry.kind === APPROVAL_ENTRY) return data?.privateTo;
  return undefined;
}

/** A value only one player may see. */
export type PrivateValue = {
  readonly placeholder: string;
  readonly kind: string;
  readonly value: string;
};

/** Someone tried what only others may do. */
export class NotAllowed extends Error {
  override name = "NotAllowed";
}

/** One message of a room's model context, as text. */
export type ModelViewMessage = {
  readonly role: "system" | "user" | "assistant" | "toolResult";
  readonly text: string;
};

function messageText(message: Message): string {
  if (message.role === "system") {
    // Sections carry the prompt: who the assistant is, the room, memory, the time.
    const parts = [
      typeof message.content === "string"
        ? message.content
        : message.content.map((part) => part.text).join("\n"),
      ...Object.entries(message.sections ?? {}).map(([name, text]) =>
        text === null ? `[section ${name} removed]` : text,
      ),
    ];
    if (message.toolsAdded?.length)
      parts.push(`[tools added: ${message.toolsAdded.map((tool) => tool.name).join(", ")}]`);
    if (message.toolsRemoved?.length)
      parts.push(`[tools removed: ${message.toolsRemoved.map((tool) => tool.name).join(", ")}]`);
    return parts.filter((part) => part !== "").join("\n\n");
  }
  if (typeof message.content === "string") return message.content;
  const parts = message.content as readonly (
    | { type: "text"; text: string }
    | { type: "thinking"; thinking: string }
    | { type: "toolCall"; name: string; arguments: unknown }
    | { type: "image" }
  )[];
  const text = parts
    .map((part) => {
      switch (part.type) {
        case "text":
          return part.text;
        case "thinking":
          return `[thinking] ${part.thinking}`;
        case "toolCall":
          return `[calls ${part.name}] ${JSON.stringify(part.arguments)}`;
        case "image":
          return "[image]";
        default:
          return "";
      }
    })
    .join("\n");
  return message.role === "toolResult" ? `[${message.toolName} returned] ${text}` : text;
}

export class RoomNotFound extends Error {
  override name = "RoomNotFound";
  constructor(readonly roomId: string) {
    super(`No room "${roomId}"`);
  }
}

/** Room events start from the approvals pending now, so only new ones are announced. */
async function openRoomEvents(
  harness: Harness,
  context: Context,
  report: (error: unknown) => void,
): Promise<RoomEvents> {
  const directory = await harness.snapshot(DirectoryDoc, context);
  const approvals = new Map<string, ApprovalsState>();
  for (const roomId of Object.keys(directory?.rooms ?? {})) {
    const state = await harness.snapshot(ApprovalsDoc, roomId, context);
    if (state !== undefined) approvals.set(roomId, state);
  }
  return new RoomEvents(harness, directory, approvals, report);
}

/**
 * Sets up every extension, or none: when one fails, those set up before it are closed again. With
 * `onBroken`, one whose setup throws is handed to it and left out instead, and the rest start.
 */
async function setUpAll(
  inputs: readonly ExtensionInput[],
  host: Parts["host"],
  onBroken?: (extension: BrokenExtension, error: unknown) => void,
): Promise<SetUpExtension[]> {
  const installed: SetUpExtension[] = [];
  try {
    for (const input of inputs) {
      let setUp: SetUpExtension;
      try {
        setUp = await setUpExtension(input, host);
      } catch (error) {
        if (onBroken === undefined) throw error;
        onBroken(brokenExtension(input, error), error);
        continue;
      }
      const twice = installed.some(({ extension }) => extension.name === setUp.extension.name);
      installed.push(setUp);
      if (twice) throw new Error(`Extension "${setUp.extension.name}" is installed twice`);
    }
  } catch (error) {
    await closeAll(installed, () => {});
    throw error;
  }
  return installed;
}

function brokenExtension(input: ExtensionInput, error: unknown): BrokenExtension {
  return {
    ...aboutExtension(input),
    error: error instanceof Error ? error.message : String(error),
  };
}

async function closeAll(
  installed: readonly SetUpExtension[],
  report: (error: unknown) => void,
): Promise<void> {
  for (const { close } of installed) {
    try {
      await close?.();
    } catch (error) {
      report(error);
    }
  }
}

function onByDefault(room: Pick<Room, "kind">, installed: SetUpExtension): boolean {
  return installed.rooms === undefined || installed.rooms.includes(room.kind);
}

function enabledIn(room: Pick<Room, "kind" | "extensions">, installed: SetUpExtension): boolean {
  return room.extensions?.[installed.extension.name] ?? onByDefault(room, installed);
}

function publicToolsOf(installed: readonly SetUpExtension[]): Set<string> {
  return new Set(installed.flatMap(({ publicTools }) => publicTools ?? []));
}

/** Kinds that are no longer hidden unless someone owns the value (ADR 15). */
const READABLE_KINDS = new Set([
  "NAME",
  "PLACE",
  "ORG",
  "ADDRESS",
  "DOMAIN",
  "IP",
  "USERNAME",
  "HOST",
  "PLATE",
  "VIN",
  "BIRTHDATE",
]);

/** Releases the vault's values of readable kinds, once per vault. */
async function releaseReadable(models: RedactingModels): Promise<void> {
  for (const entry of models.vault.entries)
    if (READABLE_KINDS.has(entry.kind)) models.vault.release(entry.placeholder);
  await models.flush();
}

function withExtensionDetectors(
  own: readonly PiiDetector[],
  installed: readonly SetUpExtension[],
): PiiDetector[] {
  return [...own, ...installed.flatMap(({ detectors }) => detectors)];
}

/** The config file is the source of truth: carry a changed model or instructions into the stored agent. */
async function followConfig(
  conversation: Conversation,
  options: NudgeOptions,
  context: Context,
): Promise<void> {
  const agent = await conversation.agent(context);
  const modelChanged =
    agent.model?.provider !== options.model.provider ||
    agent.model?.modelId !== options.model.modelId;
  const instructionsChanged = (agent.instructions ?? undefined) !== options.instructions;
  if (!modelChanged && !instructionsChanged) return;
  await conversation.configure(
    { model: options.model, instructions: options.instructions ?? null },
    context,
  );
}

async function openStorage(database: string, encryptNew = false): Promise<Storage> {
  if (database === ":memory:") return new MemoryStorage();
  return openDatabaseStorage(database, { encryptNew });
}
