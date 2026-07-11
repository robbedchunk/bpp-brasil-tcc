#!/usr/bin/env node

import {
  createPublicKey,
  generateKeyPairSync,
} from "node:crypto";
import { lstatSync } from "node:fs";
import { chmod, mkdir, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Command } from "commander";

import {
  readValidationSigningPrivateKey,
  readValidationVerificationPublicKey,
  validationAttestationKeyId,
} from "../src/strategies/validation-evidence.js";

function exists(path: string): boolean {
  try {
    return lstatSync(path).isFile();
  } catch {
    return false;
  }
}

async function writeExclusive(
  path: string,
  content: string | Buffer,
  mode: number,
): Promise<void> {
  const handle = await open(path, "wx", mode);
  try {
    await handle.writeFile(content);
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function initializeValidationAttestationKeyPair(
  privatePath: string,
  publicPath: string,
): Promise<{
  privatePath: string;
  publicPath: string;
  created: boolean;
  keyId: string;
}> {
  const absolutePrivatePath = resolve(privatePath);
  const absolutePublicPath = resolve(publicPath);
  await mkdir(dirname(absolutePrivatePath), { recursive: true, mode: 0o700 });
  await mkdir(dirname(absolutePublicPath), { recursive: true });
  const privateExists = exists(absolutePrivatePath);
  const publicExists = exists(absolutePublicPath);
  if (!privateExists && publicExists) {
    throw new Error(
      "Tracked validation public key exists but its host private key is missing; restore the mode-0600 private key",
    );
  }

  let created = false;
  if (!privateExists) {
    const pair = generateKeyPairSync("ed25519");
    const privatePem = pair.privateKey.export({ type: "pkcs8", format: "pem" });
    const publicPem = pair.publicKey.export({ type: "spki", format: "pem" });
    await writeExclusive(absolutePrivatePath, privatePem, 0o600);
    if (publicExists) {
      throw new Error("Validation public key appeared during initialization");
    }
    await writeExclusive(absolutePublicPath, publicPem, 0o644);
    created = true;
  } else if (!publicExists) {
    const privateKey = readValidationSigningPrivateKey(absolutePrivatePath);
    const publicPem = createPublicKey(privateKey).export({ type: "spki", format: "pem" });
    await writeExclusive(absolutePublicPath, publicPem, 0o644);
  }

  const privateKey = readValidationSigningPrivateKey(absolutePrivatePath);
  await chmod(absolutePrivatePath, 0o600);
  await chmod(absolutePublicPath, 0o644);
  const publicKey = readValidationVerificationPublicKey(absolutePublicPath);
  if (validationAttestationKeyId(privateKey) !== validationAttestationKeyId(publicKey)) {
    throw new Error("Validation private and public keys do not form one Ed25519 pair");
  }
  return {
    privatePath: absolutePrivatePath,
    publicPath: absolutePublicPath,
    created,
    keyId: validationAttestationKeyId(publicKey),
  };
}

async function main(): Promise<void> {
  const command = new Command()
    .description("Initialize the private/public host strategy-validation Ed25519 keypair")
    .option(
      "--private-path <path>",
      "ignored mode-0600 private signing key",
      "var/operations/validation-attestation-private.pem",
    )
    .option(
      "--public-path <path>",
      "tracked public verification key",
      "ops/validation-attestation-public.pem",
    );
  command.parse(process.argv);
  const options = command.opts<{ privatePath: string; publicPath: string }>();
  const result = await initializeValidationAttestationKeyPair(
    options.privatePath,
    options.publicPath,
  );
  process.stdout.write(`${JSON.stringify(result)}\n`);
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  main().catch((error: unknown) => {
    process.stderr.write(`${error instanceof Error ? error.stack ?? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
