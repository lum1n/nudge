import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels } from "@earendil-works/pi-ai/models";
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai/providers/faux";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createNudge,
  databaseEncryption,
  decryptDatabase,
  encryptDatabase,
  keyFile,
  LOBBY,
  type NudgeOptions,
} from "../src/index.ts";

const context = BACKGROUND_CONTEXT;
const SECRET = "Kari wants the lighthouse cabin on the 3rd";

function options(database: string, extra: Partial<NudgeOptions> = {}): NudgeOptions {
  const faux = fauxProvider();
  const models = createModels();
  models.setProvider(faux.provider);
  faux.setResponses([fauxAssistantMessage("Noted."), fauxAssistantMessage("Noted again.")]);
  return {
    database,
    models,
    model: { provider: faux.provider.id, modelId: faux.getModel().id },
    displayName: "Robin",
    ...extra,
  };
}

async function chat(database: string, text: string): Promise<void> {
  const nudge = await createNudge(options(database), context);
  try {
    const submission = await nudge.submit(LOBBY, { text }, context);
    expect((await submission.wait(context)).status).toBe("done");
  } finally {
    await nudge.close(context);
  }
}

async function transcript(database: string): Promise<string> {
  const nudge = await createNudge(options(database), context);
  try {
    const lobby = await nudge.conversation(LOBBY, context);
    return JSON.stringify((await lobby.entries({}, 50, undefined, context)).items);
  } finally {
    await nudge.close(context);
  }
}

/** Every file of the database (main, WAL, shared memory) as one string. */
function onDisk(dir: string): string {
  return readdirSync(dir)
    .filter((name) => name.startsWith("assistant.sqlite") && !name.endsWith(".key"))
    .map((name) => readFileSync(join(dir, name), "latin1"))
    .join("\n");
}

describe("encrypted storage", () => {
  let dir: string;
  let database: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "nudge-db-"));
    database = join(dir, "assistant.sqlite");
    delete process.env.NUDGE_DB_KEY;
  });
  afterEach(async () => {
    delete process.env.NUDGE_DB_KEY;
    await rm(dir, { recursive: true, force: true });
  });

  it("creates a new database encrypted when NUDGE_DB_KEY is set, and needs the key again", async () => {
    process.env.NUDGE_DB_KEY = Buffer.alloc(32, 9).toString("base64");
    await chat(database, SECRET);
    expect(await databaseEncryption(database)).toBe("encrypted");
    expect(onDisk(dir)).not.toContain("lighthouse");
    expect(await transcript(database)).toContain("lighthouse");

    delete process.env.NUDGE_DB_KEY;
    await expect(createNudge(options(database), context)).rejects.toThrow(/is encrypted/);
    process.env.NUDGE_DB_KEY = Buffer.alloc(32, 8).toString("base64");
    await expect(createNudge(options(database), context)).rejects.toThrow(/Cannot open/);
  });

  it("gives a new database a key of its own with encryptNew, and leaves an old one as it is", async () => {
    const nudge = await createNudge(options(database, { encryptNew: true }), context);
    await nudge.close(context);
    expect(await databaseEncryption(database)).toBe("encrypted");
    expect(statSync(keyFile(database)).mode & 0o777).toBe(0o600);
    await chat(database, SECRET);
    expect(onDisk(dir)).not.toContain("lighthouse");

    const old = join(dir, "old.sqlite");
    await createNudge(options(old), context).then((plain) => plain.close(context));
    await createNudge(options(old, { encryptNew: true }), context).then((n) => n.close(context));
    expect(await databaseEncryption(old)).toBe("plain");
    expect(existsSync(keyFile(old))).toBe(false);
  });

  it("encrypts an existing database in place and decrypts it again", async () => {
    await chat(database, SECRET);
    expect(await databaseEncryption(database)).toBe("plain");
    expect(onDisk(dir)).toContain("lighthouse");

    expect(await encryptDatabase(database)).toBe(keyFile(database));
    expect(statSync(keyFile(database)).mode & 0o777).toBe(0o600);
    expect(await databaseEncryption(database)).toBe("encrypted");
    expect(onDisk(dir)).not.toContain("lighthouse");
    await chat(database, "and the 4th too");
    const text = await transcript(database);
    expect(text).toContain("lighthouse");
    expect(text).toContain("the 4th");

    await decryptDatabase(database);
    expect(existsSync(keyFile(database))).toBe(false);
    expect(await databaseEncryption(database)).toBe("plain");
    expect(await transcript(database)).toContain("the 4th");
  });

  it("refuses a key for an unencrypted database and a malformed key", async () => {
    await chat(database, SECRET);
    writeFileSync(keyFile(database), Buffer.alloc(32, 1).toString("base64"));
    await expect(createNudge(options(database), context)).rejects.toThrow(/not encrypted/);
    writeFileSync(keyFile(database), "short");
    await expect(encryptDatabase(database)).rejects.toThrow(/32-byte key/);
  });
});
