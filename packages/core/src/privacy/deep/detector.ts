import type { Span } from "../detectors.ts";

/** A value the model found, with the kind it names in a placeholder (`NAME`, `PLACE`, …). */
export type DeepFinding = Span & { readonly kind: string; readonly score: number };

/**
 * A local model that finds names, places and organisations the rules miss, such as "hos Vethjem"
 * (ADR 22). Asynchronous, unlike `PiiDetector`: what it finds goes into the vault, and exact
 * matching hides it from then on.
 */
export type DeepDetector = {
  /** Names the model and its settings, so a change looks at text again. */
  readonly id: string;
  /** What each text holds, in order. Throws `DeepUnavailable` when the model can't run now. */
  find(texts: readonly string[]): Promise<DeepFinding[][]>;
  close?(): Promise<void>;
};

/** The model isn't there yet (still downloading) or failed to start. */
export class DeepUnavailable extends Error {
  override name = "DeepUnavailable";
}

/** Model labels and the placeholder kind each becomes. */
export const LABEL_KINDS: Readonly<Record<string, string>> = {
  person: "NAME",
  "street address": "ADDRESS",
  city: "PLACE",
  location: "PLACE",
  organization: "ORG",
  school: "ORG",
  kindergarten: "ORG",
  company: "ORG",
};

/**
 * A detector that is ready once `loading` is. A call waits up to `waitMs` for it, then throws
 * `DeepUnavailable` saying why, as it does once loading failed. For a server that downloads the
 * model while it starts.
 */
export function pendingDeepDetector(
  id: string,
  loading: Promise<DeepDetector>,
  waitMs = 20_000,
): DeepDetector {
  let ready: DeepDetector | undefined;
  let failed: string | undefined;
  loading.then(
    (detector) => {
      ready = detector;
    },
    (error: unknown) => {
      failed = error instanceof Error ? error.message : String(error);
    },
  );
  return {
    id,
    async find(texts) {
      if (ready === undefined && failed === undefined) {
        let timer: NodeJS.Timeout | undefined;
        await Promise.race([
          loading.catch(() => {}),
          new Promise((resolve) => {
            timer = setTimeout(resolve, waitMs);
          }),
        ]);
        clearTimeout(timer);
      }
      if (ready !== undefined) return ready.find(texts);
      throw new DeepUnavailable(
        failed === undefined
          ? "The local name finder is still downloading"
          : `The local name finder could not start: ${failed}`,
      );
    },
    async close() {
      await loading.then((detector) => detector.close?.()).catch(() => {});
    },
  };
}
