import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { describe, expect, it } from "vitest";
import {
  builtinDetectors,
  createLogger,
  errorFields,
  loggerFromEnv,
  type ModelFailure,
  ModelErrors,
  RedactingModels,
  Vault,
} from "../src/index.ts";

const clock = () => Date.UTC(2026, 9, 23, 12);

describe("the logger", () => {
  it("drops lines below its level", () => {
    const lines: string[] = [];
    const log = createLogger({ level: "warn", write: (line) => lines.push(line), now: clock });
    log.debug("debug");
    log.info("info");
    log.warn("warn");
    log.error("error");
    expect(lines.map((line) => JSON.parse(line).level)).toEqual(["warn", "error"]);
  });

  it("writes one JSON object a line, with its context and no undefined fields", () => {
    const lines: string[] = [];
    const log = createLogger({ write: (line) => lines.push(line), now: clock }).with({
      assistant: "robin",
    });
    log.error("Request failed", {
      room: "r1",
      route: undefined,
      ...errorFields(new TypeError("x")),
    });
    const line = JSON.parse(lines[0]!);
    expect(line).toMatchObject({
      time: "2026-10-23T12:00:00.000Z",
      level: "error",
      msg: "Request failed",
      assistant: "robin",
      room: "r1",
      error: "TypeError",
      detail: "x",
    });
    expect("route" in line).toBe(false);
  });

  it("scrubs keys, tokens and emails from what it writes", () => {
    const lines: string[] = [];
    const log = createLogger({ format: "text", write: (line) => lines.push(line), now: clock });
    log.warn("Model request failed", {
      detail: "Invalid api key: sk-ant-api03-abcdefghijklmnop for ann@example.com",
    });
    expect(lines[0]).toContain("WARN Model request failed");
    expect(lines[0]).not.toContain("sk-ant-api03");
    expect(lines[0]).not.toContain("ann@example.com");
  });

  it("takes its level and format from the environment", () => {
    const lines: string[] = [];
    const write = (line: string) => lines.push(line);
    loggerFromEnv({ NUDGE_LOG_LEVEL: "ERROR" }, false, write).warn("dropped");
    loggerFromEnv({ NUDGE_LOG_LEVEL: "debug" }, false, write).debug("kept");
    loggerFromEnv({ NUDGE_LOG_LEVEL: "nonsense" }, false, write).debug("dropped too");
    loggerFromEnv({}, true, write).info("text on a terminal");
    loggerFromEnv({ NUDGE_LOG_FORMAT: "json" }, true, write).info("json when asked");
    expect(lines).toHaveLength(3);
    expect(JSON.parse(lines[0]!).msg).toBe("kept");
    expect(lines[1]).toMatch(/ INFO text on a terminal$/);
    expect(JSON.parse(lines[2]!).msg).toBe("json when asked");
  });
});

describe("model errors", () => {
  it("keeps the last few, newest first, scrubbed and cut short", () => {
    let now = 1000;
    const errors = new ModelErrors(2, () => now);
    expect(errors.lastAt()).toBeUndefined();
    errors.record({ provider: "p", model: "m", message: "first" });
    now = 2000;
    errors.record({ provider: "p", model: "m", message: "token: abc123def456" });
    now = 3000;
    errors.record({ provider: "p", model: "m", message: "x".repeat(1000), assistant: "robin" });
    const recent = errors.recent();
    expect(recent).toHaveLength(2);
    expect(recent[0]).toMatchObject({ at: 3000, assistant: "robin" });
    expect(recent[0]!.message.length).toBeLessThanOrEqual(300);
    expect(recent[1]!.message).not.toContain("abc123def456");
    expect(errors.lastAt()).toBe(3000);
  });

  it("are told of a provider's error, with placeholders where personal values were", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    faux.setResponses([
      (context) =>
        fauxAssistantMessage("", {
          stopReason: "error",
          errorMessage: `Bad request: ${JSON.stringify(context.messages[0]?.content)}`,
        }),
    ]);
    const failures: ModelFailure[] = [];
    const redacting = new RedactingModels(models, {
      detectors: builtinDetectors,
      onModelError: (failure) => failures.push(failure),
    });
    redacting.bind(new Vault(), async () => {});
    const answer = await redacting.completeSimple(faux.getModel(), {
      messages: [{ role: "user", content: "Write to ann@example.com", timestamp: 0 }],
    });
    expect(answer.stopReason).toBe("error");
    expect(failures).toHaveLength(1);
    expect(failures[0]).toMatchObject({ provider: faux.provider.id, model: faux.getModel().id });
    expect(failures[0]!.message).toContain("Bad request");
    expect(failures[0]!.message).not.toContain("ann@example.com");
    expect(failures[0]!.message).toContain("⟦EMAIL");
  });
});
