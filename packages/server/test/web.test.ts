import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { createNudge, type Nudge } from "@nudge/core";
import type { AssistantsResponse } from "@nudge/protocol";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createApp } from "../src/index.ts";

const context = BACKGROUND_CONTEXT;

describe("web UI", () => {
  let nudge: Nudge;
  let web: string;

  beforeEach(async () => {
    const faux = fauxProvider();
    const models = createModels();
    models.setProvider(faux.provider);
    nudge = await createNudge(
      {
        database: ":memory:",
        models,
        model: { provider: faux.provider.id, modelId: faux.getModel().id },
      },
      context,
    );
    web = await mkdtemp(join(tmpdir(), "nudge-web-"));
    await mkdir(join(web, "assets"));
    await writeFile(join(web, "index.html"), "<!doctype html><title>Nudge</title>");
    await writeFile(join(web, "assets", "app.js"), "console.log(1);");
  });

  afterEach(async () => {
    await rm(web, { recursive: true, force: true });
    await nudge.close(context);
  });

  it("is served outside /v1, with index.html for the browser's routes", async () => {
    const app = createApp({ assistants: new Map([["robin", nudge]]), web });

    const assistants = (await (await app.request("/v1/a")).json()) as AssistantsResponse;
    expect(assistants).toEqual({ assistants: [{ name: "robin", displayName: "Nudge" }] });

    // The old API's paths are pages now.
    for (const page of ["/", "/login", "/robin/trip", "/a"]) {
      const response = await app.request(page);
      expect(response.status).toBe(200);
      expect(await response.text()).toContain("<title>Nudge</title>");
    }
    const script = await app.request("/assets/app.js");
    expect(await script.text()).toBe("console.log(1);");

    // The API keeps its JSON answers; it is never shadowed by the page.
    expect((await app.request("/v1/a/robin/me")).status).toBe(401);
    const missing = await app.request("/v1/nothing-here");
    expect(missing.status).toBe(404);
    expect(await missing.json()).toEqual({ error: "Not found" });
  });

  it("answers pages with 404 without a web UI", async () => {
    const app = createApp({ assistants: new Map([["robin", nudge]]) });
    expect((await app.request("/login")).status).toBe(404);
    expect((await app.request("/a/robin/me")).status).toBe(404);
  });
});
