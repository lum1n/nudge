import { readFile } from "node:fs/promises";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  DatabaseInUse,
  findAssistant,
  loadConfig,
  type Nudge,
  openAssistant,
  parseAddress,
} from "@nudge/core";
import type {
  AdminPlayer,
  ErrorResponse,
  HomeNudge,
  NudgesResponse,
  PairingCodeResponse,
  PairResponse,
  PlayerResponse,
  PlayersResponse,
  Room,
  RoomsResponse,
  TokenInfo,
  TokensResponse,
  UsageResponse,
} from "@nudge/protocol";
import { toHomeNudge, toRoom } from "@nudge/protocol/project";
import { pairingLink } from "@nudge/server";
import { renderUnicodeCompact } from "uqr";
import { UsageError } from "../errors.ts";
import { describeNudge } from "../render.ts";

export type AdminOptions = {
  readonly config: string;
  readonly assistant?: string;
};

const context = BACKGROUND_CONTEXT;

/**
 * How admin commands reach an assistant whose database another process has open: through the
 * server at `server` (only its origin counts), as the admin whose token is `token`.
 */
export type ServerAccess = {
  readonly server: string;
  readonly token?: string;
};

/**
 * Adds a player and prints their token, once, with a sign-in link for the web UI on `server`.
 * While the assistant runs, adds them through the server and prints a pairing code instead.
 */
export async function invite(
  options: AdminOptions & ServerAccess & { readonly name: string },
): Promise<void> {
  if (parseAddress(options.name) !== undefined) return inviteAddress(options, options.name);
  await withAssistantOrServer(
    options,
    async (nudge) => {
      const { player, token } = await nudge.players.invite(options.name, context);
      console.log(
        `Invited ${player.displayName} as "${player.id}". Their token, shown only now:\n`,
      );
      console.log(`  ${token}\n`);
      console.log(`In a browser: ${new URL("/login", options.server).href}#token=${token}`);
      const pick = options.assistant === undefined ? "" : ` -a ${options.assistant}`;
      console.log(
        `In a terminal: NUDGE_TOKEN=<token> nudge chat --url ${new URL(options.server).origin}${pick}`,
      );
    },
    async (server) => {
      const { player } = await server.call<PlayerResponse>("POST", "/admin/players", {
        displayName: options.name,
      });
      console.log(`Invited ${player.displayName} as "${player.id}".\n`);
      printPairing(
        await server.call<PairingCodeResponse>("POST", "/admin/pairing-codes", {
          playerId: player.id,
        }),
      );
    },
  );
}

type FederationInvite = { invite: { address: string; expiresAt: number }; link: string };

/** Lets someone whose home is another assistant join, through the federation extension (ADR 10). */
async function inviteAddress(options: AdminOptions & ServerAccess, address: string): Promise<void> {
  const print = ({ invite, link }: FederationInvite) => {
    console.log(`Invited ${invite.address} until ${new Date(invite.expiresAt).toLocaleString()}.`);
    console.log(`They join from their app, signed in at home, with this link:\n\n  ${link}\n`);
    console.log(renderUnicodeCompact(link));
  };
  await withAssistantOrServer(
    options,
    async (nudge) => {
      const found = nudge.extensionRoute("federation", "POST", "/invites");
      if (found === undefined)
        throw new UsageError(
          "Inviting people from other assistants needs the federation extension",
        );
      const players = await nudge.players.list(context);
      const admins = await Promise.all(players.map((p) => nudge.players.isAdmin(p.id, context)));
      const by = players.find((_, index) => admins[index]);
      if (by === undefined)
        throw new UsageError("Invite someone of your own first: nudge invite <name>");
      const response = await found.route.handle(
        new Request("http://localhost/", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ address }),
        }),
        { player: by, admin: true, params: found.params, context },
      );
      const body = (await response.json()) as FederationInvite | ErrorResponse;
      if ("error" in body) throw new UsageError(body.error);
      print(body);
    },
    async (server) =>
      print(await server.call<FederationInvite>("POST", "/ext/federation/invites", { address })),
  );
}

