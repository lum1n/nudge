import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Context as ModelContext, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { AssistantEntry, defineExtension, defineTool } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { builtinDetectors, createNudge, type NudgeOptions, Vault } from "../src/index.ts";
import { withoutPartialPlaceholder } from "../src/privacy/vault.ts";

const context = BACKGROUND_CONTEXT;

const EMAIL = "kari.nordmann@example.no";
const IBAN = "NO93 8601 1117 947";
const PHONE = "+47 912 34 567";
const CARD = "4111 1111 1111 1111";
const FNR = "15059012387"; // valid control digits
const SECRETS = [EMAIL, IBAN, PHONE, CARD, FNR, "Kari"];

describe("Vault", () => {
  it("finds the built-in kinds and gives each value one stable placeholder", () => {
    const vault = new Vault();
    const text = `Mail ${EMAIL}, IBAN ${IBAN}, call ${PHONE}, card ${CARD}, fnr ${FNR}.`;
    const redacted = vault.redact(text, builtinDetectors);
    expect(redacted).toBe(
      "Mail ⟦EMAIL1⟧, IBAN ⟦IBAN1⟧, call ⟦PHONE1⟧, card ⟦CARD1⟧, fnr ⟦NATIONALID1⟧.",
    );
    expect(vault.redact(`again ${EMAIL.toUpperCase()}`, builtinDetectors)).toBe("again ⟦EMAIL1⟧");
    expect(vault.redact(redacted, builtinDetectors)).toBe(redacted);
    expect(vault.rehydrate(redacted)).toBe(text);
  });

  it("leaves numbers that fail their checksums alone", () => {
    const vault = new Vault();
    const text = "Order 4111 1111 1111 1112, id 15059012388, total 12345678, year 2026.";
    expect(vault.redact(text, builtinDetectors)).toBe(text);
  });

  it("protects names as whole words only", () => {
    const vault = new Vault();
    vault.protect("Ann", "NAME");
    expect(vault.redact("Ann and ann went to Annecy for an anniversary.", builtinDetectors)).toBe(
      "⟦NAME1⟧ and ⟦NAME1⟧ went to Annecy for an anniversary.",
    );
  });

  it("numbers on from saved entries and leaves unknown placeholders alone", () => {
    const vault = new Vault([{ value: "Bo", kind: "NAME", placeholder: "⟦NAME4⟧" }]);
    expect(vault.protect("Eli", "NAME")).toBe("⟦NAME5⟧");
    expect(vault.rehydrate("⟦NAME4⟧, ⟦NAME5⟧ and ⟦NAME9⟧")).toBe("Bo, Eli and ⟦NAME9⟧");
  });

  it("holds back a placeholder cut off at the end of a stream", () => {
    expect(withoutPartialPlaceholder("Hello ⟦NA")).toBe("Hello ");
    expect(withoutPartialPlaceholder("Hello ⟦NAME1⟧")).toBe("Hello ⟦NAME1⟧");
    expect(withoutPartialPlaceholder("math ⟦ x")).toBe("math ⟦ x");
  });
});

