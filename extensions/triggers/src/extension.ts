import type { Context } from "@earendil-works/chord";
import {
  currentTurn,
  defineNudgeExtension,
  defineTool,
  type ExtensionRoute,
  FIRE_ENTRY,
  type FireEntryData,
  keepsPlaceholders,
  type Owner,
  roomOf,
  section,
  Type,
} from "@nudge/core";
import { deliveryOf, firePrompt, readEvent } from "./event.ts";
import {
  admit,
  findBySecret,
  hashOf,
  newSecret,
  SECRETS_SCOPE,
  type Trigger,
  TriggersDoc,
} from "./model.ts";

const VERSION = "0.1.0";
const NAME = "triggers";

const Settings = Type.Object({
  url: Type.Optional(
    Type.String({
      pattern: "^https?://",
      description:
        "The address the senders reach this server at, such as http://192.168.1.10:8080 for " +
        "Home Assistant at home or https://robin.example for GitHub. Without it the assistant " +
        "gives the part that goes after it.",
    }),
  ),
  maxPerRoom: Type.Number({
    default: 10,
    minimum: 1,
    description: "Most triggers one room may have.",
  }),
  maxPerHour: Type.Number({
    default: 12,
    minimum: 1,
    description:
      "Most calls an hour one trigger answers; each is a paid model run. Calls past it are refused.",
  }),
  maxChars: Type.Number({
    default: 8000,
    minimum: 200,
    description: "Most characters of a call the model reads; the rest is cut.",
  }),
});

/** Most bytes a call may send; big GitHub payloads fit, and the model reads only `maxChars`. */
const MAX_BODY = 1024 * 1024;

/** Who a trigger added now is private to, if the turn is private. */
function privately(): { privateTo?: Owner } {
  const { privateTo } = currentTurn();
  return privateTo === undefined ? {} : { privateTo: { ...privateTo } };
}

/** A private trigger exists only in its owner's private turns. */
function visible(trigger: Trigger): boolean {
  return (
    trigger.privateTo === undefined ||
    trigger.privateTo.playerId === currentTurn().privateTo?.playerId
  );
}

