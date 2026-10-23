import { builtinDetectors, type Span } from "./privacy/detectors.ts";

export const LOG_LEVELS = ["debug", "info", "warn", "error"] as const;
export type LogLevel = (typeof LOG_LEVELS)[number];
/** `json`: one object per line, for a machine; `text`: one readable line, for a terminal. */
export type LogFormat = "json" | "text";

/**
 * What a line says beyond its message, such as `{ assistant, room, route }`. Only names and ids
 * belong here, never what people wrote, tokens or keys; strings are scrubbed all the same.
 */
export type LogFields = Readonly<Record<string, string | number | boolean | undefined>>;

export type Logger = {
  debug(message: string, fields?: LogFields): void;
  info(message: string, fields?: LogFields): void;
  warn(message: string, fields?: LogFields): void;
  error(message: string, fields?: LogFields): void;
  /** The same logger, with `fields` on every line. */
  with(fields: LogFields): Logger;
};

export type LoggerOptions = {
  /** Lines below it are dropped. Default "info". */
  readonly level?: LogLevel;
  /** Default "json". */
  readonly format?: LogFormat;
  /** Where a finished line goes; default `console.error`, so stdout stays for what commands print. */
  readonly write?: (line: string) => void;
  readonly now?: () => number;
};

/** A logger that writes one line per call at `level` and above, every string scrubbed first. */
export function createLogger(options: LoggerOptions = {}, bound: LogFields = {}): Logger {
  const min = LOG_LEVELS.indexOf(options.level ?? "info");
  const format = options.format ?? "json";
  const write = options.write ?? ((line: string) => console.error(line));
  const now = options.now ?? Date.now;
  const at =
    (level: LogLevel) =>
    (message: string, fields: LogFields = {}): void => {
      if (LOG_LEVELS.indexOf(level) < min) return;
      const all: Record<string, string | number | boolean> = {};
      for (const [key, value] of Object.entries({ ...bound, ...fields }))
        if (value !== undefined) all[key] = typeof value === "string" ? scrubLog(value) : value;
      const time = new Date(now()).toISOString();
      const text = scrubLog(message);
      write(
        format === "json"
          ? JSON.stringify({ time, level, msg: text, ...all })
          : [time, level.toUpperCase(), text, ...Object.entries(all).map(([k, v]) => `${k}=${v}`)]
              .join(" ")
              .replace(/\n/g, "\n    "),
      );
    };
  return {
    debug: at("debug"),
    info: at("info"),
    warn: at("warn"),
    error: at("error"),
    with: (fields) => createLogger(options, { ...bound, ...fields }),
  };
}

/**
 * A logger as the environment asks: `NUDGE_LOG_LEVEL` (debug, info, warn, error; default info)
 * and `NUDGE_LOG_FORMAT` (json or text; default text on a terminal, json otherwise).
 */
export function loggerFromEnv(
  env: Readonly<Record<string, string | undefined>>,
  terminal = false,
  write?: (line: string) => void,
): Logger {
  const level = env.NUDGE_LOG_LEVEL?.trim().toLowerCase();
  const format = env.NUDGE_LOG_FORMAT?.trim().toLowerCase();
  return createLogger({
    level: LOG_LEVELS.includes(level as LogLevel) ? (level as LogLevel) : "info",
    format: format === "json" || format === "text" ? format : terminal ? "text" : "json",
    ...(write === undefined ? {} : { write }),
  });
}

/** An error's name, message and stack, as fields for a line. */
export function errorFields(error: unknown): LogFields {
  if (!(error instanceof Error)) return { error: String(error) };
  return { error: error.name, detail: error.message, stack: error.stack };
}

/**
 * `text` with what the built-in detectors find (keys, tokens, passwords, emails, phone numbers,
 * card and account numbers) replaced by its kind, as `[SECRET]`: errors can echo a request back.
 */
export function scrubLog(text: string): string {
  const spans: (Span & { kind: string })[] = [];
  for (const detector of builtinDetectors)
    for (const span of detector.find(text)) spans.push({ ...span, kind: detector.kind });
  if (spans.length === 0) return text;
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  let out = "";
  let at = 0;
  for (const span of spans) {
    if (span.start < at) continue;
    out += `${text.slice(at, span.start)}[${span.kind}]`;
    at = span.end;
  }
  return out + text.slice(at);
}