describe("redaction in a running assistant", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-privacy-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(extra: Partial<NudgeOptions> = {}) {
    const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 1, max: 3 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const sent: string[] = [];
    const record = (request: ModelContext) => sent.push(JSON.stringify(request));
    const options: NudgeOptions = {
      database: join(dir, "a.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      ...extra,
    };
    return { faux, options, sent, record };
  }

  it("never sends a personal value: chat, tool round, and compaction", async () => {
    const seenByTool: unknown[] = [];
    const lookup = defineTool({
      name: "lookup_contact",
      description: "Look up a contact by email",
      parameters: Type.Object({ email: Type.String() }),
      execute: async (args) => {
        seenByTool.push(args.email);
        return { output: [{ type: "text", text: `Found Kari at ${args.email}, phone ${PHONE}` }] };
      },
    });
    const contacts = defineExtension({ name: "contacts", tools: [lookup] });
    const { faux, options, sent, record } = setup();
    faux.setResponses([
      (request) => {
        record(request);
        return fauxAssistantMessage(
          [fauxText("Looking up ⟦EMAIL1⟧."), fauxToolCall("lookup_contact", { email: "⟦EMAIL1⟧" })],
          {
            stopReason: "toolUse",
          },
        );
      },
      (request) => {
        record(request);
        return fauxAssistantMessage("⟦NAME2⟧, I found ⟦NAME1⟧ at ⟦PHONE1⟧. Your IBAN is ⟦IBAN1⟧.");
      },
      (request) => {
        record(request);
        return fauxAssistantMessage("Summary: ⟦NAME1⟧ asked about ⟦NAME2⟧ (⟦EMAIL1⟧).");
      },
    ]);
    const withTool = await createNudge(
      { ...options, extensions: [contacts], settings: { compaction: { keepRecentTokens: 1 } } },
      context,
    );
    await withTool.protect("Kari", "NAME");
    const author = { playerId: "p1", displayName: "Vegard", clientId: "c1" };
    const submission = await withTool.submit(
      withTool.lobbyId,
      { text: `Find ${EMAIL}. My IBAN is ${IBAN}, card ${CARD}, fnr ${FNR}.`, author },
      context,
    );
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("unanswered");

    const lobby = (await withTool.harness.conversation(withTool.lobbyId, context))!;
    const answer = await lobby.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const answerText = JSON.stringify(answer?.model);
    expect(answerText).toContain(`Vegard, I found Kari at ${PHONE}. Your IBAN is ${IBAN}.`);
    expect(seenByTool).toEqual([EMAIL]);

    const compaction = await lobby.compact(undefined, context);
    const compacted = await withTool.harness.waitForTask(compaction, context);
    expect(compacted.state.outcome).toMatchObject({ status: "completed" });
    await withTool.close(context);

    expect(sent).toHaveLength(3);
    for (const request of sent) {
      for (const secret of [...SECRETS, "Vegard"]) expect(request).not.toContain(secret);
    }
    expect(sent[1]).toContain("⟦PHONE1⟧");
  });

  it("keeps placeholders across a restart", async () => {
    const { faux, options } = setup();
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    const first = await createNudge(options, context);
    expect(await first.protect("Oslo Gate 1", "ADDRESS")).toBe("⟦ADDRESS1⟧");
    expect(first.redact(`mail ${EMAIL}`)).toBe("mail ⟦EMAIL1⟧");
    await (await first.submit(first.lobbyId, { text: "hi" }, context)).wait(context);
    await first.close(context);

    const second = await createNudge(options, context);
    expect(second.redact(`${EMAIL} lives at Oslo Gate 1`)).toBe("⟦EMAIL1⟧ lives at ⟦ADDRESS1⟧");
    await second.close(context);
  });

  it("streams values, not placeholders, even when a chunk splits one", async () => {
    const { faux, options } = setup();
    faux.setResponses([fauxAssistantMessage("Dear ⟦NAME1⟧, your mail ⟦EMAIL1⟧ is set.")]);
    const nudge = await createNudge(
      { ...options, settings: { progress: { partialIntervalMs: 1 } } },
      context,
    );
    const stream = await nudge.attach(nudge.lobbyId, context);
    const partials: string[] = [];
    stream.start(async (events) => {
      for (const event of events) {
        if (event.type === "message_update") {
          for (const change of event.changes)
            if (change.type === "text_delta") partials.push(change.delta);
        }
      }
    });
    await nudge.protect(EMAIL, "EMAIL");
    const author = { playerId: "p1", displayName: "Vegard" };
    await (await nudge.submit(nudge.lobbyId, { text: "status?", author }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    await stream.stop();
    await nudge.close(context);
    expect(partials.join("")).not.toContain("⟦");
  });
});
