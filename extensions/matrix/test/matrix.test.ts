import { BACKGROUND_CONTEXT, createNudge, type ModelContext, type Nudge } from "@nudge/core";
import { createModels, fauxAssistantMessage, fauxProvider, fauxText } from "@nudge/core/testing";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { matrixExtension, type SyncResponse } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const BOT = "@nudge:hs.example";

/** A homeserver as the bridge uses it, in memory. */
class FakeHomeserver {
  private batch = 0;
  private pending: { roomId: string; sender: string; body: string; members: number }[] = [];
  private invites: string[] = [];
  private wake: (() => void) | undefined;
  readonly sent: { roomId: string; body: string }[] = [];
  readonly joined: string[] = [];
  firstSince: string | null | undefined;
  authorization: string | undefined;

  message(roomId: string, sender: string, body: string, members = 2) {
    this.pending.push({ roomId, sender, body, members });
    this.wake?.();
  }

  invite(roomId: string) {
    this.invites.push(roomId);
    this.wake?.();
  }

  readonly fetch: typeof fetch = async (input, init) => {
    const url = new URL(String(input));
    this.authorization = new Headers(init?.headers).get("authorization") ?? undefined;
    const path = url.pathname.replace("/_matrix/client/v3", "");
    const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });
    if (path === "/account/whoami") return json({ user_id: BOT });
    if (path === "/sync") {
      const since = url.searchParams.get("since");
      if (this.firstSince === undefined) this.firstSince = since;
      if (since === null) return json({ next_batch: `b${++this.batch}` } satisfies SyncResponse);
      if (this.pending.length === 0 && this.invites.length === 0)
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, 50);
          this.wake = () => {
            clearTimeout(timer);
            resolve();
          };
          init?.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
      this.wake = undefined;
      const join: NonNullable<NonNullable<SyncResponse["rooms"]>["join"]> = {};
      for (const [n, m] of this.pending.entries())
        (join[m.roomId] ??= {
          summary: { "m.joined_member_count": m.members },
          timeline: { events: [] },
        }).timeline!.events!.push({
          type: "m.room.message",
          event_id: `$e${this.batch}-${n}`,
          sender: m.sender,
          content: { msgtype: "m.text", body: m.body },
        });
      const invite = Object.fromEntries(this.invites.map((id) => [id, {}]));
      this.pending = [];
      this.invites = [];
      return json({
        next_batch: `b${++this.batch}`,
        rooms: { join, invite },
      } satisfies SyncResponse);
    }
    const join = /^\/rooms\/([^/]+)\/join$/.exec(path);
    if (join !== null) {
      this.joined.push(decodeURIComponent(join[1]!));
      return json({ room_id: decodeURIComponent(join[1]!) });
    }
    const send = /^\/rooms\/([^/]+)\/send\/m\.room\.message\/\w+$/.exec(path);
    if (send !== null) {
      const body = JSON.parse(String(init!.body)) as { body: string };
      this.sent.push({ roomId: decodeURIComponent(send[1]!), body: body.body });
      // The bot's own message comes back in the next sync; the bridge must not read it as input.
      this.pending.push({
        roomId: decodeURIComponent(send[1]!),
        sender: BOT,
        body: body.body,
        members: 2,
      });
      return json({ event_id: `$s${this.sent.length}` });
    }
    return json({ errcode: "M_UNRECOGNIZED", error: "Unrecognized request" }, 404);
  };

  to(roomId: string): string[] {
    return this.sent.filter((s) => s.roomId === roomId).map((s) => s.body);
  }
}

async function until(check: () => boolean, timeout = 5_000): Promise<void> {
  const end = Date.now() + timeout;
  while (!check()) {
    if (Date.now() > end) throw new Error("Timed out");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("matrix bridge", () => {
  let homeserver: FakeHomeserver;
  let nudge: Nudge;

  beforeEach(async () => {
    process.env.TEST_MATRIX_TOKEN = "syt_secret";
    homeserver = new FakeHomeserver();
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const lastUser = (request: ModelContext) => {
      const message = request.messages.findLast((m) => m.role === "user");
      return typeof message?.content === "string"
        ? message.content
        : (message?.content ?? []).map((part) => (part.type === "text" ? part.text : "")).join("");
    };
    faux.setResponses(
      Array.from(
        { length: 20 },
        () => (request: ModelContext) =>
          fauxAssistantMessage([fauxText(`Answer to ${lastUser(request)}`)]),
      ),
    );
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: matrixExtension({ fetch: homeserver.fetch, report: () => {} }),
            settings: {
              homeserver: "https://hs.example",
              token: "${TEST_MATRIX_TOKEN}",
              pollSeconds: 1,
            },
          },
        ],
      },
      context,
    );
    await nudge.players.invite("Ann", context);
  });

  afterEach(async () => {
    await nudge.close(context);
    delete process.env.TEST_MATRIX_TOKEN;
  });

  it("joins when invited, links, and answers without reading its own messages", async () => {
    await until(() => homeserver.firstSince !== undefined);
    // The first sync only finds where now is.
    expect(homeserver.firstSince).toBeNull();
    expect(homeserver.authorization).toBe("Bearer syt_secret");

    homeserver.invite("!dm:hs.example");
    await until(() => homeserver.joined.length === 1);
    expect(homeserver.joined).toEqual(["!dm:hs.example"]);

    const { code } = await nudge.players.pairingCode("ann", context);
    homeserver.message("!dm:hs.example", "@ann:hs.example", `/link ${code}`);
    await until(() => homeserver.to("!dm:hs.example").length === 1);
    expect(homeserver.to("!dm:hs.example")[0]).toMatch(/^Linked to Ann\./);

    homeserver.message("!dm:hs.example", "@ann:hs.example", "Hi Nudge");
    await until(() => homeserver.to("!dm:hs.example").length === 2);
    expect(homeserver.to("!dm:hs.example")[1]).toMatch(/^Answer to Ann \(\d\d:\d\d\): Hi Nudge$/);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(homeserver.sent).toHaveLength(2);

    // In a room with more people, /link is refused: everyone would see the code.
    homeserver.message("!group:hs.example", "@bo:hs.example", "/link ABCD-1234", 5);
    await until(() => homeserver.to("!group:hs.example").length === 1);
    expect(homeserver.to("!group:hs.example")[0]).toBe("Send /link in a direct chat with me.");
  });
});
