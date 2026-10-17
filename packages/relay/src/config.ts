import { randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { Apns, Fcm, type ServiceAccount } from "@nudge/ext-push";
import { type Static, Type } from "typebox";
import { Value } from "typebox/value";
import type { RelayOptions } from "./relay.ts";

/** `relay.json`: what the relay sends with. Paths are relative to the file. */
export const RelayConfig = Type.Object({
  /** The key handles are encrypted with, 32 bytes; made on first start. Default relay-handle.key. */
  handleKeyFile: Type.Optional(Type.String({ minLength: 1 })),
  apns: Type.Optional(
    Type.Object({
      keyFile: Type.String({ minLength: 1 }),
      keyId: Type.String({ minLength: 1 }),
      teamId: Type.String({ minLength: 1 }),
      bundleId: Type.String({ minLength: 1 }),
    }),
  ),
  fcm: Type.Optional(Type.Object({ serviceAccountFile: Type.String({ minLength: 1 }) })),
  /** Behind a proxy: take the sender's address from the first X-Forwarded-For. */
  trustProxy: Type.Optional(Type.Boolean()),
  perAddressPerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
  perDevicePerMinute: Type.Optional(Type.Integer({ minimum: 1 })),
});
export type RelayConfig = Static<typeof RelayConfig>;

export function loadRelayConfig(path: string): RelayOptions {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8"));
  } catch (error) {
    throw new Error(`Can't read ${path}: ${(error as Error).message}`);
  }
  if (!Value.Check(RelayConfig, value)) {
    const problems = [...Value.Errors(RelayConfig, value)]
      .slice(0, 5)
      .map((error) => `${error.instancePath || "/"} ${error.message}`);
    throw new Error(`Invalid ${path}:\n  ${problems.join("\n  ")}`);
  }
  const base = dirname(resolve(path));
  const file = (name: string) => resolve(base, name);
  return {
    handleKey: handleKey(file(value.handleKeyFile ?? "relay-handle.key")),
    ...(value.apns === undefined
      ? {}
      : {
          apns: new Apns({
            key: readFileSync(file(value.apns.keyFile), "utf8"),
            keyId: value.apns.keyId,
            teamId: value.apns.teamId,
            bundleId: value.apns.bundleId,
          }),
        }),
    ...(value.fcm === undefined
      ? {}
      : {
          fcm: new Fcm({
            serviceAccount: JSON.parse(
              readFileSync(file(value.fcm.serviceAccountFile), "utf8"),
            ) as ServiceAccount,
          }),
        }),
    ...(value.trustProxy === true
      ? {
          address: (c) =>
            c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ??
            c.env?.incoming?.socket?.remoteAddress ??
            "",
        }
      : {}),
    ...(value.perAddressPerMinute === undefined
      ? {}
      : { perAddressPerMinute: value.perAddressPerMinute }),
    ...(value.perDevicePerMinute === undefined
      ? {}
      : { perDevicePerMinute: value.perDevicePerMinute }),
  };
}

/** The handle key in `file`, made on first start; keep it in backups, or apps register anew. */
function handleKey(file: string): Buffer {
  try {
    const key = Buffer.from(readFileSync(file, "utf8").trim(), "base64");
    if (key.length !== 32) throw new Error(`${file} is not a 32-byte key in base64`);
    return key;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const key = randomBytes(32);
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, `${key.toString("base64")}\n`, { mode: 0o600, flag: "wx" });
  return key;
}
