import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { ConversationId } from "@earendil-works/pi-durable";
import { fillVariables } from "@nudge/bridge";
import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  type ExtensionHost,
  FIRE_ENTRY,
  type FireEntryData,
  inTurn,
  type Owner,
  readsOnly,
  requestApproval,
  roomOf,
  roomsSetting,
  section,
  Type,
} from "@nudge/core";
import { join } from "node:path";
import { Asked } from "./asked.ts";
import { type HostEntry, Hosts } from "./hosts.ts";
import {
  type AccBackend,
  type AccHost,
  type AccItem,
  type HarnessId,
  loadAcc,
  type PermissionOption,
} from "./native.ts";
import { type Attachment, cut, type Follow, type Pending, Sessions } from "./sessions.ts";

const VERSION = "0.1.0";
const context = BACKGROUND_CONTEXT;
const HARNESSES = ["claude", "codex", "cursor", "copilot", "pi", "opencode"] as const;
/** Characters of a session's transcript `acc_read` gives. */
const MAX_READ = 8_000;

const HostSettings = Type.Object({
  host: Type.String({
    minLength: 1,
    description: "Its address: a host name or IP the server reaches it at, such as 192.168.1.20.",
  }),
  name: Type.Optional(
    Type.String({
      description:
        "What you call the machine when you talk to the assistant, such as devbox; its address when left out.",
    }),
  ),
  port: Type.Optional(Type.Number({ description: "The SSH port; 22 when left out." })),
  user: Type.String({ minLength: 1, description: "The user the agents run as there." }),
  auth: Type.Optional(
    Type.Union([Type.Literal("key"), Type.Literal("agent"), Type.Literal("password")], {
      description:
        "How to log in: key, the assistant's own key (it gives you the line for ~/.ssh/authorized_keys); " +
        "agent, the server's ssh-agent; or password. Default key.",
    }),
  ),
  password: Type.Optional(
    Type.String({
      description:
        "For password login; write ${NAME} to take it from an environment variable instead.",
    }),
  ),
  rooms: Type.Optional(
    roomsSetting({
      title: "Rooms",
      description:
        "The rooms that may use this machine; every room the extension is on in when left out.",
    }),
  ),
});

const Settings = Type.Object({
  local: Type.Boolean({
    default: true,
    description:
      "Whether the assistant also reaches the coding sessions on the machine Nudge runs on, as the user Nudge runs as, with nothing to set up. Agents started there can read what that user can, Nudge's own data included.",
  }),
  hosts: Type.Array(HostSettings, {
    default: [],
    description: "The machines your coding agents run on, reached over SSH.",
  }),
  approveStart: Type.Boolean({
    default: true,
    description: "Whether starting a coding session waits for someone in the room to approve it.",
  }),
});

type StartPayload = {
  readonly host: string;
  readonly harness: HarnessId;
  readonly cwd: string;
  readonly prompt: string;
  readonly model?: string;
};

export type AccOptions = {
  /** ACC's binding; tests pass a fake. Default: the one `loadAcc` finds. */
  readonly backend?: AccBackend;
  readonly report?: (error: unknown) => void;
};

function text(value: string, isError = false) {
  return { output: [{ type: "text" as const, text: value }], ...(isError ? { isError } : {}) };
}

function privately(): { privateTo?: Owner } {
  const { privateTo } = currentTurn();
  return privateTo === undefined ? {} : { privateTo: { ...privateTo } };
}

/** Quotes for a POSIX shell. */
export function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

/** The option that answers yes once, and the one that answers no once. */
export function allowAndReject(options: readonly PermissionOption[]): {
  allow: string;
  reject: string;
} {
  const find = (...kinds: string[]) =>
    kinds.map((kind) => options.find((option) => option.kind === kind)).find(Boolean)?.id;
  return {
    allow: find("allow_once", "allow_always") ?? options[0]?.id ?? "allow",
    reject: find("reject_once", "reject_always") ?? options.at(-1)?.id ?? "reject",
  };
}

