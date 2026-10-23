import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { Models } from "@earendil-works/pi-ai";
import {
  buildModels,
  builtinDetectors,
  checkExtensions,
  checkLocalModel,
  databaseEncryption,
  databaseKey,
  DEFAULT_MODEL,
  keyFile,
  loadConfig,
  LOCAL_MODEL,
  localModelDir,
  openLocalModel,
  ServerKeys,
  serverKeysDir,
  Vault,
} from "@nudge/core";
import { modelsDir } from "../host.ts";

export type DoctorOptions = {
  readonly config: string;
  /** Send one tiny request to each assistant's model, and to each model its extensions use. */
  readonly ping?: boolean;
  /** Check that the built-in detectors catch a sample of personal data. */
  readonly privacy?: boolean;
};

/** Checks what `nudge chat` needs, printing one line per check. Returns false when something failed. */
export async function doctor(options: DoctorOptions): Promise<boolean> {
  let ok = true;
  const check = (passed: boolean, text: string) => {
    ok &&= passed;
    console.log(`${passed ? "ok  " : "FAIL"} ${text}`);
  };
  // Works, but someone should know; doesn't fail the doctor.
  const warn = (text: string) => console.log(`warn ${text}`);

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 19),
    `Node ${process.versions.node} (needs ≥ 22.19)`,
  );

  if (options.privacy) {
    for (const [kind, value] of PRIVACY_SAMPLES) {
      const vault = new Vault();
      const redacted = vault.redact(`value: ${value}.`, builtinDetectors);
      const caught = !redacted.includes(value) && vault.rehydrate(redacted) === `value: ${value}.`;
      check(
        caught,
        `privacy: ${kind} ${caught ? "redacted and restored" : `leaks as "${redacted}"`}`,
      );
    }
  }

  let config;
  try {
    config = await loadConfig(options.config);
    check(true, `config ${options.config}`);
  } catch (error) {
    check(false, `config ${options.config}: ${(error as Error).message}`);
    return false;
  }

  const deep = config.privacy?.deep ?? "off";
  if (deep !== "off") await checkDeep(check, modelsDir(options.config), deep);

  const keys = new ServerKeys(serverKeysDir(options.config));
  const ping = async (models: Models, label: string, provider: string, modelId: string) => {
    const model = models.getModel(provider, modelId);
    if (model === undefined) return;
    const answer = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with the word pong.", timestamp: Date.now() }],
    });
    const failed = answer.stopReason === "error" || answer.stopReason === "aborted";
    check(!failed, `${label}: ping ${failed ? (answer.errorMessage ?? "failed") : "answered"}`);
  };
  for (const assistant of config.assistants) {
    // With the keys set on the server for this assistant, as `nudge serve` builds them.
    const models = buildModels(config.providers, keys.credentialsFor(assistant.name));
    const ref = assistant.model ?? DEFAULT_MODEL;
    const label = `${assistant.name}: ${ref.provider}/${ref.modelId}`;
    const database = assistant.database ?? "";
    try {
      await mkdir(dirname(database), { recursive: true });
      await access(dirname(database), constants.W_OK);
      check(true, `${assistant.name}: storage ${database}`);
    } catch (error) {
      check(false, `${assistant.name}: storage ${database}: ${(error as Error).message}`);
    }
    try {
      const state = await databaseEncryption(database);
      const key = await databaseKey(database);
      if (state === "encrypted")
        check(key !== undefined, `${assistant.name}: encrypted, key ${key?.source ?? "missing"}`);
      else if (state === "plain")
        check(
          key === undefined,
          key === undefined
            ? `${assistant.name}: not encrypted ("nudge db encrypt" to encrypt it)`
            : `${assistant.name}: not encrypted, but ${key.source} is set`,
        );
      else
        check(
          true,
          `${assistant.name}: will be created encrypted (key ${key?.source ?? keyFile(database)})`,
        );
    } catch (error) {
      check(false, `${assistant.name}: encryption: ${(error as Error).message}`);
    }
    if (assistant.extensions !== undefined) {
      try {
        const installed = await checkExtensions(assistant.extensions);
        const names = installed.map((e) => `${e.name}${e.version ? ` ${e.version}` : ""}`);
        check(true, `${assistant.name}: extensions ${names.join(", ") || "none enabled"}`);
        for (const extension of installed) {
          for (const problem of extension.problems)
            check(false, `${assistant.name}: ${extension.name}: ${problem}`);
          for (const warning of extension.warnings)
            warn(`${assistant.name}: ${extension.name}: ${warning}`);
          for (const used of extension.models) {
            const what = `${assistant.name}: ${extension.name} uses ${used.provider}/${used.modelId}`;
            if (models.getModel(used.provider, used.modelId) === undefined) {
              check(false, `${what}: no such model`);
              continue;
            }
            // Such as the browser extension's own model, which may be another provider's.
            const auth = await models.checkAuth(used.provider).catch(() => undefined);
            check(auth !== undefined, `${what}: credentials ${auth?.source ?? "missing"}`);
            if (options.ping && auth !== undefined)
              await ping(models, what, used.provider, used.modelId);
          }
        }
      } catch (error) {
        check(false, `${assistant.name}: extensions: ${(error as Error).message}`);
      }
    }
    const model = models.getModel(ref.provider, ref.modelId);
    if (model === undefined) {
      check(false, `${label}: no such model`);
      continue;
    }
    const auth = await models.checkAuth(ref.provider).catch(() => undefined);
    check(auth !== undefined, `${label}: credentials ${auth?.source ?? "missing"}`);
    if (options.ping && auth !== undefined) await ping(models, label, ref.provider, ref.modelId);
  }
  return ok;
}

/** The local model (ADR 14): its files, their hashes, and that it finds a name the rules miss. */
async function checkDeep(
  check: (passed: boolean, text: string) => void,
  dir: string,
  mode: "required" | "preferred",
): Promise<void> {
  const problems = await checkLocalModel(dir);
  if (problems.length > 0) {
    const missing = problems.every((problem) => problem.includes("missing"));
    check(
      mode === "preferred",
      missing
        ? `local name finder: not downloaded yet to ${localModelDir(dir)}; nudge serve and nudge chat download it (about 260 MB)${mode === "required" ? ", and refuse requests until then" : ""}`
        : `local name finder: ${problems.join("; ")}`,
    );
    return;
  }
  try {
    const model = await openLocalModel(localModelDir(dir));
    try {
      const sample = "Vi har time hos Vethjem på torsdag.";
      const started = performance.now();
      const [found = []] = await model.find([sample]);
      const ms = Math.round(performance.now() - started);
      const names = found.map((finding) => sample.slice(finding.start, finding.end));
      check(
        names.some((name) => name.includes("Vethjem")),
        `local name finder: ${LOCAL_MODEL.name} found ${JSON.stringify(names)} in ${ms} ms`,
      );
    } finally {
      await model.close?.();
    }
  } catch (error) {
    check(false, `local name finder: ${(error as Error).message}`);
  }
}

const PRIVACY_SAMPLES: readonly (readonly [string, string])[] = [
  ["email", "kari.nordmann@example.no"],
  ["phone", "+47 912 34 567"],
  ["phone", "912 34 567"],
  ["IBAN", "NO93 8601 1117 947"],
  ["card", "4111 1111 1111 1111"],
  ["fødselsnummer", "15059012387"],
  ["account", "8601.11.17947"],
  ["API key", "sk-ant-api03-abcdefghijklmnopqrstuvwxyz012345"],
  ["password", "passord: Hemmelig123"],
];
