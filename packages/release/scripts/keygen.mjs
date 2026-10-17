// Makes the project's release signing key (ADR 11), once:
//   node packages/release/scripts/keygen.mjs
// Keep the private key as the repository's NUDGE_RELEASE_KEY secret, and nowhere else; put the
// public key first in RELEASE_KEYS (packages/core/src/server/updates.ts). Servers built with it
// then install only releases this key signed.
import { generateKeyPairSync } from "node:crypto";

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
console.log("Public key, for RELEASE_KEYS:\n");
console.log(`  "${publicKey.export({ format: "der", type: "spki" }).toString("base64")}",\n`);
console.log("Private key, for the NUDGE_RELEASE_KEY secret:\n");
console.log(privateKey.export({ format: "pem", type: "pkcs8" }));