/** Prints a one-time code, as a link and a QR code, that signs a new app in as `player`. */
export async function pair(
  options: AdminOptions & ServerAccess & { readonly player: string },
): Promise<void> {
  await withAssistantOrServer(
    options,
    async (nudge, assistant) => {
      await knownPlayer(nudge, options.player);
      const { code, expiresAt } = await nudge.players.pairingCode(options.player, context);
      printPairing({
        code,
        expiresAt,
        link: pairingLink(new URL(options.server).origin, assistant, code),
      });
    },
    async (server) =>
      printPairing(
        await server.call<PairingCodeResponse>("POST", "/admin/pairing-codes", {
          playerId: options.player,
        }),
      ),
  );
}

function printPairing({ code, link, expiresAt }: PairingCodeResponse): void {
  console.log("Scan this with the Nudge app, or open the link on the device:\n");
  console.log(renderUnicodeCompact(link, { border: 2 }));
  console.log(`\n  ${link}\n`);
  console.log(`Or type the code ${code} in the app.`);
  console.log(`It works once, until ${new Date(expiresAt).toLocaleTimeString()}.`);
}

/** Marks a player as an admin, or with `remove` not; lists the admins without a player. */
export async function admin(
  options: AdminOptions & ServerAccess & { readonly player?: string; readonly remove: boolean },
): Promise<void> {
  const print = (admins: readonly string[]) => {
    if (options.remove && options.player !== undefined && admins.includes(options.player))
      console.log(`${options.player} is the first player, and stays an admin.`);
    console.log(`Admins: ${admins.join(", ") || "none"}`);
  };
  await withAssistantOrServer(
    options,
    async (nudge) => {
      if (options.player !== undefined) {
        await knownPlayer(nudge, options.player);
        await nudge.players.setAdmin(options.player, !options.remove, context);
      }
      const admins: string[] = [];
      for (const player of await nudge.players.list(context))
        if (await nudge.players.isAdmin(player.id, context)) admins.push(player.id);
      print(admins);
    },
    async (server) => {
      if (options.player !== undefined)
        await server.call<AdminPlayer>(
          "PUT",
          `/admin/players/${encodeURIComponent(options.player)}/admin`,
          { admin: !options.remove },
        );
      const { players } = await server.call<PlayersResponse>("GET", "/admin/players");
      print(players.filter((player) => player.admin).map((player) => player.id));
    },
  );
}

/** Prints a new token for an existing player, once; their other tokens keep working. */
export async function token(
  options: AdminOptions & ServerAccess & { readonly player: string },
): Promise<void> {
  const print = (issued: PairResponse) => {
    console.log(
      `New token for ${issued.player.displayName} (client ${issued.clientId}), shown only now:\n`,
    );
    console.log(`  ${issued.token}\n`);
    console.log(`In a browser: ${new URL("/login", options.server).href}#token=${issued.token}`);
    console.log(`Revoke it with: nudge revoke ${issued.clientId}`);
  };
  await withAssistantOrServer(
    options,
    async (nudge) => {
      await knownPlayer(nudge, options.player);
      const issued = await nudge.players.issueToken(options.player, context);
      print({ token: issued.token, clientId: issued.clientId, player: issued.player });
    },
    async (server) =>
      print(await server.call<PairResponse>("POST", "/admin/tokens", { playerId: options.player })),
  );
}

/** Lists the tokens of one player, or of everyone, by client id and when they were issued. */
export async function tokens(
  options: AdminOptions & ServerAccess & { readonly player?: string },
): Promise<void> {
  const print = (records: readonly TokenInfo[]) => {
    if (records.length === 0) console.log("No tokens.");
    for (const record of records) {
      const client =
        record.client === undefined ? "" : `\t${record.client.name} (${record.client.platform})`;
      console.log(
        `${record.playerId}\t${record.clientId}\t${new Date(record.createdAt).toISOString()}${client}`,
      );
    }
  };
  await withAssistantOrServer(
    options,
    async (nudge) => {
      if (options.player !== undefined) await knownPlayer(nudge, options.player);
      print(await nudge.players.tokens(options.player, context));
    },
    async (server) => {
      const query =
        options.player === undefined ? "" : `?player=${encodeURIComponent(options.player)}`;
      print((await server.call<TokensResponse>("GET", `/admin/tokens${query}`)).tokens);
    },
  );
}

