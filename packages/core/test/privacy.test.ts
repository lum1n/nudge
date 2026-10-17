import { mkdtemp, readFile, rm } from "node:fs/promises";
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
import { builtinDetectors, createNudge, LOBBY, type NudgeOptions, Vault } from "../src/index.ts";
import { openRawDatabase } from "../src/encrypted-storage.ts";
import { MemoryDoc } from "../src/memory/memory.ts";
import { redactHistory } from "../src/privacy/redact-history.ts";
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

  it("shows a value its owner made private to them alone, and forgets it for good", () => {
    const vault = new Vault();
    expect(vault.redact(`Mail ${EMAIL}`, builtinDetectors)).toBe("Mail ⟦EMAIL1⟧");
    // Private from now on, also where it was shown before: owned values hide written out, too.
    vault.protect(EMAIL, "EMAIL", "ann");
    vault.protect("Storgata 5", "PRIVATE", "bo");
    const text = `Mail ⟦EMAIL1⟧ at ${EMAIL}, meet at Storgata 5`;
    expect(vault.showTo("ann", text)).toBe(`Mail ${EMAIL} at ${EMAIL}, meet at ⟦PRIVATE1⟧`);
    expect(vault.showTo("bo", text)).toBe("Mail ⟦EMAIL1⟧ at ⟦EMAIL1⟧, meet at Storgata 5");
    expect(vault.showTo(undefined, text)).toBe("Mail ⟦EMAIL1⟧ at ⟦EMAIL1⟧, meet at ⟦PRIVATE1⟧");
    // Nobody can take a value someone else owns.
    vault.protect(EMAIL, "EMAIL", "bo");
    expect(vault.get("⟦EMAIL1⟧")?.owner).toBe("ann");
    // A value first seen with an owner gets it; one seen before keeps none.
    vault.redact(`${PHONE} and ${EMAIL}`, builtinDetectors, "bo");
    expect(vault.get("⟦PHONE1⟧")?.owner).toBe("bo");

    const before = vault.version;
    expect(vault.forget("⟦EMAIL1⟧")).toBe(true);
    expect(vault.version).toBeGreaterThan(before);
    expect(vault.forget("⟦EMAIL1⟧")).toBe(false);
    expect(vault.rehydrate("⟦EMAIL1⟧")).toBe("⟦EMAIL1⟧");
    expect(vault.showTo("ann", "⟦EMAIL1⟧")).toBe("⟦EMAIL1⟧");
    // Its number is never given to another value, and saved entries keep the tombstone.
    expect(vault.redact("Mail other@example.no", builtinDetectors)).toBe("Mail ⟦EMAIL2⟧");
    const saved = vault.takeUnsaved();
    expect(saved).toContainEqual({
      value: "",
      kind: "EMAIL",
      placeholder: "⟦EMAIL1⟧",
      owner: "ann",
      forgotten: true,
    });
    const reopened = new Vault(vault.entries);
    expect(reopened.rehydrate("⟦EMAIL1⟧ ⟦EMAIL2⟧")).toBe("⟦EMAIL1⟧ other@example.no");
    expect(reopened.redact(EMAIL, builtinDetectors)).toBe("⟦EMAIL3⟧");
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
      LOBBY,
      { text: `Find ${EMAIL}. My IBAN is ${IBAN}, card ${CARD}, fnr ${FNR}.`, author },
      context,
    );
    const settled = await submission.wait(context);
    expect(settled.status).toBe("done");
    if (settled.status !== "done" || settled.type !== "input") throw new Error("unanswered");

    const lobby = await withTool.conversation(LOBBY, context);
    const answer = await lobby.commit((tx) => tx.entry(AssistantEntry, settled.answer), context);
    const answerText = JSON.stringify(answer?.model);
    // Stored as the model wrote it; people get the values back where they see it.
    expect(answerText).toContain("⟦NAME2⟧, I found ⟦NAME1⟧ at ⟦PHONE1⟧. Your IBAN is ⟦IBAN1⟧.");
    expect(
      withTool.showTo("p1", "⟦NAME2⟧, I found ⟦NAME1⟧ at ⟦PHONE1⟧. Your IBAN is ⟦IBAN1⟧."),
    ).toBe(`Vegard, I found Kari at ${PHONE}. Your IBAN is ${IBAN}.`);
    // The tool acted on the value, and what it returned was stored without it.
    expect(seenByTool).toEqual([EMAIL]);
    const stored = JSON.stringify((await lobby.entries({}, 100, undefined, context)).items);
    for (const secret of SECRETS) expect(stored).not.toContain(secret);
    expect(stored).toContain("Found ⟦NAME1⟧ at ⟦EMAIL1⟧, phone ⟦PHONE1⟧");

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

  it("rewrites history from before placeholders were stored, and vacuums it out of the file", async () => {
    const { faux, options } = setup();
    faux.setResponses([fauxAssistantMessage("Noted, ⟦EMAIL1⟧.")]);
    const first = await createNudge(options, context);
    const author = { playerId: "p1", displayName: "Vegard" };
    await (await first.submit(LOBBY, { text: `Mail ${EMAIL}`, author }, context)).wait(context);
    await first.memory.remember(LOBBY, "placeholder", context);
    await first.close(context);
    // As an older Nudge stored it: the values written out.
    const raw = await openRawDatabase(options.database);
    for (const row of raw.all("SELECT id, record FROM entries") as { id: number; record: string }[])
      raw.run(
        "UPDATE entries SET record = ? WHERE id = ?",
        row.record.replaceAll("⟦EMAIL1⟧", EMAIL),
        row.id,
      );
    raw.close();
    const old = await createNudge(options, context);
    await old.harness.commit(async (tx) => {
      (await tx.doc(MemoryDoc, LOBBY, null)).facts[0]!.text = `Vegard is at ${PHONE}`;
    }, context);
    await old.close(context);

    expect(await redactHistory(options, createNudge, context)).toEqual({
      entries: expect.any(Number),
      documents: 1,
    });
    // The vault is the one place the values stay.
    const check = await openRawDatabase(options.database);
    const rows = JSON.stringify(check.all("SELECT record FROM entries"));
    check.close();
    expect(rows).not.toContain(EMAIL);
    expect(rows).toContain("⟦EMAIL1⟧");
    const reopened = await createNudge(options, context);
    expect((await reopened.memory.list(LOBBY, context))[0]!.text).toBe("⟦NAME1⟧ is at ⟦PHONE1⟧");
    expect(reopened.showTo("p1", "⟦NAME1⟧ is at ⟦PHONE1⟧")).toBe(`Vegard is at ${PHONE}`);
    // Forgetting a value now takes it out of every copy.
    await reopened.forgetValue("⟦EMAIL1⟧");
    await reopened.close(context);
    const after = (await readFile(options.database)).toString("latin1");
    const wal = await readFile(`${options.database}-wal`).then(
      (b) => b.toString("latin1"),
      () => "",
    );
    expect(after + wal).not.toContain(EMAIL);
  });

  it("keeps placeholders across a restart", async () => {
    const { faux, options } = setup();
    faux.setResponses([fauxAssistantMessage("ok"), fauxAssistantMessage("ok")]);
    const first = await createNudge(options, context);
    expect(await first.protect("Oslo Gate 1", "ADDRESS")).toBe("⟦ADDRESS1⟧");
    expect(first.redact(`mail ${EMAIL}`)).toBe("mail ⟦EMAIL1⟧");
    await (await first.submit(LOBBY, { text: "hi" }, context)).wait(context);
    await first.close(context);

    const second = await createNudge(options, context);
    expect(second.redact(`${EMAIL} lives at Oslo Gate 1`)).toBe("⟦EMAIL1⟧ lives at ⟦ADDRESS1⟧");
    await second.close(context);
  });

  it("streams placeholders whole, even when a chunk splits one", async () => {
    const { faux, options } = setup();
    faux.setResponses([fauxAssistantMessage("Dear ⟦NAME1⟧, your mail ⟦EMAIL1⟧ is set.")]);
    const nudge = await createNudge(
      { ...options, settings: { progress: { partialIntervalMs: 1 } } },
      context,
    );
    const stream = await nudge.attach(LOBBY, context);
    const partials: string[] = [];
    stream.start(async (events) => {
      for (const event of events) {
        // Chunks that came close together may arrive with the message's or the block's start.
        if (event.type === "message_start" && event.message.role === "assistant")
          for (const block of event.message.content)
            if (block.type === "text") partials.push(block.text);
        if (event.type === "message_update") {
          for (const change of event.changes)
            if (change.type === "text_delta") partials.push(change.delta);
            else if (change.type === "text_start" && change.block.type === "text")
              partials.push(change.block.text);
        }
      }
    });
    await nudge.protect(EMAIL, "EMAIL");
    const author = { playerId: "p1", displayName: "Vegard" };
    await (await nudge.submit(LOBBY, { text: "status?", author }, context)).wait(context);
    await nudge.harness.waitForIdle(context);
    await stream.stop();
    // Viewers fill the values in, so a placeholder never arrives in pieces.
    let shown = "";
    for (const delta of partials) {
      shown += delta;
      expect(shown.lastIndexOf("⟦")).toBeLessThanOrEqual(shown.lastIndexOf("⟧"));
    }
    // A fast answer may come whole, without deltas, and the last words only with the finished
    // message; what streamed is a start of it either way.
    const answer = "Dear ⟦NAME1⟧, your mail ⟦EMAIL1⟧ is set.";
    expect(answer.startsWith(shown)).toBe(true);
    expect(nudge.showTo("p1", answer)).toBe(`Dear Vegard, your mail ${EMAIL} is set.`);
    await nudge.close(context);
  });
});
