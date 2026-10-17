import { createCipheriv, createDecipheriv, randomBytes, scryptSync } from "node:crypto";

/** scrypt's cost: about a tenth of a second here, and as much for anyone guessing passphrases. */
const SCRYPT = { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 } as const;

type Kit = {
  nudge: "recovery-kit";
  v: 1;
  /** Where it came from, to tell kits apart. */
  server?: string;
  createdAt: string;
  salt: string;
  iv: string;
  tag: string;
  data: string;
};

export class RecoveryKitError extends Error {
  override name = "RecoveryKitError";
}

/**
 * The recovery kit (ADR 11): the backup key, sealed with a passphrase the owner chose, as a small
 * JSON file to keep apart from the server and its backups. With a backup, it brings back the whole
 * server: every database comes with its key file, every extension with its secrets.
 */
export function sealRecoveryKit(backupKey: Buffer, passphrase: string, server?: string): string {
  if (passphrase.length < 8)
    throw new RecoveryKitError("The passphrase needs 8 characters or more");
  const salt = randomBytes(16);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", scryptSync(passphrase, salt, 32, SCRYPT), iv);
  const data = Buffer.concat([cipher.update(backupKey), cipher.final()]);
  const kit: Kit = {
    nudge: "recovery-kit",
    v: 1,
    ...(server === undefined ? {} : { server }),
    createdAt: new Date().toISOString(),
    salt: salt.toString("base64"),
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    data: data.toString("base64"),
  };
  return `${JSON.stringify(kit, null, 2)}\n`;
}

/** The backup key in a recovery kit; a wrong passphrase or a changed kit is a `RecoveryKitError`. */
export function openRecoveryKit(text: string, passphrase: string): Buffer {
  let kit: Kit;
  try {
    kit = JSON.parse(text) as Kit;
  } catch {
    throw new RecoveryKitError("That is not a recovery kit");
  }
  if (kit.nudge !== "recovery-kit" || kit.v !== 1)
    throw new RecoveryKitError("That is not a recovery kit");
  try {
    const key = scryptSync(passphrase, Buffer.from(kit.salt, "base64"), 32, SCRYPT);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(kit.iv, "base64"));
    decipher.setAuthTag(Buffer.from(kit.tag, "base64"));
    return Buffer.concat([decipher.update(Buffer.from(kit.data, "base64")), decipher.final()]);
  } catch {
    throw new RecoveryKitError("Wrong passphrase, or the kit was changed");
  }
}