/** Stops one client's token from signing in; through the server, its open sockets close too. */
export async function revoke(
  options: AdminOptions & ServerAccess & { readonly clientId: string },
): Promise<void> {
  await withAssistantOrServer(
    options,
    async (nudge) => {
      const known = await nudge.players.tokens(undefined, context);
      if (!known.some((record) => record.clientId === options.clientId))
        throw new UsageError(`No token for client "${options.clientId}"; see nudge tokens`);
      const record = await nudge.players.revoke(options.clientId, context);
      console.log(`Revoked ${record.playerId}'s token for client ${record.clientId}.`);
    },
    async (server) => {
      await server.call("DELETE", `/admin/tokens/${encodeURIComponent(options.clientId)}`);
      console.log(`Revoked the token for client ${options.clientId}.`);
    },
  );
}

async function knownPlayer(nudge: Nudge, id: string): Promise<void> {
  if ((await nudge.players.get(id, context)) !== undefined) return;
  const ids = (await nudge.players.list(context)).map((player) => player.id);
  throw new UsageError(`No player "${id}"; players: ${ids.join(", ") || "none"}`);
}

/** Creates a shared room, or lists the rooms without a name. */
export async function room(
  options: AdminOptions &
    ServerAccess & { readonly name?: string; readonly members: readonly string[] },
): Promise<void> {
  const printRooms = (rooms: readonly Room[]) => {
    for (const room of rooms)
      console.log(
        `${room.id}\t${room.kind}\t${room.name}\t${room.members.map((p) => p.id).join(", ")}`,
      );
  };
  const printCreated = (room: Room) =>
    console.log(`Created room "${room.id}" for ${room.members.map((p) => p.id).join(", ")}.`);
  await withAssistantOrServer(
    options,
    async (nudge) => {
      if (options.name === undefined) {
        const players = new Map((await nudge.players.list(context)).map((p) => [p.id, p]));
        printRooms(
          (await nudge.rooms.list(context)).map((room) => toRoom(room, (id) => players.get(id))),
        );
        return;
      }
      const created = await nudge.rooms.createShared(
        { name: options.name, members: options.members },
        context,
      );
      const players = new Map((await nudge.players.list(context)).map((p) => [p.id, p]));
      printCreated(toRoom(created, (id) => players.get(id)));
    },
    async (server) => {
      if (options.name === undefined) {
        printRooms((await server.call<RoomsResponse>("GET", "/admin/rooms")).rooms);
        return;
      }
      printCreated(
        await server.call<Room>("POST", "/admin/rooms", {
          name: options.name,
          members: options.members,
        }),
      );
    },
  );
}

/** Gives a room a new name; its id stays. */
export async function renameRoom(
  options: AdminOptions & ServerAccess & { readonly room: string; readonly name: string },
): Promise<void> {
  const print = (room: Pick<Room, "id" | "name">) =>
    console.log(`Room "${room.id}" is now called ${room.name}.`);
  await withAssistantOrServer(
    options,
    async (nudge) => print(await nudge.renameRoom(options.room, options.name, context)),
    async (server) =>
      print(
        await server.call<Room>("PATCH", `/rooms/${encodeURIComponent(options.room)}`, {
          name: options.name,
        }),
      ),
  );
}

/** Lists every pending nudge, with its room. */
export async function nudges(options: AdminOptions & ServerAccess): Promise<void> {
  const print = (pending: readonly HomeNudge[]) => {
    if (pending.length === 0) console.log("No nudges scheduled.");
    for (const scheduled of pending)
      console.log(`${scheduled.roomId}\t${describeNudge(scheduled)}`);
  };
  await withAssistantOrServer(
    options,
    // On the host as the server shows an admin: values shown, others' private nudges blank.
    async (nudge) =>
      print(
        (await nudge.nudges.list(context)).map((scheduled) => {
          const shown = toHomeNudge(scheduled);
          return shown.privateTo === undefined
            ? { ...shown, message: nudge.showTo(undefined, shown.message) }
            : { ...shown, message: "" };
        }),
      ),
    async (server) => print((await server.call<NudgesResponse>("GET", "/admin/nudges")).nudges),
  );
}