/** A transcript's items as lines, the newest last. */
export function transcript(items: readonly AccItem[], last: number): string {
  const lines = items
    .filter((item) => item.kind !== "reasoning")
    .slice(-last)
    .map((item) => {
      const failed = item.status === "failed" ? " (failed)" : "";
      switch (item.kind) {
        case "user_message":
          return `› ${cut(item.text, 1_000)}`;
        case "agent_message":
          return `‹ ${cut(item.text, 2_000)}`;
        case "command_execution":
          return `$ ${cut(item.detail.command ?? item.detail.title ?? "a command", 300)}${failed}`;
        case "file_change":
          return `✎ ${(item.detail.files ?? []).map((file) => file.path).join(", ") || "files"}${failed}`;
        case "subagent":
          return `⇢ subagent: ${cut(item.detail.title ?? item.text, 300)}${failed}`;
        default:
          return `· ${cut(item.detail.title ?? item.text, 300)}${failed}`;
      }
    });
  const all = lines.join("\n");
  return all.length > MAX_READ ? `…${all.slice(-MAX_READ)}` : all;
}

function describeState(attachment: Attachment): string {
  if (attachment.exit !== undefined)
    return attachment.exit.code === null ? "exited" : `exited (${attachment.exit.code})`;
  const state = attachment.state?.state;
  if (state === undefined) return "starting";
  if (state.state === "blocked") return `waiting on ${state.kind}`;
  return state.state;
}

/**
 * The machines from the settings, with this machine first as `local` when `local` is on, and
 * names made unique: a second "devbox" is "devbox-2".
 */
export function machines(local: boolean, configured: readonly HostEntry[]): HostEntry[] {
  const all: HostEntry[] = [
    ...(local
      ? [
          {
            name: "local",
            host: "localhost",
            port: 22,
            user: "",
            auth: "local" as const,
            rooms: ["*"],
          },
        ]
      : []),
    ...configured,
  ];
  const taken = new Set<string>();
  return all.map((entry) => {
    let name = entry.name;
    for (let n = 2; taken.has(name.toLowerCase()); n++) name = `${entry.name}-${n}`;
    taken.add(name.toLowerCase());
    return name === entry.name ? entry : { ...entry, name };
  });
}