export const triggersExtension = defineNudgeExtension({
  name: NAME,
  version: VERSION,
  description:
    "Triggers: a secret web address per room that lets outside events, such as Home Assistant or GitHub, start a turn.",
  settings: Settings,
  setup: (host) => {
    const { url, maxPerRoom, maxPerHour, maxChars } = host.settings;

    const text = (value: string, isError = false) => ({
      output: [{ type: "text" as const, text: value }],
      ...(isError ? { isError } : {}),
    });

    /**
     * The trigger's address as a placeholder: the model never sees the secret, and only whoever
     * asked for the trigger sees it in the room.
     */
    const address = async (trigger: Trigger): Promise<string | undefined> => {
      const secret = host.secrets.get(SECRETS_SCOPE, trigger.id);
      if (secret === undefined) return undefined;
      const path = `/v1/a/${host.name}/ext/${NAME}/hook/${secret}`;
      return host
        .assistant()
        .protect(
          `${(url ?? "").replace(/\/+$/, "")}${path}`,
          "WEBHOOK",
          trigger.createdBy === undefined ? {} : { owner: trigger.createdBy.playerId },
        );
    };

    const describe = (trigger: Trigger) =>
      `${trigger.id} "${trigger.name}": ${trigger.instructions} (` +
      (trigger.fired === 0 ? "not called yet" : `called ${trigger.fired} times`) +
      (trigger.dropped === 0 ? "" : `, ${trigger.dropped} calls refused for coming too often`) +
      ")";

    const add = defineTool({
      name: "add_trigger",
      description:
        "Make a trigger for this conversation: a secret web address that outside services, such " +
        "as Home Assistant, Uptime Kuma, GitHub, Paperless or a phone Shortcut, call when " +
        "something happens. Each call makes you act on it here as the instructions say.",
      parameters: Type.Object({
        name: Type.String({ description: 'A short name, such as "Washing machine".' }),
        instructions: Type.String({
          description:
            "What to do when it is called, with every detail you will need then, such as " +
            '"Tell Ann the washing machine is done" or "Sum up the failed GitHub build".',
        }),
      }),
      execute: async (args, api, context) => {
        const name = args.name.trim();
        const instructions = args.instructions.trim();
        if (name === "" || instructions === "")
          return text("Give the trigger a name and say what to do when it is called.", true);
        const room = await roomOf(api, api.conversationId, context);
        const secret = newSecret();
        const { by } = currentTurn();
        const trigger = await api.commit(async (tx) => {
          const state = await tx.doc(TriggersDoc);
          if (state.items.filter((item) => item.roomId === room.id).length >= maxPerRoom)
            throw new Error(`This conversation has ${maxPerRoom} triggers already`);
          const trigger: Trigger = {
            id: `t${state.next}`,
            roomId: room.id,
            name,
            instructions,
            hash: hashOf(secret),
            createdAt: host.now(),
            ...(by === undefined ? {} : { createdBy: { ...by } }),
            ...privately(),
            fired: 0,
            dropped: 0,
            recent: [],
          };
          state.next += 1;
          state.items.push(structuredClone(trigger));
          return trigger;
        }, context);
        host.secrets.set(SECRETS_SCOPE, trigger.id, secret);
        const where = (await address(trigger))!;
        return text(
          [
            `Added trigger ${describe(trigger)}.`,
            `Its address is ${where}. Give it exactly like that: only the person who asked sees ` +
              "the real address, and you never do.",
            url === undefined
              ? "It is the part after the server's address (its https:// or local http:// " +
                "address): tell them to put that in front."
              : "",
            "The sender POSTs to it; a JSON, form or text body and any query parameters come " +
              "along, as in curl -X POST -d 'Washer done' <address>. Anyone with the address can " +
              "call it, so they should keep it secret; remove_trigger turns it off.",
          ]
            .filter((line) => line !== "")
            .join("\n"),
        );
      },
    });

    const list = defineTool({
      name: "list_triggers",
      description: "List this conversation's triggers with their addresses.",
      parameters: Type.Object({}),
      replay: "safe",
      execute: async (_args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const items = ((await api.snapshot(TriggersDoc, context))?.items ?? []).filter(
          (item) => item.roomId === room.id && visible(item),
        );
        if (items.length === 0) return text("No triggers.");
        const lines = await Promise.all(
          items.map(async (item) => {
            const where = await address(item);
            return `${describe(item)} at ${where ?? "an address that is lost; remove and add it again"}`;
          }),
        );
        return text(lines.join("\n"));
      },
    });

    const remove = defineTool({
      name: "remove_trigger",
      description: "Turn off and remove one of this conversation's triggers by its id.",
      parameters: Type.Object({ id: Type.String({ description: "From list_triggers." }) }),
      replay: "safe",
      execute: async (args, api, context) => {
        const room = await roomOf(api, api.conversationId, context);
        const removed = await api.commit(async (tx) => {
          const state = await tx.doc(TriggersDoc);
          const found = state.items.find((item) => item.id === args.id);
          if (found === undefined || found.roomId !== room.id || !visible(found)) return undefined;
          // Through JSON: the document's objects don't clone.
          const removed = JSON.parse(JSON.stringify(found)) as Trigger;
          state.items = state.items.filter((item) => item.id !== args.id);
          return removed;
        }, context);
        if (removed === undefined) return text(`No trigger ${args.id} in this conversation.`, true);
        host.secrets.delete(SECRETS_SCOPE, removed.id);
        return text(`Removed trigger ${describe(removed)}. Its address no longer works.`);
      },
    });

    const hook: ExtensionRoute = {
      method: "POST",
      path: "/hook/:secret",
      auth: "none",
      maxBodyBytes: MAX_BODY,
      handle: (request, { params, context }) =>
        fire(request, params.secret ?? "", context).catch((error: unknown) => {
          console.error(error);
          return Response.json({ error: "The trigger failed" }, { status: 500 });
        }),
    };

    const fire = async (request: Request, secret: string, context: Context) => {
      const nudge = host.assistant();
      const documents = host.documents();
      // The same answer for a wrong secret, a removed trigger and one turned off in its room.
      const notFound = Response.json({ error: "Not found" }, { status: 404 });
      const trigger = findBySecret(
        (await documents.snapshot(TriggersDoc, context))?.items ?? [],
        secret,
      );
      if (trigger === undefined || !(await nudge.extensionEnabled(trigger.roomId, NAME, context)))
        return notFound;
      const event = await readEvent(request, maxChars);

      const now = host.now();
      const taken = await documents.commit(async (tx) => {
        const item = (await tx.doc(TriggersDoc)).items.find((i) => i.id === trigger.id);
        if (item === undefined) return undefined;
        const admitted = admit(item.recent, now, maxPerHour);
        if ("retryAt" in admitted) {
          item.dropped += 1;
          return admitted;
        }
        item.recent = admitted.recent;
        item.fired += 1;
        item.lastFiredAt = now;
        return { count: item.fired };
      }, context);
      if (taken === undefined) return notFound;
      if ("retryAt" in taken)
        return Response.json(
          { error: `Called more than ${maxPerHour} times in the last hour` },
          {
            status: 429,
            headers: {
              "retry-after": String(Math.max(1, Math.ceil((taken.retryAt - now) / 1000))),
            },
          },
        );

      const conversation = await nudge.conversation(trigger.roomId, context);
      // A sender's retry of one delivery finds this submission instead of adding another.
      await conversation.submit(
        {
          type: "input",
          content: firePrompt(trigger, event),
          whenBusy: "followUp",
          requestId: `trigger:${trigger.id}:${deliveryOf(request) ?? taken.count}`,
          entry: {
            kind: FIRE_ENTRY,
            data: {
              nudgeId: `trigger-${trigger.id}`,
              message: `Trigger ${trigger.id}: ${trigger.name}`,
              fireAt: now,
              // Shown like a watch's news: something outside started it, not a schedule.
              source: "watch",
              ...(trigger.privateTo === undefined ? {} : { privateTo: trigger.privateTo }),
            } satisfies FireEntryData,
          },
        },
        context,
      );
      return Response.json({ accepted: true }, { status: 202 });
    };

    return {
      // Instructions are kept as the model wrote them, with placeholders.
      tools: [keepsPlaceholders(add), list, remove],
      routes: [hook],
      sections: [
        section("triggers", async (input, context) => {
          const room = await roomOf(input.read, input.conversationId, context).catch(
            () => undefined,
          );
          if (room === undefined) return undefined;
          const items = ((await input.read.snapshot(TriggersDoc, context))?.items ?? []).filter(
            (item) => item.roomId === room.id,
          );
          if (items.length === 0) return undefined;
          return (
            "Triggers of this conversation, web addresses outside services call " +
            "(list_triggers has their addresses):\n" +
            items.map((item) => `- ${item.id} "${item.name}": ${item.instructions}`).join("\n")
          );
        }),
      ],
    };
  },
});

export default triggersExtension;
