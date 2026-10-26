import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { SecretStore } from "./secrets.ts";

/**
 * Passwords and tokens in extension settings, kept out of `nudge.json`. A setting whose schema
 * says `writeOnly: true` is stored encrypted in `server/settings-secrets` beside the config, and
 * the config holds `${secret:<id>}` in its place; parsing the config puts the value back. Values
 * written as `${NAME}` stay as they are: the environment holds those.
 */
export class SettingSecrets {
  private store: SecretStore | undefined;

  constructor(private readonly baseDir: string) {}

  /** Made on first use, so a config without secrets leaves no directory behind. */
  private opened(): SecretStore {
    return (this.store ??= new SecretStore(join(this.baseDir, "server", "settings-secrets")));
  }

  /** Whether anything was ever stored, without making the directory. */
  private exists(): boolean {
    return this.store !== undefined || existsSync(join(this.baseDir, "server", "settings-secrets"));
  }

  get(assistant: string, id: string): string | undefined {
    return this.exists() ? this.opened().get(scopeOf(assistant), id) : undefined;
  }

  /** Stores `value` and returns the reference the config holds instead. */
  put(assistant: string, value: string): string {
    const id = randomBytes(9).toString("base64url");
    this.opened().set(scopeOf(assistant), id, value);
    return `\${secret:${id}}`;
  }

  /** Drops the assistant's secrets that `keep` doesn't name, such as after a setting changed. */
  prune(assistant: string, keep: ReadonlySet<string>): void {
    if (!this.exists()) return;
    for (const id of this.opened().names(scopeOf(assistant)))
      if (!keep.has(id)) this.opened().delete(scopeOf(assistant), id);
  }
}

const scopeOf = (assistant: string) => `assistant:${assistant}`;
const REFERENCE = /^\$\{secret:([A-Za-z0-9_-]+)\}$/;
/** `${NAME}`: from the environment, so not a value to store. */
const VARIABLE = /\$\{[A-Za-z_][A-Za-z0-9_]*\}/;

type Schema = {
  writeOnly?: boolean;
  properties?: Record<string, Schema>;
  items?: Schema;
  allOf?: Schema[];
  anyOf?: Schema[];
  oneOf?: Schema[];
};

/**
 * `value` with every `writeOnly` string in `schema` that is a plain value stored through `put` and
 * replaced by its reference. References and `${NAME}` values are left alone.
 */
export function sealSecrets(
  schema: unknown,
  value: unknown,
  put: (secret: string) => string,
): unknown {
  if (typeof schema !== "object" || schema === null) return value;
  const s = schema as Schema;
  if (typeof value === "string" && s.writeOnly === true)
    return value === "" || REFERENCE.test(value) || VARIABLE.test(value) ? value : put(value);
  let next = value;
  for (const branch of [...(s.allOf ?? []), ...(s.anyOf ?? []), ...(s.oneOf ?? [])])
    next = sealSecrets(branch, next, put);
  if (Array.isArray(next) && s.items !== undefined)
    return next.map((item) => sealSecrets(s.items, item, put));
  if (isRecord(next) && s.properties !== undefined) {
    const sealed: Record<string, unknown> = { ...next };
    for (const [key, property] of Object.entries(s.properties))
      if (key in sealed) sealed[key] = sealSecrets(property, sealed[key], put);
    return sealed;
  }
  return next;
}

/** `value` with each `${secret:<id>}` replaced by what `get` has; `missing` names those it hasn't. */
export function openSecrets(
  value: unknown,
  get: (id: string) => string | undefined,
): { value: unknown; missing: string[] } {
  const missing: string[] = [];
  const visit = (item: unknown): unknown => {
    if (typeof item === "string") {
      const id = REFERENCE.exec(item)?.[1];
      if (id === undefined) return item;
      const secret = get(id);
      if (secret === undefined) missing.push(id);
      return secret ?? item;
    }
    if (Array.isArray(item)) return item.map(visit);
    if (isRecord(item))
      return Object.fromEntries(Object.entries(item).map(([key, v]) => [key, visit(v)]));
    return item;
  };
  return { value: visit(value), missing };
}

/** The ids of the references in `value`. */
export function secretReferences(value: unknown): Set<string> {
  const ids = new Set<string>();
  openSecrets(value, (id) => {
    ids.add(id);
    return "";
  });
  return ids;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
