import { constants } from "node:fs";
import { access, mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import { buildModels, DEFAULT_MODEL, loadConfig } from "@nudge/core";

export type DoctorOptions = {
  readonly config: string;
  /** Send one tiny request to each assistant's model. */
  readonly ping?: boolean;
};

/** Checks what `nudge chat` needs, printing one line per check. Returns false when something failed. */
export async function doctor(options: DoctorOptions): Promise<boolean> {
  let ok = true;
  const check = (passed: boolean, text: string) => {
    ok &&= passed;
    console.log(`${passed ? "ok  " : "FAIL"} ${text}`);
  };

  const [major = 0, minor = 0] = process.versions.node.split(".").map(Number);
  check(
    major > 22 || (major === 22 && minor >= 19),
    `Node ${process.versions.node} (needs ≥ 22.19)`,
  );

  let config;
  try {
    config = await loadConfig(options.config);
    check(true, `config ${options.config}`);
  } catch (error) {
    check(false, `config ${options.config}: ${(error as Error).message}`);
    return false;
  }

  const models = buildModels(config.providers);
  for (const assistant of config.assistants) {
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
    const model = models.getModel(ref.provider, ref.modelId);
    if (model === undefined) {
      check(false, `${label}: no such model`);
      continue;
    }
    const auth = await models.checkAuth(ref.provider).catch(() => undefined);
    check(auth !== undefined, `${label}: credentials ${auth?.source ?? "missing"}`);
    if (!options.ping || auth === undefined) continue;
    const answer = await models.completeSimple(model, {
      messages: [{ role: "user", content: "Reply with the word pong.", timestamp: Date.now() }],
    });
    const failed = answer.stopReason === "error" || answer.stopReason === "aborted";
    check(!failed, `${label}: ping ${failed ? (answer.errorMessage ?? "failed") : "answered"}`);
  }
  return ok;
}