/** The extension with its binding chosen; the default export loads ACC's. */
export function accExtension(options: AccOptions = {}) {
  return defineNudgeExtension({
    name: "acc",
    version: VERSION,
    description:
      "Start, watch and steer coding agents (Claude Code, Codex, Cursor, Copilot, pi, opencode) on your machines over SSH.",
    settings: Settings,
    setup: (host) => {
      const backend = options.backend ?? loadAcc();
      const report = options.report ?? ((error: unknown) => console.error("acc:", error));
      let changedKeys: ReadonlyMap<string, string> = new Map();
      const entries = machines(
        host.settings.local,
        host.settings.hosts.map((entry) => ({
          name: entry.name?.trim() || entry.host.trim(),
          host: entry.host.trim(),
          port: entry.port ?? 22,
          user: entry.user,
          auth: entry.auth ?? "key",
          ...(entry.password === undefined
            ? {}
            : { password: fillVariables(entry.password, process.env, "acc") }),
          rooms: entry.rooms ?? ["*"],
        })),
      );
      const problems = (): string[] => [
        ...(backend === undefined
          ? [
              "ACC's Node binding isn't installed: run pnpm acc:fetch in a checkout, or set NUDGE_ACC_MODULE to its index.js.",
            ]
          : []),
        ...(entries.length === 0 ? ["No machines are set up for coding agents."] : []),
        ...(backend !== undefined && backend.localHost === undefined && host.settings.local
          ? [
              "This ACC binding can't reach this machine's sessions; run pnpm acc:fetch for a newer one.",
            ]
          : []),
        ...[...changedKeys].map(
          ([name, key]) => `${name} shows a host key other than the one pinned (${key}).`,
        ),
      ];
      if (backend === undefined)
        return {
          problems,
          tools: [],
        };

      const hosts = new Hosts(
        entries,
        backend,
        host.secrets,
        host.dataDir === undefined ? undefined : join(host.dataDir, "hosts.json"),
        `nudge-${host.name}`,
      );
      changedKeys = hosts.changedKeys;
      const sessions = new Sessions(
        hosts,
        host.dataDir === undefined ? undefined : join(host.dataDir, "follows.json"),
        tell(host, report),
      );
      const asked = {
        starts: new Asked<StartPayload>(
          host.dataDir === undefined ? undefined : join(host.dataDir, "starts.json"),
        ),
        trusts: new Asked<string>(
          host.dataDir === undefined ? undefined : join(host.dataDir, "trusts.json"),
        ),
      };
      const stop = new AbortController();
      // Followed sessions are read again once the assistant is open.
      const restoring = host
        .whenOpen()
        .then(() => (stop.signal.aborted ? undefined : sessions.restore()))
        .catch(() => undefined);

      const usable = (roomId: string, name: string): HostEntry | string => {
        const here = hosts.usableIn(roomId);
        if (here.length === 0)
          return "No machine for coding agents is set up for this conversation.";
        return (
          here.find((entry) => entry.name.toLowerCase() === name.trim().toLowerCase()) ??
          `No machine "${name}" here; there is ${here.map((e) => e.name).join(", ")}.`
        );
      };

      /** Where the session runs, from a directory as given (`~/…` is the user's home). */
      const resolveDir = async (connection: AccHost, dir: string): Promise<string> => {
        const target =
          dir === "~"
            ? '"$HOME"'
            : dir.startsWith("~/")
              ? `"$HOME"/${quote(dir.slice(2))}`
              : quote(dir);
        const out = await connection.exec(`cd -- ${target} && pwd -P`);
        if (out.exitCode !== 0) throw new Error(`There is no directory ${dir} there.`);
        return out.stdout.toString().trim();
      };

      const start = async (
        roomId: string,
        privateTo: Owner | undefined,
        args: StartPayload,
      ): Promise<string> => {
        const connection = await hosts.connect(args.host);
        const cwd = await resolveDir(connection, args.cwd);
        const id = backend.newSessionId(args.harness);
        const attachment = await sessions.launch(args.host, id, args.harness, cwd, args.model);
        await sessions.follow(attachment, {
          host: args.host,
          id,
          harness: args.harness,
          cwd,
          roomId,
          ...(privateTo === undefined ? {} : { privateTo }),
        });
        if (args.prompt.trim() !== "") await attachment.send({ type: "prompt", text: args.prompt });
        return (
          `Started ${args.harness} on ${args.host} in ${cwd} as session ${id}. This room follows ` +
          "it: you'll hear when it finishes a turn, fails or exits, and its permission requests " +
          "come to the room as approvals."
        );
      };

      /** The session, read and caught up, for tools that act on it. */
      const reach = async (
        roomId: string,
        name: string,
        id: string,
      ): Promise<Attachment | string> => {
        const entry = usable(roomId, name);
        if (typeof entry === "string") return entry;
        const attachment = await sessions.attach(entry.name, id);
        if (!(await attachment.ready()))
          return `Session ${name}/${id} is still catching up on its log; try again in a moment.`;
        return attachment;
      };

      const sessionParameters = {
        host: Type.String({ description: "The machine's name." }),
        id: Type.String({ description: "The session id, from acc_sessions or acc_start." }),
      };

      const hostsTool = defineTool({
        name: "acc_hosts",
        description:
          "The machines coding agents run on: whether each can be reached, which agents are installed, and the " +
          "line to add to ~/.ssh/authorized_keys when a machine doesn't let the assistant in yet. With " +
          "trust_new_key, asks an admin to trust a machine's new host key after it changed.",
        parameters: Type.Object({
          trust_new_key: Type.Optional(
            Type.String({ description: "A machine whose changed host key an admin should trust." }),
          ),
        }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          if (args.trust_new_key !== undefined) {
            const entry = usable(room.id, args.trust_new_key);
            if (typeof entry === "string") return text(entry, true);
            const shown = hosts.changedKeys.get(entry.name);
            const approval = await api.commit(
              (tx) =>
                requestApproval(
                  tx,
                  room.id,
                  {
                    extension: "acc",
                    kind: "trust",
                    summary:
                      `Trust ${entry.name}'s new host key${shown === undefined ? "" : ` (${shown})`}. Only if ` +
                      "you know why it changed, such as a reinstall.",
                    payload: {},
                    adminOnly: true,
                  },
                  host.now(),
                ),
              ctx,
            );
            asked.trusts.set(room.id, approval.id, entry.name);
            return {
              ...text(`Waiting for an admin to approve it (${approval.id}).`),
              details: { approval: approval.id },
            };
          }
          const here = hosts.usableIn(room.id);
          if (here.length === 0)
            return text("No machine for coding agents is set up for this conversation.", true);
          const lines = await Promise.all(
            here.map(async (entry) => {
              const name =
                entry.auth === "local"
                  ? `${entry.name} (this machine${entry.user === "" ? "" : `, as ${entry.user}`})`
                  : `${entry.name} (${entry.user}@${entry.host}${entry.port === 22 ? "" : `:${entry.port}`})`;
              try {
                const connection = await hosts.connect(entry.name);
                const found = await connection.probe();
                const agents = found
                  .map((a) => `${a.harness}${a.version === null ? "" : ` ${a.version}`}`)
                  .join(", ");
                return `${name}: reachable; agents: ${agents || "none found"}`;
              } catch (error) {
                return `${name}: ${(error as Error).message}`;
              }
            }),
          );
          const key = here.some((entry) => entry.auth === "key")
            ? `\n\nThe assistant's key, for ~/.ssh/authorized_keys on machines that log in with it:\n${hosts.publicKey()}`
            : "";
          return text(`${lines.join("\n")}${key}`);
        },
      });

      const sessionsTool = defineTool({
        name: "acc_sessions",
        description:
          "The coding sessions on the machines, newest first, from any client (also ones started from Sessh or " +
          "the acc CLI): id, agent, directory, whether it runs, and for ones this room follows what it's doing.",
        parameters: Type.Object({
          host: Type.Optional(Type.String({ description: "Only this machine." })),
          limit: Type.Optional(
            Type.Number({ description: "At most this many per machine; default 15." }),
          ),
        }),
        replay: "safe",
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const here = hosts
            .usableIn(room.id)
            .filter((entry) => args.host === undefined || entry.name === args.host);
          if (here.length === 0)
            return text(
              args.host === undefined
                ? "No machine for coding agents is set up for this conversation."
                : `No machine "${args.host}" here.`,
              true,
            );
          const followed = sessions.followed(room.id);
          const blocks = await Promise.all(
            here.map(async (entry) => {
              try {
                const connection = await hosts.connect(entry.name);
                const listed = (await connection.listSessions())
                  .sort((a, b) => (b.modified ?? 0) - (a.modified ?? 0))
                  .slice(0, Math.max(1, args.limit ?? 15));
                if (listed.length === 0) return `${entry.name}: no sessions`;
                const lines = await Promise.all(
                  listed.map(async (session) => {
                    const status =
                      session.status.status === "alive"
                        ? "running"
                        : session.status.status === "exited"
                          ? `exited${session.status.code === null ? "" : ` (${session.status.code})`}`
                          : "gone";
                    const follows = followed.some(
                      (f) => f.host === entry.name && f.id === session.id,
                    );
                    const attachment = follows
                      ? await sessions.current(entry.name, session.id)
                      : undefined;
                    const age =
                      session.modified === null
                        ? ""
                        : `, last active ${Math.round((host.now() / 1000 - session.modified) / 60)} min ago`;
                    return (
                      `  ${session.id}: ${session.spec?.harness ?? "?"} in ${session.spec?.cwd ?? "?"}, ${status}${age}` +
                      (attachment === undefined
                        ? ""
                        : `; followed here, ${describeState(attachment)}`) +
                      (session.spec?.title ? ` — ${session.spec.title}` : "")
                    );
                  }),
                );
                return `${entry.name}:\n${lines.join("\n")}`;
              } catch (error) {
                return `${entry.name}: ${(error as Error).message}`;
              }
            }),
          );
          return text(blocks.join("\n"));
        },
      });

      const startTool = defineTool({
        name: "acc_start",
        description:
          "Start a coding agent on a machine in a directory there, with a first prompt. The room follows the " +
          "session: you hear when it finishes a turn, fails or exits, and its permission requests come to the " +
          `room as approvals. ${host.settings.approveStart ? "It waits for someone in the room to approve starting it; say so." : ""}`,
        parameters: Type.Object({
          host: Type.String({ description: "The machine's name." }),
          harness: Type.Union(
            HARNESSES.map((h) => Type.Literal(h)),
            {
              description:
                "The agent: claude (Claude Code), codex, cursor, copilot, pi or opencode.",
            },
          ),
          cwd: Type.String({
            description: "The directory there, absolute or ~/… for the user's home.",
          }),
          prompt: Type.String({ description: "What the agent should do." }),
          model: Type.Optional(
            Type.String({ description: "A model the agent knows; its default when left out." }),
          ),
        }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const entry = usable(room.id, args.host);
          if (typeof entry === "string") return text(entry, true);
          const payload: StartPayload = {
            host: entry.name,
            harness: args.harness,
            cwd: args.cwd,
            prompt: args.prompt,
            ...(args.model === undefined ? {} : { model: args.model }),
          };
          if (!host.settings.approveStart) {
            try {
              return text(await start(room.id, privately().privateTo, payload));
            } catch (error) {
              return text((error as Error).message, true);
            }
          }
          const approval = await api.commit(
            (tx) =>
              requestApproval(
                tx,
                room.id,
                {
                  extension: "acc",
                  kind: "start",
                  summary:
                    `Start ${args.harness} on ${entry.name} in ${args.cwd}` +
                    `${args.model === undefined ? "" : ` with ${args.model}`}:\n${cut(args.prompt, 600)}`,
                  payload: {},
                },
                host.now(),
              ),
            ctx,
          );
          asked.starts.set(room.id, approval.id, payload);
          return {
            ...text(`Waiting for someone in the room to approve starting it (${approval.id}).`),
            details: { approval: approval.id },
          };
        },
      });

      const readTool = defineTool({
        name: "acc_read",
        description:
          "What a coding session is doing: its state, requests it waits on, and its latest messages, commands " +
          "and file changes.",
        parameters: Type.Object({
          ...sessionParameters,
          last: Type.Optional(
            Type.Number({ description: "How many of the latest items; default 30." }),
          ),
        }),
        replay: "safe",
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          try {
            const attachment = await reach(room.id, args.host, args.id);
            if (typeof attachment === "string") return text(attachment, true);
            const waiting = [...attachment.pending.values()].map(
              (p) =>
                `Waiting on ${p.kind} (request ${p.requestId}): ${p.title}` +
                (p.options.length === 0
                  ? ""
                  : ` [${p.options.map((o) => `${o.id}: ${o.label}`).join("; ")}]`),
            );
            const items = transcript(
              attachment.session.topLevelItems(),
              Math.min(Math.max(1, args.last ?? 30), 200),
            );
            return text(
              [
                `${args.host}/${args.id}: ${attachment.harness} in ${attachment.cwd}, ${describeState(attachment)}` +
                  (attachment.follow?.roomId === room.id ? ", followed here" : ""),
                ...waiting,
                "",
                items || "(nothing yet)",
              ].join("\n"),
            );
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const sendTool = defineTool({
        name: "acc_send",
        description:
          "Send a coding session a message, as the next prompt; it queues while the agent works.",
        parameters: Type.Object({ ...sessionParameters, text: Type.String({ minLength: 1 }) }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          try {
            const attachment = await reach(room.id, args.host, args.id);
            if (typeof attachment === "string") return text(attachment, true);
            if (attachment.exit !== undefined)
              return text(`${args.host}/${args.id} has exited.`, true);
            await attachment.send({ type: "prompt", text: args.text });
            return text(`Sent to ${args.host}/${args.id}.`);
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const answerTool = defineTool({
        name: "acc_answer",
        description:
          "Answer what a coding session waits on: a question with text, or a permission request with one of its " +
          "options. Only when someone in the room said what to answer; permission requests otherwise come as approvals.",
        parameters: Type.Object({
          ...sessionParameters,
          request_id: Type.Optional(
            Type.String({ description: "Which request; default the only one waiting." }),
          ),
          answer: Type.String({
            description:
              "An option's id or label, allow or deny, or for a question the answer's text.",
          }),
        }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          try {
            const attachment = await reach(room.id, args.host, args.id);
            if (typeof attachment === "string") return text(attachment, true);
            const waiting = [...attachment.pending.values()];
            const pending: Pending | undefined =
              args.request_id === undefined
                ? waiting.length === 1
                  ? waiting[0]
                  : undefined
                : attachment.pending.get(args.request_id);
            if (pending === undefined)
              return text(
                waiting.length === 0
                  ? `${args.host}/${args.id} waits on nothing.`
                  : `Say which request: ${waiting.map((p) => `${p.requestId} (${p.title})`).join(", ")}.`,
                true,
              );
            const { allow, reject } = allowAndReject(pending.options);
            const said = args.answer.trim().toLowerCase();
            const option =
              pending.options.find((o) => o.id === args.answer || o.label.toLowerCase() === said)
                ?.id ??
              (said === "allow" || said === "yes"
                ? allow
                : said === "deny" || said === "no"
                  ? reject
                  : undefined) ??
              (pending.kind === "permission" ? undefined : args.answer);
            if (option === undefined)
              return text(
                `Answer with one of: ${pending.options.map((o) => `${o.id} (${o.label})`).join(", ")}.`,
                true,
              );
            await attachment.send({
              type: "answer_permission",
              request_id: pending.requestId,
              option_id: option,
            });
            return text(`Answered ${pending.requestId} in ${args.host}/${args.id}.`);
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const controlTool = defineTool({
        name: "acc_control",
        description:
          "Steer a coding session: interrupt its turn, stop it (the agent exits), remove an exited one's files, " +
          "compact its context, or switch its model (value).",
        parameters: Type.Object({
          ...sessionParameters,
          action: Type.Union([
            Type.Literal("interrupt"),
            Type.Literal("stop"),
            Type.Literal("remove"),
            Type.Literal("compact"),
            Type.Literal("model"),
          ]),
          value: Type.Optional(Type.String({ description: "The model, for model." })),
        }),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const entry = usable(room.id, args.host);
          if (typeof entry === "string") return text(entry, true);
          try {
            if (args.action === "remove") {
              const connection = await hosts.connect(entry.name);
              const listed = (await connection.listSessions()).find((s) => s.id === args.id);
              if (listed?.status.status === "alive")
                return text(`${args.host}/${args.id} still runs; stop it first.`, true);
              await connection.removeSession(args.id);
              await sessions.unfollow(entry.name, args.id);
              return text(`Removed ${args.host}/${args.id}.`);
            }
            const attachment = await reach(room.id, args.host, args.id);
            if (typeof attachment === "string") return text(attachment, true);
            if (attachment.exit !== undefined)
              return text(`${args.host}/${args.id} has exited.`, true);
            switch (args.action) {
              case "stop":
                await attachment.session.stop();
                return text(`Asked ${args.host}/${args.id} to exit.`);
              case "interrupt":
                await attachment.send({ type: "interrupt" });
                return text(`Interrupted ${args.host}/${args.id}.`);
              case "compact":
                await attachment.send({ type: "compact", hint: null });
                return text(`Asked ${args.host}/${args.id} to compact its context.`);
              case "model":
                if (args.value === undefined) return text("Give the model as value.", true);
                await attachment.send({ type: "set_option", id: "model", value: args.value });
                return text(`Switched ${args.host}/${args.id} to ${args.value}.`);
            }
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const followTool = defineTool({
        name: "acc_follow",
        description:
          "Have this room follow a coding session, such as one started elsewhere: you hear when it finishes a " +
          "turn, fails or exits, and its permission requests come as approvals. A session follows in one room.",
        parameters: Type.Object(sessionParameters),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          try {
            const attachment = await reach(room.id, args.host, args.id);
            if (typeof attachment === "string") return text(attachment, true);
            if (attachment.exit !== undefined)
              return text(`${args.host}/${args.id} has exited.`, true);
            await sessions.follow(attachment, {
              host: args.host,
              id: args.id,
              harness: attachment.harness,
              cwd: attachment.cwd,
              roomId: room.id,
              ...privately(),
            });
            return text(
              `This room follows ${args.host}/${args.id} (${attachment.harness} in ${attachment.cwd}, ` +
                `${describeState(attachment)}).`,
            );
          } catch (error) {
            return text((error as Error).message, true);
          }
        },
      });

      const unfollowTool = defineTool({
        name: "acc_unfollow",
        description: "Stop following a coding session here. It keeps running.",
        parameters: Type.Object(sessionParameters),
        execute: async (args, api, ctx) => {
          const room = await roomOf(api, api.conversationId, ctx);
          const follow = sessions
            .followed(room.id)
            .find(
              (f) => f.host.toLowerCase() === args.host.trim().toLowerCase() && f.id === args.id,
            );
          if (follow === undefined)
            return text(`This room doesn't follow ${args.host}/${args.id}.`, true);
          await sessions.unfollow(follow.host, follow.id);
          return text(`This room no longer follows ${args.host}/${args.id}.`);
        },
      });

      /** The request a permission approval is about, in its session, caught up. */
      const forApproval = async (
        roomId: string,
        approvalId: string,
      ): Promise<{ attachment: Attachment; pending: Pending } | undefined> => {
        for (const follow of sessions.followed(roomId)) {
          const requestId = Object.entries(follow.approvals).find(
            ([, id]) => id === approvalId,
          )?.[0];
          if (requestId === undefined) continue;
          const attachment = await sessions.attach(follow.host, follow.id);
          const pending = (await attachment.ready())
            ? attachment.pending.get(requestId)
            : undefined;
          return pending === undefined ? undefined : { attachment, pending };
        }
        return undefined;
      };

      return {
        problems,
        tools: [
          // Trusting a new host key asks an admin: never from a script.
          readsOnly(hostsTool, (args) => args.trust_new_key === undefined),
          readsOnly(sessionsTool),
          startTool,
          readsOnly(readTool),
          sendTool,
          answerTool,
          controlTool,
          followTool,
          unfollowTool,
        ],
        sections: [
          section("acc", async (input, ctx) => {
            const room = await roomOf(input.read, input.conversationId, ctx).catch(() => undefined);
            if (room === undefined) return undefined;
            const here = hosts.usableIn(room.id);
            if (here.length === 0) return undefined;
            const followed = await Promise.all(
              sessions.followed(room.id).map(async (follow) => {
                const attachment = await sessions.current(follow.host, follow.id);
                return `${follow.host}/${follow.id} (${follow.harness} in ${follow.cwd}${
                  attachment === undefined ? "" : `, ${describeState(attachment)}`
                })`;
              }),
            );
            return (
              `Coding agents run on these machines: ${here.map((e) => e.name).join(", ")}. Start one with ` +
              "acc_start, list sessions with acc_sessions, read one with acc_read, and steer it with acc_send, " +
              "acc_answer and acc_control. You hear about sessions this room follows when they finish a turn, " +
              "fail or exit; their permission requests come as approvals." +
              (followed.length === 0 ? "" : ` This room follows: ${followed.join(", ")}.`)
            );
          }),
        ],
        approvals: {
          start: async (_payload, run) => {
            const request = asked.starts.take(run.room.id, run.approval.id);
            if (request === undefined) return { text: "What to start was lost.", isError: true };
            return { text: await start(run.room.id, run.approval.privateTo, request) };
          },
          permission: async (_payload, run) => {
            const found = await forApproval(run.room.id, run.approval.id);
            if (found === undefined)
              return { text: "It was answered already, or the session moved on.", isError: true };
            const { attachment, pending } = found;
            await attachment.send({
              type: "answer_permission",
              request_id: pending.requestId,
              option_id: allowAndReject(pending.options).allow,
            });
            return { text: `Allowed ${attachment.host}/${attachment.id}: ${pending.title}` };
          },
          trust: async (_payload, run) => {
            const name = asked.trusts.take(run.room.id, run.approval.id);
            if (name === undefined) return { text: "Which machine was lost.", isError: true };
            await hosts.trustNewKey(name);
            await hosts.connect(name);
            return { text: `Trusted ${name}'s new host key (${hosts.pinned(name) ?? "?"}).` };
          },
        },
        denials: {
          permission: async (_payload, run) => {
            const found = await forApproval(run.room.id, run.approval.id);
            await found?.attachment.send({
              type: "answer_permission",
              request_id: found.pending.requestId,
              option_id: allowAndReject(found.pending.options).reject,
            });
          },
          start: async (_payload, run) => {
            asked.starts.take(run.room.id, run.approval.id);
          },
          trust: async (_payload, run) => {
            asked.trusts.take(run.room.id, run.approval.id);
          },
        },
        close: async () => {
          stop.abort();
          await restoring;
          await sessions.close();
          await hosts.close();
        },
      };
    },
  });
}

/** Tells rooms about the sessions they follow: input the assistant answers, and approvals. */
function tell(
  host: Pick<ExtensionHost<unknown>, "assistant" | "now">,
  report: (error: unknown) => void,
) {
  const turn = (follow: Follow) => {
    const nudge = host.assistant();
    return {
      redact: (value: string) => nudge.redact(value),
      ...(follow.privateTo === undefined ? {} : { privateTo: follow.privateTo }),
    };
  };
  return {
    report,
    post: async (follow: Follow, key: string, content: string, message: string) => {
      const nudge = host.assistant();
      const room = await nudge.rooms.get(follow.roomId, context);
      if (room === undefined) return;
      const conversation = await nudge.harness.conversation(
        room.conversationId as ConversationId,
        context,
      );
      await conversation?.submit(
        {
          type: "input",
          content: nudge.redact(content),
          whenBusy: "followUp",
          // Makes a repeat after a restart find this submission instead of adding another.
          requestId: `acc:${follow.host}/${follow.id}:${key}`,
          entry: {
            kind: FIRE_ENTRY,
            data: {
              nudgeId: `acc-${follow.host}-${follow.id}`,
              message: nudge.redact(message),
              fireAt: host.now(),
              source: "watch",
              ...(follow.privateTo === undefined ? {} : { privateTo: follow.privateTo }),
            } satisfies FireEntryData,
          },
        },
        context,
      );
    },
    ask: async (follow: Follow, pending: Pending): Promise<string> => {
      const nudge = host.assistant();
      const input =
        pending.input === undefined ? "" : `\n${cut(JSON.stringify(pending.input, null, 1), 600)}`;
      const approval = await inTurn(turn(follow), () =>
        nudge.harness.commit(
          (tx) =>
            requestApproval(
              tx,
              follow.roomId,
              {
                extension: "acc",
                kind: "permission",
                summary: `${follow.harness} on ${follow.host} (${follow.cwd}) asks: ${pending.title}${input}`,
                // Which request it is, is kept with the follow; see `Asked`.
                payload: {},
              },
              host.now(),
            ),
          context,
        ),
      );
      return approval.id;
    },
  };
}

export default accExtension();
