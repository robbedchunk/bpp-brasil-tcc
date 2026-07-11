#!/usr/bin/env node

import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
} from "node:crypto";
import { lstatSync, readFileSync } from "node:fs";

const [payloadPath, privateKeyPath] = process.argv.slice(2);
if (payloadPath === undefined || privateKeyPath === undefined || process.argv.length !== 4) {
  throw new Error("usage: create-fresh-clone-receipt PAYLOAD_JSON PRIVATE_KEY");
}

const keyMetadata = lstatSync(privateKeyPath);
if (!keyMetadata.isFile() || keyMetadata.isSymbolicLink() || (keyMetadata.mode & 0o777) !== 0o600) {
  throw new Error("fresh-clone signing key must be a regular mode-0600 file");
}
const privateKey = createPrivateKey(readFileSync(privateKeyPath));
if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
  throw new Error("fresh-clone signing key must be Ed25519");
}

const canonicalValue = (value) => {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
};
const canonical = JSON.stringify(canonicalValue(JSON.parse(readFileSync(payloadPath, "utf8"))));
const publicKey = createPublicKey(privateKey);
const keyDer = publicKey.export({ type: "spki", format: "der" });
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const payload = JSON.parse(canonical);
process.stdout.write(`${JSON.stringify({
  ...payload,
  attestation: {
    algorithm: "ed25519",
    keyId: sha256(keyDer),
    payloadSha256: sha256(canonical),
    signature: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
  },
})}\n`);