export async function usage(options: AdminOptions & ServerAccess): Promise<void> {
  const money = (amount: number) => `$${amount.toFixed(2)}`;
  const print = (report: Omit<UsageResponse, "mine">) => {
    const { monthlyUsd, perPlayerUsd } = report.budget;
    console.log(
      `Budget: ${monthlyUsd === undefined ? "none" : `${money(monthlyUsd)} a month`}` +
        (perPlayerUsd === undefined ? "" : `, ${money(perPlayerUsd)} per player`),
    );
    const months = report.months ?? [];
    if (months.length === 0) console.log(`${report.month}\t${money(report.total)}`);
    for (const month of months) {
      console.log(`${month.month}\t${money(month.total)}`);
      const rows = [
        ...Object.entries(month.players).map(([id, amount]) => [`player ${id}`, amount] as const),
        ...Object.entries(month.rooms).map(([id, amount]) => [`room ${id}`, amount] as const),
      ].sort(([, a], [, b]) => b - a);
      for (const [name, amount] of rows) console.log(`  ${name}\t${money(amount)}`);
    }
  };
  await withAssistantOrServer(
    options,
    async (nudge) => {
      const { month, spend, budget } = nudge.spending.thisMonth();
      print({
        month,
        total: spend.total,
        budget,
        months: nudge.spending.months().map(({ month, spend }) => ({
          month,
          total: spend.total,
          players: spend.players,
          rooms: spend.rooms,
        })),
      });
    },
    async (server) => print(await server.call<UsageResponse>("GET", "/usage")),
  );
}

/**
 * Asks the process that has each assistant open (`nudge serve`, or an in-process `nudge chat`) to
 * reinstall its extensions from the config. False when none is running.
 */
export async function reload(options: AdminOptions): Promise<boolean> {
  const config = await loadConfig(options.config);
  const assistants =
    options.assistant === undefined
      ? config.assistants
      : [findAssistant(config, options.assistant)];
  const signalled = new Set<number>();
  for (const assistant of assistants) {
    const lock = `${assistant.database}.lock`;
    const pid = Number((await readFile(lock, "utf8").catch(() => "")).trim());
    if (!Number.isInteger(pid) || pid <= 0) {
      console.log(`${assistant.name}: not running`);
      continue;
    }
    if (!signalled.has(pid)) {
      try {
        process.kill(pid, "SIGHUP");
      } catch (error) {
        console.log(`${assistant.name}: process ${pid} is gone (${(error as Error).message})`);
        continue;
      }
      signalled.add(pid);
    }
    console.log(`${assistant.name}: asked process ${pid} to reload; it prints the result`);
  }
  return signalled.size > 0;
}

async function withAssistant(
  options: AdminOptions,
  use: (nudge: Nudge, assistant: string) => Promise<void>,
): Promise<void> {
  const config = await loadConfig(options.config);
  const assistant = findAssistant(config, options.assistant);
  const nudge = await openAssistant(config, assistant, context);
  try {
    await use(nudge, assistant.name);
  } finally {
    await nudge.close(context);
  }
}

/** Opens the assistant's database, or goes through its server when another process has it open. */
export async function withAssistantOrServer(
  options: AdminOptions & ServerAccess,
  local: (nudge: Nudge, assistant: string) => Promise<void>,
  remote: (server: AdminServer) => Promise<void>,
): Promise<void> {
  try {
    await withAssistant(options, local);
  } catch (error) {
    if (!(error instanceof DatabaseInUse)) throw error;
    const config = await loadConfig(options.config);
    const assistant = findAssistant(config, options.assistant).name;
    if (options.token === undefined)
      throw new UsageError(
        `${assistant} is running in process ${error.pid}. To go through its server at ${options.server}, ` +
          "pass an admin's token with --token or $NUDGE_TOKEN (and --url if it listens elsewhere).",
      );
    await remote(new AdminServer(new URL(options.server).origin, assistant, options.token));
  }
}

/** Protocol v1's HTTP API of one assistant, as an admin. */
export class AdminServer {
  constructor(
    readonly origin: string,
    readonly assistant: string,
    readonly token: string,
  ) {}

  async call<T = undefined>(method: string, path: string, body?: unknown): Promise<T> {
    const url = `${this.origin}/v1/a/${encodeURIComponent(this.assistant)}${path}`;
    let response: Response;
    try {
      response = await fetch(url, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          ...(body === undefined ? {} : { "content-type": "application/json" }),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    } catch (error) {
      throw new UsageError(`Could not reach ${this.origin}: ${(error as Error).message}`);
    }
    const text = await response.text();
    if (!response.ok) {
      let message = text;
      try {
        message = (JSON.parse(text) as ErrorResponse).error;
      } catch {
        // Not one of ours; show what came back.
      }
      throw new UsageError(`${this.origin} said ${response.status}: ${message}`);
    }
    return (text === "" ? undefined : JSON.parse(text)) as T;
  }
}
