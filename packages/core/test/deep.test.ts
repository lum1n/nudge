import { spawnSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { type Context as ModelContext, Type } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { defineTool } from "@earendil-works/pi-durable";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  builtinDetectors,
  createNudge,
  type DeepDetector,
  DeepScanner,
  DeepUnavailable,
  defineNudgeExtension,
  LOBBY,
  type NudgeOptions,
  pendingDeepDetector,
  piecesOf,
  textsToScan,
  Vault,
} from "../src/index.ts";
import { decode, encode, MAX_WIDTH, pack, splitWords, unpack } from "../src/privacy/deep/gliner.ts";
import { openLocalModel } from "../src/privacy/deep/local-model.ts";

const context = BACKGROUND_CONTEXT;

/** Finds the words it is given, as the local model would, and remembers what it read. */
function fakeModel(words: Readonly<Record<string, string>>) {
  const read: string[] = [];
  const detector: DeepDetector = {
    id: "fake",
    async find(texts) {
      read.push(...texts);
      return texts.map((text) =>
        Object.entries(words).flatMap(([word, kind]) => {
          const start = text.indexOf(word);
          return start === -1 ? [] : [{ start, end: start + word.length, kind, score: 0.9 }];
        }),
      );
    },
  };
  return { detector, read };
}

const missing: DeepDetector = {
  id: "missing",
  async find() {
    throw new DeepUnavailable("The local name finder is still downloading");
  },
};

describe("GLiNER inputs and outputs", () => {
  it("splits words and symbols where the Python package does", () => {
    expect(splitWords("Hei, Kari-Anne! Bor du i Sørumsand?").map((w) => w.text)).toEqual([
      "Hei",
      ",",
      "Kari-Anne",
      "!",
      "Bor",
      "du",
      "i",
      "Sørumsand",
      "?",
    ]);
    const [word] = splitWords("  Oslo S");
    expect(word).toEqual({ text: "Oslo", start: 2, end: 6 });
  });

  it("puts the labels first and marks each word's first token", () => {
    const tokens: Record<string, number[]> = {
      "<<ENT>>": [9],
      person: [10],
      "<<SEP>>": [11],
      Kari: [20, 21],
      bor: [22],
    };
    const inputs = encode(splitWords("Kari bor"), ["person"], (word) => tokens[word] ?? []);
    expect(inputs.inputIds).toEqual([1, 9, 10, 11, 20, 21, 22, 2]);
    expect(inputs.wordsMask).toEqual([0, 0, 0, 0, 1, 0, 2, 0]);
    expect(inputs.words).toBe(2);
    expect(inputs.spanMask).toHaveLength(2 * MAX_WIDTH);
    expect(inputs.spanIdx.slice(0, 4)).toEqual([0, 0, 0, 1]);
    // Spans past the text are masked and point at the start.
    expect(inputs.spanMask[MAX_WIDTH + 1]).toBe(false);
    expect(inputs.spanIdx.slice((MAX_WIDTH + 1) * 2, (MAX_WIDTH + 1) * 2 + 2)).toEqual([0, 0]);
  });

  it("decodes the best spans without overlaps, as characters", () => {
    const words = splitWords("Ring Kari Nordmann nå");
    const labels = ["person", "city"];
    const logits = new Float32Array(words.length * MAX_WIDTH * labels.length).fill(-10);
    const at = (start: number, width: number, label: number) =>
      (start * MAX_WIDTH + width) * labels.length + label;
    logits[at(1, 1, 0)] = 3; // "Kari Nordmann", person
    logits[at(1, 0, 0)] = 1; // "Kari", person: overlaps, lower
    logits[at(2, 0, 1)] = 0.5; // "Nordmann", city: overlaps, lower
    expect(decode(logits, words, words.length, labels, 0.5)).toEqual([
      { start: 5, end: 18, label: "person", score: expect.closeTo(0.953, 3) },
    ]);
  });

  it("reads short texts together, one per line, and gives each its own spans", () => {
    const texts = ["Ring Kari", "Hent Ola Nordmann", "Fire fem seks sju"];
    const packs = pack(texts, 5);
    expect(packs.map((p) => p.text)).toEqual(["Ring Kari\nHent Ola Nordmann", "Fire fem seks sju"]);
    const spans = [
      { start: 5, end: 9, label: "person", score: 0.9 }, // "Kari"
      { start: 5, end: 19, label: "person", score: 0.6 }, // "Kari\nHent Ola", over the line break
      { start: 15, end: 27, label: "person", score: 0.8 }, // "Ola Nordmann"
    ];
    expect(unpack(spans, packs[0]!, texts)).toEqual([
      [spans[0], { ...spans[1], end: 9 }],
      [
        { ...spans[1], start: 0, end: 9 },
        { ...spans[2], start: 5, end: 17 },
      ],
    ]);
  });
});

