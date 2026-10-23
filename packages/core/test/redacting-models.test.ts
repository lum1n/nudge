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
