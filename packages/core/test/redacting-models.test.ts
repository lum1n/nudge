import {
  type Api,
  type AssistantMessage,
  type Context,
  createAssistantMessageEventStream,
  type Model,
  type Models,
} from "@earendil-works/pi-ai";
import { describe, expect, it } from "vitest";
import { builtinDetectors, RedactingModels, Vault } from "../src/index.ts";

const MODEL = { api: "faux", provider: "faux", id: "m" } as unknown as Model<Api>;
const REQUEST: Context = {
  messages: [{ role: "user", content: "Mail kari.nordmann@example.no", timestamp: 0 }],
};

/** Redacting models in front of `streamSimple`, with a vault that saves through `save`. */
function setup(
  streamSimple: (model: Model<Api>, context: Context) => unknown,
  save: () => Promise<void> = async () => {},
) {
  const inner = { streamSimple } as unknown as Models;
  const models = new RedactingModels(inner, { detectors: builtinDetectors });
  models.bind(new Vault(), save);
  return models;
}

function failed(message: string): AssistantMessage {
  return {
    role: "assistant",
    content: [],
    api: MODEL.api,
    provider: MODEL.provider,
    model: MODEL.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "error",
    errorMessage: message,
    timestamp: 0,
  };
}

describe("RedactingModels errors", () => {
  it("passes a provider's failure to start through with its own message", async () => {
    const models = setup(() => {
      throw new Error("Provider is not configured: faux");
    });
    const reply = await models.completeSimple(MODEL, REQUEST);
    expect(reply.stopReason).toBe("error");
    expect(reply.errorMessage).toBe("Provider is not configured: faux");
  });

  it("passes a provider's error event through, such as a 429", async () => {
    let sent: Context | undefined;
    const models = setup((_, context) => {
      sent = context;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "error", reason: "error", error: failed("429 Too Many Requests") });
      stream.end();
      return stream;
    });
    const reply = await models.completeSimple(MODEL, REQUEST);
    expect(reply.errorMessage).toBe("429 Too Many Requests");
    expect(JSON.stringify(sent)).toContain("⟦EMAIL1⟧");
  });

  it("says redaction failed when the values could not be saved, and sends nothing", async () => {
    let calls = 0;
    const models = setup(
      () => {
        calls++;
        throw new Error("never");
      },
      async () => {
        throw new Error("disk full");
      },
    );
    const reply = await models.completeSimple(MODEL, REQUEST);
    expect(reply.errorMessage).toBe("Redaction failed: disk full");
    expect(calls).toBe(0);
  });

  it("says redaction failed when the scan fails, and gives a refusal as it is", async () => {
    const models = setup(() => {
      throw new Error("never");
    });
    models.scan = async () => {
      throw new Error("scanner crashed");
    };
    expect((await models.completeSimple(MODEL, REQUEST)).errorMessage).toBe(
      "Redaction failed: scanner crashed",
    );
    models.refuse = () => "The budget is spent";
    expect((await models.completeSimple(MODEL, REQUEST)).errorMessage).toBe("The budget is spent");
  });
});

describe("RedactingModels spellings", () => {
  it("sends one placeholder for a value's spellings, and stores each as written", async () => {
    let sent: Context | undefined;
    const models = setup((_, context) => {
      sent = context;
      const stream = createAssistantMessageEventStream();
      const message: AssistantMessage = {
        ...failed(""),
        stopReason: "stop",
        content: [{ type: "text", text: "Yes, ⟦NAME1⟧ is in /home/⟦NAME1⟧." }],
      };
      delete message.errorMessage;
      stream.push({ type: "done", reason: "stop", message });
      stream.end();
      return stream;
    });
    const saved: string[] = [];
    const vault = new Vault();
    vault.protect("Ann", "NAME", "p1");
    vault.takeUnsaved();
    models.bind(vault, async (entries) => {
      saved.push(...entries.map((entry) => `${entry.placeholder}=${entry.value}`));
    });
    const request: Context = {
      messages: [{ role: "user", content: "Is ann in /home/ann? And ANN, Ann?", timestamp: 0 }],
    };
    const reply = await models.completeSimple(MODEL, request);
    expect(JSON.stringify(sent)).toContain("Is ⟦NAME1⟧ in /home/⟦NAME1⟧? And ⟦NAME1⟧, ⟦NAME1⟧?");
    expect(saved).toEqual(["⟦NAME2⟧=ann", "⟦NAME3⟧=ANN"]);
    // Stored with the spelling the request had in that place.
    expect(reply.content).toEqual([{ type: "text", text: "Yes, ⟦NAME1⟧ is in /home/⟦NAME2⟧." }]);
    // Put back only for the value's owner.
    const forOwner = await models.withValues("p1").completeSimple(MODEL, request);
    expect(forOwner.content).toEqual([{ type: "text", text: "Yes, Ann is in /home/ann." }]);
    const forOther = await models.withValues("p2").completeSimple(MODEL, request);
    expect(forOther.content).toEqual(reply.content);
  });
});