describe("DeepScanner", () => {
  it("reads lines with capitals once, in pieces of a few hundred words", () => {
    expect(piecesOf("Hei Kari\nbare små ord her\n⟦NAME1⟧ er her\n\nOk.")).toEqual([
      "Hei Kari",
      "Ok.",
    ]);
    const long = Array.from({ length: 450 }, (_, i) => `Ord${i}`).join(" ");
    expect(piecesOf(long).map((piece) => piece.split(" ").length)).toEqual([200, 200, 50]);
  });

  it("protects what the model finds, but not pronouns, words, big cities or allowed names", async () => {
    const { detector } = fakeModel({
      Vethjem: "ORG",
      "Skogkanten Barnehage": "ORG",
      Mamma: "NAME",
      borettslaget: "ORG",
      Oslo: "PLACE",
      Nudge: "NAME",
      "Priya and Daniel": "NAME",
      "Dr. Hansen": "NAME",
    });
    const vault = new Vault();
    const scanner = new DeepScanner({ detector, mode: "required", allow: ["Nudge"] });
    await scanner.protectIn(
      [
        "Mamma har time hos Vethjem, og Emma går i Skogkanten Barnehage.",
        "Nudge: møte i borettslaget i Oslo.",
        "We met Priya and Daniel at Dr. Hansen's.",
      ],
      vault,
    );
    expect(vault.entries.map(({ value, kind }) => `${kind} ${value}`)).toEqual([
      "ORG Vethjem",
      "ORG Skogkanten",
      "NAME Priya",
      "NAME Daniel",
      "NAME Hansen",
    ]);
  });

  it("protects given names typed in lower case, but not words", async () => {
    const { detector, read } = fakeModel({
      emma: "NAME",
      "hanne bø": "NAME",
      mamma: "NAME",
      per: "NAME",
    });
    const vault = new Vault();
    const scanner = new DeepScanner({ detector, mode: "required" });
    await scanner.protectIn(
      ["hent emma og mamma", "vipps hanne bø", "per dag", "ingen navn"],
      vault,
    );
    expect(read).toEqual(["hent emma og mamma", "vipps hanne bø"]);
    expect(vault.entries.map(({ value }) => value)).toEqual(["emma", "hanne bø", "hanne"]);
  });

  it("leaves well-known names readable, also at either end of a finding", async () => {
    const { detector } = fakeModel({
      "Rema 1000": "ORG",
      "Jonas Gahr Støre": "NAME",
      "IKEA Slependen": "ORG",
    });
    const vault = new Vault();
    const scanner = new DeepScanner({ detector, mode: "required" });
    await scanner.protectIn(["Rema 1000, Jonas Gahr Støre og IKEA Slependen."], vault);
    expect(vault.entries.map(({ value }) => value)).toEqual(["Slependen"]);
  });

  it("reads each piece once, also after a restart, and gives new values to the owner", async () => {
    const { detector, read } = fakeModel({ Vethjem: "ORG", Blaker: "PLACE" });
    const vault = new Vault();
    vault.protect("Blaker", "PLACE");
    const saved: string[] = [];
    const scanner = new DeepScanner({
      detector,
      mode: "required",
      save: async (_model, keys) => {
        saved.push(...keys);
      },
    });
    await scanner.protectIn(["Hos Vethjem på Blaker."], vault, { owner: "ann" });
    await scanner.protectIn(["Hos Vethjem på Blaker."], vault);
    expect(read).toEqual(["Hos Vethjem på Blaker."]);
    expect(vault.get("⟦ORG1⟧")).toMatchObject({ value: "Vethjem", owner: "ann" });
    expect(vault.get("⟦PLACE1⟧")?.owner).toBeUndefined();

    const again = new DeepScanner({
      detector,
      mode: "required",
      seen: { model: "fake", keys: saved },
    });
    await again.protectIn(["Hos Vethjem på Blaker."], vault);
    expect(read).toHaveLength(1);
    // Hashes of another model's reading count for nothing.
    const other = new DeepScanner({
      detector,
      mode: "required",
      seen: { model: "old", keys: saved },
    });
    await other.protectIn(["Hos Vethjem på Blaker."], vault);
    expect(read).toHaveLength(2);
  });

  it("refuses without the model when required, and goes on when preferred or quiet", async () => {
    const vault = new Vault();
    const required = new DeepScanner({ detector: missing, mode: "required" });
    await expect(required.protectIn(["Hos Vethjem."], vault)).rejects.toThrow(DeepUnavailable);
    await required.protectIn(["Hos Vethjem."], vault, { quiet: true });
    const reported: unknown[] = [];
    const preferred = new DeepScanner({
      detector: missing,
      mode: "preferred",
      report: (error) => reported.push(error),
    });
    await preferred.protectIn(["Hos Vethjem."], vault);
    expect(reported).toHaveLength(1);
  });

  it("reads what people wrote, tool results and data sections, not the model's own words", () => {
    const request: ModelContext = {
      messages: [
        {
          role: "system",
          content: "You are Nudge.",
          sections: { memory: "Emma går i Skogkanten.", extensions: "Search", time: "12:00" },
          timestamp: 0,
        },
        { role: "user", content: "Hos Vethjem?", timestamp: 0 },
        fauxAssistantMessage("Ser på Vethjem."),
        {
          role: "toolResult",
          toolCallId: "1",
          toolName: "read_mail",
          content: [{ type: "text", text: "Fra Kari" }],
          isError: false,
          timestamp: 0,
        },
        {
          role: "toolResult",
          toolCallId: "2",
          toolName: "web_search",
          content: [{ type: "text", text: "Restaurant Fyr" }],
          isError: false,
          timestamp: 0,
        },
      ],
    };
    expect(textsToScan(request, new Set(["web_search"]))).toEqual([
      "Emma går i Skogkanten.",
      "Hos Vethjem?",
      "Fra Kari",
    ]);
  });

  it("waits a little for a model that is loading, then says why it can't run", async () => {
    let finish: (detector: DeepDetector) => void = () => {};
    const loading = new Promise<DeepDetector>((resolve) => {
      finish = resolve;
    });
    const pending = pendingDeepDetector("fake", loading, 10);
    await expect(pending.find(["Kari"])).rejects.toThrow(/still downloading/);
    finish(fakeModel({ Kari: "NAME" }).detector);
    await expect(pending.find(["Kari"])).resolves.toHaveLength(1);
    const failed = pendingDeepDetector("fake", Promise.reject(new Error("no disk")), 10);
    await expect(failed.find(["Kari"])).rejects.toThrow(/could not start: no disk/);
  });
});

