// The whole way through on a real desktop: a room asks, the desktop agent (a scripted model) starts
// a GTK app, fills in a field and reads it back. Run with NUDGE_DESKTOP_TESTS=1 (see desktop.test.ts).
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Context as ModelContext } from "@earendil-works/pi-ai";
import { createModels } from "@earendil-works/pi-ai/models";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxText,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { createNudge, LOBBY } from "@nudge/core";
import { describe, expect, it } from "vitest";
import desktop from "../src/extension.ts";

const run = process.env.NUDGE_DESKTOP_TESTS === "1";
const app = new URL("./fixtures/notes.py", import.meta.url).pathname;
const context = BACKGROUND_CONTEXT;
const json = (request: ModelContext) => JSON.stringify(request.messages);

describe.runIf(run)("use_desktop on a real desktop", () => {
  it("starts the app, types into it and reads it back", async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    const requests: ModelContext[] = [];
    const seen = (request: ModelContext) => (requests.push(structuredClone(request)), request);
    const titleRef = (request: ModelContext) =>
      /textbox \\"Title\\" \[(e\d+)\]/.exec(json(request))?.[1];
    faux.setResponses([
      (r) => (
        seen(r),
        fauxAssistantMessage([fauxToolCall("use_desktop", { task: "Write a note titled Bodø" })], {
          stopReason: "toolUse",
        })
      ),
      (r) => (
        seen(r),
        fauxAssistantMessage([fauxToolCall("desktop_launch", { app: "notes" })], {
          stopReason: "toolUse",
        })
      ),
      (r) => (
        seen(r),
        fauxAssistantMessage(
          [fauxToolCall("desktop_type", { ref: titleRef(r) ?? "e0", text: "Bodø" })],
          { stopReason: "toolUse" },
        )
      ),
      (r) => (seen(r), fauxAssistantMessage([fauxText("The title says Bodø.")])),
      (r) => (seen(r), fauxAssistantMessage([fauxText("Done.")])),
    ]);
    const nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
        extensions: [
          {
            extension: desktop,
            settings: {
              model: `${faux.provider.id}/${faux.getModel().id}`,
              apps: { notes: ["python3", app, "/dev/null"] },
              // Sandboxed, as by default: the app is in the checkout, which it can't see otherwise.
              readable: [new URL("./fixtures", import.meta.url).pathname],
            },
          },
        ],
      },
      context,
    );
    try {
      const author = { playerId: "owner", displayName: "Vegard" };
      const turn = await nudge.submit(LOBBY, { text: "Write a note titled Bodø", author }, context);
      expect((await turn.wait(context)).status).toBe("done");
      expect(requests).toHaveLength(5);
      expect(json(requests[2]!)).toContain("Started notes.");
      expect(json(requests[2]!)).toMatch(/frame \\"Notes\\" \(notes\.py\)/);
      expect(json(requests[3]!)).toMatch(/Typed into textbox \\"Title\\" \[e\d+\]/);
      expect(json(requests[3]!)).toMatch(/textbox \\"Title\\" \[e\d+\]: Bodø/);
      expect(json(requests[4]!)).toContain("The title says Bodø.");
    } finally {
      await nudge.close(context);
    }
  }, 60_000);
});
