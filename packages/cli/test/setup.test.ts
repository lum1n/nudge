import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import {
  backupKey,
  DEFAULT_MODEL,
  loadConfig,
  openAssistant,
  openRecoveryKit,
  ServerKeys,
  serverKeysDir,
} from "@nudge/core";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { offeredProviders, slugOf } from "../src/commands/setup-offer.ts";
import { kit, setup } from "../src/commands/setup.ts";

const context = BACKGROUND_CONTEXT;

/** What the wizard reads: a test writes its answers here, as if piped in. */
const input = vi.hoisted(() => ({ stdin: undefined as unknown as NodeJS.ReadableStream }));

vi.mock("node:process", async (original) => {
  const actual = await original<typeof import("node:process")>();
  return {
    ...actual,
    get stdin() {
      return input.stdin;
    },
  };
});

// No model provider is called and no Ollama looked for: a key is good when it says so.
vi.mock("@nudge/core", async (original) => ({
  ...(await original<typeof import("@nudge/core")>()),
  detectLocalServers: async () => [],
  testProviderKey: async (_provider: string, key: string) => {
    if (!key.includes("good")) throw new Error("401 invalid x-api-key");
  },
}));

let dir: string;
let config: string;
let cwd: string;
let out: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "nudge-setup-test-"));
  config = join(dir, "nudge.json");
  cwd = process.cwd();
  // The recovery kit goes where the command runs.
  process.chdir(dir);
  out = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    out += String(chunk);
    return true;
  });
  vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.join(" ")}\n`;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  process.chdir(cwd);
  await rm(dir, { recursive: true, force: true });
});

/** Answers the wizard's questions with `lines`, all at once, then ends the input. */
function answer(...lines: string[]): void {
  const stream = new PassThrough();
  stream.end(lines.map((line) => `${line}\n`).join(""));
  input.stdin = stream;
}

describe("nudge setup", () => {
  it("sets the server up from answers piped in, and seals the backup key in a kit", async () => {
    answer(
      "Robin Hood", // its name
      "", // its address name: the default
      "", // who runs the model: the first, Anthropic
      "", // the recommended model
      "sk-ant-wrong", // a key that doesn't work…
      "sk-ant-good", // …and one that does
      "Vegard", // you
      "a passphrase long enough", // the kit's
    );
    await setup(config);

    expect(out).toContain("What should your assistant be called? [Nudge]: ");
    expect(out).toContain(
      "Its name in addresses (lower case; it can't change later) [robin-hood]: ",
    );
    expect(out).toContain("  1. Anthropic, with your own API key");
    expect(out).toContain("Trying it… it didn't: ");
    expect(out).toContain("Trying it… it works.");
    // Keys and passphrases aren't echoed.
    expect(out).not.toContain("sk-ant-good");
    expect(out).not.toContain("a passphrase long enough");
    expect(out).toContain("Robin Hood is set up, and Vegard owns this server.");

    const loaded = await loadConfig(config);
    expect(loaded.assistants).toMatchObject([
      { name: "robin-hood", displayName: "Robin Hood", model: DEFAULT_MODEL },
    ]);
    expect(loaded.backup).toMatchObject({ dir: join(dir, "backups") });
    expect(new ServerKeys(serverKeysDir(config)).providers()).toEqual(["anthropic"]);

    // The token printed once is Vegard's, as the assistant's admin.
    const printed = /Your token, shown once: (\S+)/.exec(out)?.[1];
    expect(out).toContain(`Chat here: NUDGE_TOKEN=${printed} nudge chat --url`);
    const nudge = await openAssistant(loaded, loaded.assistants[0]!, context);
    try {
      const credential = await nudge.players.authenticate(printed!, context);
      expect(credential?.player).toMatchObject({ displayName: "Vegard" });
      expect(await nudge.players.isAdmin(credential!.player.id, context)).toBe(true);
    } finally {
      await nudge.close(context);
    }

    // The kit, in the directory it ran in, opens to the backup key beside the config.
    expect(out).toContain("Wrote nudge-recovery-kit.json.");
    const sealed = await readFile(join(dir, "nudge-recovery-kit.json"), "utf8");
    expect(openRecoveryKit(sealed, "a passphrase long enough")).toEqual(
      await backupKey(join(dir, "nudge-backup.key")),
    );
  });

  it("skips the kit on a short passphrase, and says how to make one later", async () => {
    answer("Nudge", "", "", "", "sk-ant-good", "Ann", "");
    await setup(config);
    expect(out).toContain("Skipped. Make one later with: nudge kit");
    await expect(readFile(join(dir, "nudge-recovery-kit.json"))).rejects.toThrow();
  });

  it("stops, setting nothing up, when the answers end too soon", async () => {
    answer("Nudge", "");
    await expect(setup(config)).rejects.toMatchObject({
      name: "UsageError",
      message: "Setup stopped before it was done",
    });
    await expect(readFile(config)).rejects.toThrow();
  });

  it("leaves a server that is set up alone", async () => {
    await writeFile(config, JSON.stringify({ assistants: [{ name: "robin" }] }));
    answer();
    await setup(config);
    expect(out).toBe(`${config} exists: this server is set up. nudge serve runs it.\n`);
  });
});

describe("nudge kit", () => {
  it("seals the backup key with the passphrase", async () => {
    vi.stubEnv("NUDGE_KIT_PASSPHRASE", "eight or more");
    await kit(config, join(dir, "kit.json"));
    const sealed = await readFile(join(dir, "kit.json"), "utf8");
    expect(openRecoveryKit(sealed, "eight or more")).toEqual(
      await backupKey(join(dir, "nudge-backup.key")),
    );
    expect(() => openRecoveryKit(sealed, "something else")).toThrow();
  });

  it("refuses a short passphrase", async () => {
    vi.stubEnv("NUDGE_KIT_PASSPHRASE", "short");
    await expect(kit(config, join(dir, "kit.json"))).rejects.toThrow(
      "The passphrase needs 8 characters or more",
    );
  });
});

describe("what setup offers", () => {
  it("names an assistant's address from its display name", () => {
    expect(slugOf("Robin Hood")).toBe("robin-hood");
    expect(slugOf("  Åse's  Ålesund-bot! ")).toBe("ase-s-alesund-bot");
    expect(slugOf("Zoë")).toBe("zoe");
    expect(slugOf("!!!")).toBe("");
    expect(slugOf("x".repeat(60))).toHaveLength(40);
  });

  it("spells out the letters NFKD leaves whole", () => {
    expect(slugOf("Bjørn")).toBe("bjorn");
    expect(slugOf("Æsa")).toBe("aesa");
    expect(slugOf("ØRJAN BLÅBÆR")).toBe("orjan-blabaer");
    expect(slugOf("Straße STRAẞE")).toBe("strasse-strasse");
    expect(slugOf("Đorđe Łukasz Þóra")).toBe("dorde-lukasz-thora");
  });

  it("offers Anthropic first, recommending the default model", () => {
    const [first, ...rest] = offeredProviders();
    expect(first).toMatchObject({ id: "anthropic", recommended: DEFAULT_MODEL.modelId });
    expect(first!.models[0]).toMatchObject({ id: DEFAULT_MODEL.modelId });
    for (const provider of [first!, ...rest]) {
      expect(provider.models.length).toBeGreaterThan(0);
      expect(provider.recommended).toBe(provider.models[0]!.id);
    }
  });
});
