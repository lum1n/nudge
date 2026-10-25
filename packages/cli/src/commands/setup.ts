import { existsSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { stdin, stdout } from "node:process";
import { createInterface, type Interface } from "node:readline/promises";
import { Writable } from "node:stream";
import {
  Assistants,
  BACKGROUND_CONTEXT,
  backupKey,
  buildModels,
  completeSetup,
  detectLocalServers,
  openAssistant,
  readableError,
  sealRecoveryKit,
  ServerKeys,
  serverKeysDir,
  ServerOwners,
  serverOwnersFile,
  testProviderKey,
} from "@nudge/core";
import { UsageError } from "../errors.ts";
import { hostOptions } from "../host.ts";
import { keyPath } from "./backup.ts";
import { offeredProviders, slugOf } from "./setup-offer.ts";

const context = BACKGROUND_CONTEXT;

/**
 * `nudge setup` (and `nudge init`): the setup wizard in a terminal (ADR 11), for a server that
 * isn't running yet. It asks the same as the web wizard, sets the server up, and prints the
 * owner's token and a recovery kit.
 */
export async function setup(configPath: string): Promise<void> {
  if (existsSync(configPath)) {
    console.log(`${configPath} exists: this server is set up. nudge serve runs it.`);
    return;
  }
  const muted = new Muted();
  const rl = createInterface({ input: stdin, output: muted, terminal: stdin.isTTY });
  const answers = answersOf(rl);
  try {
    console.log("Setting up Nudge.\n");
    const displayName = await ask(answers, "What should your assistant be called?", "Nudge");
    const name = await ask(
      answers,
      "Its name in addresses (lower case; it can't change later)",
      slugOf(displayName) || "nudge",
    );

    const providers = offeredProviders();
    const local = await detectLocalServers();
    const options = [
      ...providers.map((p) => ({ label: `${p.name}, with your own API key`, provider: p })),
      ...local.map((server) => ({ label: `${server.name}, on this machine (no key)`, server })),
    ];
    console.log("\nWho runs the model?");
    options.forEach((option, index) => console.log(`  ${index + 1}. ${option.label}`));
    const picked = options[Number(await ask(answers, "Pick one", "1")) - 1] ?? options[0]!;

    let model: { provider: string; modelId: string };
    let key: { provider: string; key: string } | undefined;
    if ("provider" in picked) {
      const { provider } = picked;
      const modelId = await ask(
        answers,
        `Model (${provider.models.map((m) => m.id).join(", ")})`,
        provider.recommended,
      );
      model = { provider: provider.id, modelId };
      for (;;) {
        const value = (await askHidden(answers, muted, `${provider.name} API key`)).trim();
        if (value === "") continue;
        process.stdout.write("Trying it… ");
        try {
          await testProviderKey(provider.id, value);
          console.log("it works.");
          key = { provider: provider.id, key: value };
          break;
        } catch (error) {
          console.log(`it didn't: ${readableError((error as Error).message)}`);
        }
      }
    } else {
      const modelId = await ask(
        answers,
        `Model (${picked.server.models.join(", ")})`,
        picked.server.models[0],
      );
      model = { provider: picked.server.id, modelId };
    }
    const you = await ask(answers, "\nYour name (you will be its admin and this server's owner)");

    const keys = new ServerKeys(serverKeysDir(configPath));
    const owners = new ServerOwners(serverOwnersFile(configPath));
    const assistants = await Assistants.open({
      configPath,
      open: (config, assistant) =>
        openAssistant(config, assistant, context, {
          ...hostOptions(assistant, config, configPath),
          models: buildModels(config.providers, keys.credentialsFor(assistant.name)),
        }),
      context,
      allowMissing: true,
    });
    try {
      const pickedLocal = "server" in picked ? picked.server : undefined;
      const result = await completeSetup(
        { configPath, assistants, keys, owners },
        {
          assistant: { name, displayName },
          model,
          ...(key === undefined ? {} : { key }),
          ...(pickedLocal === undefined
            ? {}
            : {
                localProvider: {
                  id: pickedLocal.id,
                  baseUrl: pickedLocal.baseUrl,
                  models: pickedLocal.models.map((id) => ({ id })),
                },
              }),
          you: { displayName: you },
        },
        { name: "nudge-cli", platform: "cli" },
        context,
      );
      console.log(`\n${displayName} is set up, and ${you} owns this server.`);
      console.log(`Your token, shown once: ${result.token}`);
      console.log(`Chat here: NUDGE_TOKEN=${result.token} nudge chat --url http://127.0.0.1:8787`);
      console.log("Run it: nudge serve   (--host 0.0.0.0 for phones on this network)");
    } finally {
      await assistants.close();
    }

    console.log(
      "\nA recovery kit holds the backup key, sealed with a passphrase. With it and a backup,\n" +
        "everything here can be brought back. Keep it somewhere other than this machine.",
    );
    const passphrase = await askHidden(
      answers,
      muted,
      "Passphrase for it (8 characters or more; empty to skip)",
    );
    if (passphrase.length >= 8) await writeKit(configPath, passphrase, "nudge-recovery-kit.json");
    else console.log("Skipped. Make one later with: nudge kit");
  } finally {
    rl.close();
  }
}

/**
 * Lines typed, or piped in all at once: read through the line iterator, which keeps lines that
 * arrive before they are asked for (`question` drops those).
 */
type Answers = AsyncIterator<string>;

function answersOf(rl: Interface): Answers {
  return rl[Symbol.asyncIterator]();
}

async function next(answers: Answers): Promise<string> {
  const line = await answers.next();
  if (line.done === true) throw new UsageError("Setup stopped before it was done");
  return line.value;
}

async function ask(answers: Answers, question: string, fallback?: string): Promise<string> {
  for (;;) {
    stdout.write(`${question}${fallback ? ` [${fallback}]` : ""}: `);
    const answer = (await next(answers)).trim();
    if (answer !== "") return answer;
    if (fallback !== undefined) return fallback;
  }
}

/** Asks without showing what is typed, as for a key or a passphrase. */
async function askHidden(answers: Answers, muted: Muted, question: string): Promise<string> {
  stdout.write(`${question}: `);
  muted.quiet = true;
  try {
    return await next(answers);
  } finally {
    muted.quiet = false;
    stdout.write("\n");
  }
}

/** Standard output that drops what readline echoes while `quiet`. */
class Muted extends Writable {
  quiet = false;
  override _write(chunk: Buffer, encoding: BufferEncoding, done: () => void): void {
    if (!this.quiet) stdout.write(chunk, encoding);
    done();
  }
}

/** Seals the server's backup key with `passphrase` into `file`. */
export async function writeKit(
  configPath: string,
  passphrase: string,
  file: string,
): Promise<void> {
  const kit = sealRecoveryKit(
    await backupKey(keyPath(configPath, { assistants: [] }), true),
    passphrase,
  );
  await writeFile(file, kit, { mode: 0o600 });
  console.log(`Wrote ${file}. Move it off this machine, and keep the passphrase apart from it.`);
}

/** `nudge kit [file]`: a new recovery kit, asking for its passphrase twice. */
export async function kit(configPath: string, file = "nudge-recovery-kit.json"): Promise<void> {
  const passphrase = await promptHidden("Passphrase (8 characters or more)");
  if (passphrase.length < 8) throw new UsageError("The passphrase needs 8 characters or more");
  if ((await promptHidden("The same again")) !== passphrase)
    throw new UsageError("Those weren't the same");
  await writeKit(configPath, passphrase, file);
}

/** One hidden answer: `NUDGE_KIT_PASSPHRASE` when set, as for scripts, else asked. */
export async function promptHidden(question: string): Promise<string> {
  const fromEnv = process.env.NUDGE_KIT_PASSPHRASE;
  if (fromEnv !== undefined) return fromEnv;
  const muted = new Muted();
  const rl = createInterface({ input: stdin, output: muted, terminal: stdin.isTTY });
  try {
    return await askHidden(answersOf(rl), muted, question);
  } finally {
    rl.close();
  }
}