describe("the local model in a running assistant", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-deep-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  function setup(deep: DeepDetector, extra: Partial<NudgeOptions> = {}) {
    const faux = fauxProvider({ tokensPerSecond: 400, tokenSize: { min: 1, max: 3 } });
    const models = createModels();
    models.setProvider(faux.provider);
    const sent: string[] = [];
    const options: NudgeOptions = {
      database: join(dir, "a.sqlite"),
      models,
      model: { provider: faux.provider.id, modelId: faux.getModel().id },
      privacy: { deep, deepMode: "required" },
      ...extra,
    };
    return { faux, options, sent };
  }

  it("keeps what only the model finds out of every request, but not public results", async () => {
    const mail = defineTool({
      name: "read_mail",
      description: "Reads the newest mail",
      parameters: Type.Object({}),
      execute: async () => ({
        output: [{ type: "text", text: "Fra Siri Bakke: timen hos Vethjem er flyttet." }],
      }),
    });
    const search = defineTool({
      name: "web_search",
      description: "Searches the web",
      parameters: Type.Object({}),
      execute: async () => ({ output: [{ type: "text", text: "Restaurant Fyr, Bjørvika" }] }),
    });
    const tools = defineNudgeExtension({
      name: "tools",
      version: "1.0.0",
      setup: () => ({ tools: [mail, search], publicTools: ["web_search"] }),
    });
    const { detector, read } = fakeModel({
      Vethjem: "ORG",
      "Siri Bakke": "NAME",
      Sørumhallen: "PLACE",
      "Restaurant Fyr": "ORG",
    });
    const { faux, options, sent } = setup(detector, { extensions: [tools] });
    const record = (request: ModelContext) => sent.push(JSON.stringify(request));
    faux.setResponses([
      (request) => {
        record(request);
        return fauxAssistantMessage(
          [fauxToolCall("read_mail", {}), fauxToolCall("web_search", {})],
          { stopReason: "toolUse" },
        );
      },
      (request) => {
        record(request);
        return fauxAssistantMessage("Done.");
      },
    ]);
    const nudge = await createNudge(options, context);
    const author = { playerId: "p1", displayName: "Vegard" };
    const submission = await nudge.submit(
      LOBBY,
      { text: "Turnen er i Sørumhallen. Les mailen.", author, private: true },
      context,
    );
    await submission.wait(context);
    await nudge.close(context);

    expect(sent).toHaveLength(2);
    for (const request of sent)
      for (const value of ["Sørumhallen", "Vethjem", "Siri Bakke"])
        expect(request).not.toContain(value);
    expect(sent[1]).toContain("Restaurant Fyr");
    expect(read.some((text) => text.includes("Restaurant Fyr"))).toBe(false);
    // What a private message revealed is its author's alone.
    expect(nudge.showTo("p2", "Turnen er i Sørumhallen.")).not.toContain("Sørumhallen");
    expect(nudge.showTo("p1", "Turnen er i Sørumhallen.")).toContain("Sørumhallen");
  });

  it("sends nothing while the model is missing, unless it is only preferred", async () => {
    const { faux, options, sent } = setup(missing);
    faux.setResponses([
      (request) => {
        sent.push(JSON.stringify(request));
        return fauxAssistantMessage("Hi.");
      },
    ]);
    const nudge = await createNudge(options, context);
    const author = { playerId: "p1", displayName: "Vegard" };
    const submission = await nudge.submit(LOBBY, { text: "Hos Vethjem?", author }, context);
    const settled = await submission.wait(context);
    expect(sent).toHaveLength(0);
    expect(JSON.stringify(settled)).toMatch(/still downloading, so nothing was sent/);
    await nudge.close(context);

    const preferred = await createNudge(
      { ...options, privacy: { deep: missing, deepMode: "preferred" } },
      context,
    );
    await (await preferred.submit(LOBBY, { text: "Hei", author }, context)).wait(context);
    expect(sent).toHaveLength(1);
    await preferred.close(context);
  });
});

