import {
  type ClientInfo,
  type SetupChoices,
  type SetupCodes,
  type SetupResult,
  type LocalServer,
} from "@nudge/core";
import {
  type SetupInfoResponse,
  SetupCodeRequest,
  SetupKeyRequest,
  SetupRequest,
  type SetupResponse,
} from "@nudge/protocol";
import { Hono } from "hono";
import { HttpError, readJson } from "./rest.ts";

/** What setup mode runs on: the code, what can be offered, and the setting up itself. */
export type SetupControl = {
  readonly codes: SetupCodes;
  /** The providers and models offered, and model servers found on the machine. */
  offer(): Promise<Omit<SetupInfoResponse, "open">>;
  /** Sends one tiny request with the key, throwing with the provider's answer when it fails. */
  testKey(provider: string, key: string): Promise<void>;
  complete(choices: SetupChoices, client: ClientInfo): Promise<SetupResult>;
};

/**
 * Setup mode (ADR 11), to mount at `/v1/setup`: a server with no config takes the one-time code
 * it printed, and with it the choices of the wizard, once. Wrong codes count against a few tries;
 * then, or once set up, every route but `GET /` answers 410.
 */
export function setupRoutes(control: SetupControl): Hono {
  const app = new Hono();
  // One at a time, so two browsers can't both set it up.
  let running: Promise<unknown> = Promise.resolve();

  const claim = (code: string) => {
    if (!control.codes.open) throw new HttpError(410, "This server is set up, or setup closed");
    if (!control.codes.check(code)) throw new HttpError(401, "That is not the setup code");
  };

  app.get("/", async (c) => {
    if (!control.codes.open)
      return c.json({ open: false, providers: [], local: [] } satisfies SetupInfoResponse);
    return c.json({ open: true, ...(await control.offer()) } satisfies SetupInfoResponse);
  });

  app.post("/code", async (c) => {
    claim((await readJson(c, SetupCodeRequest)).code);
    return c.body(null, 204);
  });

  app.post("/key", async (c) => {
    const body = await readJson(c, SetupKeyRequest);
    claim(body.code);
    try {
      await control.testKey(body.provider, body.key);
    } catch (error) {
      throw new HttpError(400, `The key didn't work: ${(error as Error).message}`);
    }
    return c.body(null, 204);
  });

  app.post("/", async (c) => {
    const body = await readJson(c, SetupRequest);
    const done = running.then(async () => {
      claim(body.code);
      const local =
        body.local === undefined
          ? undefined
          : (await control.offer()).local.find((server) => server.id === body.local);
      if (body.local !== undefined && local === undefined)
        throw new HttpError(400, `No model server "${body.local}" was found`);
      if (local === undefined && body.key !== undefined) {
        try {
          await control.testKey(body.model.provider, body.key);
        } catch (error) {
          throw new HttpError(400, `The key didn't work: ${(error as Error).message}`);
        }
      }
      const result = await control.complete(
        {
          assistant: body.assistant,
          model:
            local === undefined ? body.model : { provider: local.id, modelId: body.model.modelId },
          ...(body.key === undefined || local !== undefined
            ? {}
            : { key: { provider: body.model.provider, key: body.key } }),
          ...(local === undefined ? {} : { localProvider: localProvider(local) }),
          you: body.you,
          ...(body.publicUrl === undefined || isLoopback(body.publicUrl)
            ? {}
            : { server: { publicUrl: body.publicUrl.replace(/\/+$/, "") } }),
          ...(body.backups === undefined ? {} : { backups: body.backups }),
          ...(body.federation === undefined ? {} : { federation: body.federation }),
        },
        body.client,
      );
      control.codes.claim();
      return result;
    });
    running = done.catch(() => {});
    const result = await done;
    return c.json(
      {
        assistant: result.assistant,
        player: { id: result.player.id, displayName: result.player.displayName },
        token: result.token,
        clientId: result.clientId,
        serverToken: result.serverToken,
        owner: result.owner,
      } satisfies SetupResponse,
      201,
    );
  });

  return app;
}

function localProvider(server: LocalServer) {
  return {
    id: server.id,
    baseUrl: server.baseUrl,
    models: server.models.map((id) => ({ id })),
  };
}

/** An address only this machine reaches, not worth keeping for phones and other assistants. */
function isLoopback(url: string): boolean {
  const host = new URL(url).hostname;
  return host === "localhost" || host === "[::1]" || host.startsWith("127.");
}
