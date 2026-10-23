import { type ChildProcess, fork } from "node:child_process";
import { createHash } from "node:crypto";
import { createReadStream, existsSync } from "node:fs";
import { mkdir, open, rename, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { availableParallelism } from "node:os";
import {
  type DeepDetector,
  type DeepFinding,
  DeepUnavailable,
  LABEL_KINDS,
  pendingDeepDetector,
} from "./detector.ts";
import type { GlinerSpan } from "./gliner.ts";

/**
 * The model files, pinned by hash: urchade/gliner_multi-v2.1 (Apache-2.0), made smaller by
 * `scripts/local-model.py` from onnx-community's export. Its vocabulary keeps the pieces in Latin
 * script, its embedding is stored in 4 bits and its encoder in 8, weights only, so it holds about
 * 650 MB in memory instead of 1.7 GB and finds the same names. Published with the releases.
 */
export const LOCAL_MODEL = {
  name: "gliner_multi-v2.1-latin-w8e4",
  base: "https://github.com/lum1n/nudge/releases/download/local-model-1",
  files: [
    {
      name: "model.onnx",
      from: "model.onnx",
      sha256: "af58971924650472c2b71c748d0b9e9e5601032d2d401446833e46cb8c333ca8",
      bytes: 250_900_318,
    },
    {
      name: "tokenizer.json",
      from: "tokenizer.json",
      sha256: "279c3d707c215131d0820b37eb7f4593e3acb3453b43667a8bb031a062f59580",
      bytes: 4_743_038,
    },
    {
      name: "tokenizer_config.json",
      from: "tokenizer_config.json",
      sha256: "f3ddc3886ad3c5a0e8440aa326ba52265fcf6c4a0ec4db32b57e2a840ee5ea2f",
      bytes: 1_613,
    },
  ],
} as const;

/** How long the model stays loaded with nothing to read; it starts again in about a second. */
export const IDLE_MS = 2 * 60_000;

/**
 * The score a finding needs, per kind. Names lower: they matter most, and at 0.3 the model misses
 * fewer without hiding much more; higher for the rest hides fewer shops and sights the model needs
 * (packages/core/eval/privacy).
 */
export const THRESHOLDS: Readonly<Record<string, number>> = {
  NAME: 0.3,
  ADDRESS: 0.5,
  PLACE: 0.5,
  ORG: 0.5,
};

/**
 * Words of short pieces read in one call. Its cost is mostly per call, so this reads twice as
 * fast, and the lines around one help the model as much as they hurt (packages/core/eval/privacy).
 */
export const PACK_WORDS = 50;

/** Names the model and how it reads, as `DeepDetector.id`, so a change reads text again. */
export function localModelId(): string {
  const thresholds = Object.entries(THRESHOLDS)
    .map(([kind, score]) => `${kind}${score}`)
    .join(",");
  return `${LOCAL_MODEL.name}@${LOCAL_MODEL.files[0].sha256.slice(0, 12)}/${thresholds}/pack${PACK_WORDS}`;
}

/**
 * The local model for a server: downloaded into `modelsDir` if it isn't there, then started. Ready
 * at once for requests, which wait a little for it and fail while it is still downloading.
 */
export function startLocalModel(
  modelsDir: string,
  say: (line: string) => void = () => {},
): DeepDetector {
  const loading = ensureLocalModel(modelsDir, say).then((dir) => openLocalModel(dir));
  loading.catch((error: unknown) =>
    say(`The local name finder could not start: ${(error as Error).message}`),
  );
  return pendingDeepDetector(localModelId(), loading);
}

/** Where the model's files go under `modelsDir`. */
export function localModelDir(modelsDir: string): string {
  return join(modelsDir, LOCAL_MODEL.name);
}

/**
 * Downloads the model's files into `localModelDir(modelsDir)` unless they are there, each checked
 * against its hash before it takes its name. A file that was checked once is trusted by its size;
 * `checkLocalModel` checks the hashes again.
 */
export async function ensureLocalModel(
  modelsDir: string,
  say: (line: string) => void = () => {},
): Promise<string> {
  const dir = localModelDir(modelsDir);
  await mkdir(dir, { recursive: true });
  for (const file of LOCAL_MODEL.files) {
    const path = join(dir, file.name);
    if (await present(path, file)) continue;
    say(`Downloading the local name finder (${file.name})…`);
    const part = `${path}.${process.pid}.part`;
    try {
      const response = await fetch(`${LOCAL_MODEL.base}/${file.from}`, {
        signal: AbortSignal.timeout(30 * 60_000),
      });
      if (!response.ok || response.body === null)
        throw new Error(`${file.name} answered ${response.status}`);
      const hash = createHash("sha256");
      const out = await open(part, "w");
      try {
        for await (const chunk of response.body) {
          hash.update(chunk);
          await out.write(chunk);
        }
      } finally {
        await out.close();
      }
      if (hash.digest("hex") !== file.sha256)
        throw new Error(`${file.name} isn't the file Nudge names`);
      await rename(part, path);
    } finally {
      await rm(part, { force: true });
    }
  }
  return dir;
}

async function present(path: string, file: (typeof LOCAL_MODEL.files)[number]): Promise<boolean> {
  const stats = await stat(path).catch(() => undefined);
  if (stats === undefined) return false;
  return stats.size === file.bytes;
}

/** What is wrong with the downloaded model, hashes included; empty when it is all there. */
export async function checkLocalModel(modelsDir: string): Promise<string[]> {
  const dir = localModelDir(modelsDir);
  const problems: string[] = [];
  for (const file of LOCAL_MODEL.files) {
    const path = join(dir, file.name);
    if (!existsSync(path)) {
      problems.push(`${file.name} is missing from ${dir}`);
      continue;
    }
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
    if (hash.digest("hex") !== file.sha256) problems.push(`${file.name} in ${dir} is damaged`);
  }
  return problems;
}

type Reply =
  | { readonly ready: true }
  | { readonly failed: string }
  | { readonly id: number; readonly found: GlinerSpan[][] }
  | { readonly id: number; readonly error: string };

/**
 * Runs the model in `dir` in a child process. It stops after `idleMs` without calls, so an idle
 * server holds none of its memory, and starts again on the next call, as after it dies; calls
 * waiting when it dies fail with `DeepUnavailable`.
 */
export async function openLocalModel(
  dir: string,
  options: {
    readonly threads?: number;
    /** Stops the process after this long without a call; default `IDLE_MS`. */
    readonly idleMs?: number;
  } = {},
): Promise<DeepDetector> {
  const idleMs = options.idleMs ?? IDLE_MS;
  let idle: NodeJS.Timeout | undefined;
  const threads = options.threads ?? Math.max(1, Math.min(4, availableParallelism() - 1));
  const lowest = Math.min(...Object.values(THRESHOLDS));
  const worker = new URL(
    import.meta.url.endsWith(".ts") ? "./worker.ts" : "./worker.js",
    import.meta.url,
  );
  let child: Promise<ChildProcess> | undefined;
  let next = 0;
  const waiting = new Map<
    number,
    { resolve: (found: GlinerSpan[][]) => void; reject: (error: Error) => void }
  >();

  const start = () =>
    new Promise<ChildProcess>((resolve, reject) => {
      const process_ = fork(worker, [dir, String(threads), String(lowest), String(PACK_WORDS)], {
        stdio: ["ignore", "ignore", "inherit", "ipc"],
        execArgv: [],
      });
      process_.on("message", (reply: Reply) => {
        if ("ready" in reply) {
          // Idle, it keeps no one waiting: a command that is done exits.
          process_.unref();
          process_.channel?.unref();
          resolve(process_);
        } else if ("failed" in reply) reject(new DeepUnavailable(reply.failed));
        else {
          const call = waiting.get(reply.id);
          waiting.delete(reply.id);
          if (waiting.size === 0) process_.channel?.unref();
          if ("error" in reply) call?.reject(new Error(reply.error));
          else call?.resolve(reply.found);
        }
      });
      process_.on("exit", (code, signal) => {
        child = undefined;
        const why = new DeepUnavailable(
          `The local name finder stopped (${signal ?? `exit ${code}`})`,
        );
        reject(why);
        for (const call of waiting.values()) call.reject(why);
        waiting.clear();
      });
    });

  /** Stops the process once nothing has called for `idleMs`. */
  const rest = () => {
    if (waiting.size > 0) return;
    clearTimeout(idle);
    idle = setTimeout(() => {
      if (waiting.size === 0) void child?.then((running) => running.kill()).catch(() => {});
    }, idleMs);
    idle.unref();
  };

  child = start();
  await child;
  rest();
  return {
    id: localModelId(),
    async find(texts) {
      if (texts.length === 0) return [];
      clearTimeout(idle);
      child ??= start();
      const running = await child;
      const id = next++;
      const found = await new Promise<GlinerSpan[][]>((resolve, reject) => {
        waiting.set(id, { resolve, reject });
        running.channel?.ref();
        running.send({ id, texts });
      }).finally(rest);
      return found.map((spans) =>
        spans.flatMap((span): DeepFinding[] => {
          const kind = LABEL_KINDS[span.label];
          return kind === undefined || span.score < (THRESHOLDS[kind] ?? lowest)
            ? []
            : [{ start: span.start, end: span.end, kind, score: span.score }];
        }),
      );
    },
    async close() {
      clearTimeout(idle);
      const running = await child?.catch(() => undefined);
      running?.kill();
    },
  };
}