// The real model, downloaded: NUDGE_TEST_LOCAL_MODEL=<dir with model.onnx and the tokenizer>.
const modelDir = process.env.NUDGE_TEST_LOCAL_MODEL;

describe.skipIf(modelDir === undefined)("the local model itself", () => {
  it("finds what leaked when asked what it knew", async () => {
    const model = await openLocalModel(modelDir!, { threads: 2 });
    try {
      const vault = new Vault();
      const scanner = new DeepScanner({ detector: model, mode: "required" });
      await scanner.protectIn(
        [
          "Vi har time hos Vethjem for katten på torsdag.",
          "Skogstjerna har foreldremøte onsdag, si fra til Vegard.",
          "Mamma kommer med toget fra Sørumsand og går av på Oslo S.",
          "Hva er værmeldingen for Oslo i morgen?",
        ],
        vault,
      );
      const values = vault.entries.map(({ value }) => value);
      expect(values).toEqual(
        expect.arrayContaining(["Vethjem", "Skogstjerna", "Vegard", "Sørumsand"]),
      );
      expect(values).not.toContain("Oslo");
      expect(values).not.toContain("Mamma");
      // The rules know stations, whatever the model makes of them.
      expect(vault.redact("Mamma går av på Oslo S. Været i Oslo?", builtinDetectors)).toBe(
        "Mamma går av på ⟦PLACE2⟧. Været i Oslo?",
      );
    } finally {
      await model.close?.();
    }
  }, 60_000);

  it("stops when idle and starts again for the next call", async () => {
    const model = await openLocalModel(modelDir!, { threads: 2, idleMs: 100 });
    try {
      const running = () => spawnSync("pgrep", ["-f", `worker.*${modelDir}`]).status === 0;
      expect(running()).toBe(true);
      // Gone soon after the idle time, without a call.
      for (let i = 0; i < 50 && running(); i++)
        await new Promise((resolve) => setTimeout(resolve, 100));
      expect(running()).toBe(false);
      const [found = []] = await model.find(["Vi har time hos Vethjem på torsdag."]);
      expect(found.map((f) => f.kind)).toContain("ORG");
    } finally {
      await model.close?.();
    }
  }, 60_000);
});
