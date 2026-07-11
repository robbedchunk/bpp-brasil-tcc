import {
  createHash,
  createPrivateKey,
  createPublicKey,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";
import {
  lstatSync,
  readFileSync,
  readlinkSync,
  readdirSync,
  statSync,
} from "node:fs";
import { fileURLToPath } from "node:url";
import { basename, join, relative, resolve, sep } from "node:path";

import { z } from "zod";

const Sha256Schema = z.string().regex(/^[a-f0-9]{64}$/u);
const CommitSchema = z.string().regex(/^[a-f0-9]{40}$/u);
const ReleaseIdSchema = z.string().regex(/^[a-f0-9]{32}$/u);
const AbsolutePathSchema = z.string().refine(
  (value) => !/[\0\r\n]/u.test(value) && resolve(value) === value,
  {
    message: "Release paths must be absolute and normalized",
  },
);
const RelativePathSchema = z.string().min(1).refine((value) => {
  if (value.startsWith("/") || value.includes("\\") || value.includes("\0")) return false;
  const segments = value.split("/");
  return segments.every((segment) => segment !== "" && segment !== "." && segment !== "..");
}, { message: "Artifact paths must be safe normalized relative paths" });

export const ReleaseArtifactSchema = z.object({
  path: RelativePathSchema,
  sha256: Sha256Schema,
  bytes: z.number().int().nonnegative(),
  mode: z.number().int().min(0).max(0o777),
}).strict();

export const ReleaseStateLinkSchema = z.object({
  path: z.enum(["data", "var", "analysis/output", "node_modules"]),
  target: AbsolutePathSchema,
  purpose: z.enum(["state", "analysis-output", "dependencies"]),
}).strict();

export const ReleaseManifestPayloadSchema = z.object({
  schemaVersion: z.literal(1),
  releaseId: ReleaseIdSchema,
  sourceCommit: CommitSchema,
  deployedAt: z.string().datetime({ offset: true }),
  releasePath: AbsolutePathSchema,
  sourceRoot: AbsolutePathSchema,
  stateRoot: AbsolutePathSchema,
  artifactSetSha256: Sha256Schema,
  artifacts: z.array(ReleaseArtifactSchema).min(1),
  links: z.array(ReleaseStateLinkSchema).length(4),
}).strict();

const ReleaseSignatureSchema = z.object({
  algorithm: z.literal("ed25519"),
  keyId: Sha256Schema,
  payloadSha256: Sha256Schema,
  value: z.string().regex(/^[A-Za-z0-9+/]{86}==$/u),
}).strict();

export const ReleaseManifestSchema = ReleaseManifestPayloadSchema.extend({
  signature: ReleaseSignatureSchema,
}).strict();

export type ReleaseArtifact = z.infer<typeof ReleaseArtifactSchema>;
export type ReleaseStateLink = z.infer<typeof ReleaseStateLinkSchema>;
export type ReleaseManifestPayload = z.infer<typeof ReleaseManifestPayloadSchema>;
export type ReleaseManifest = z.infer<typeof ReleaseManifestSchema>;

function canonicalValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonicalValue);
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right, "en"))
      .map(([key, child]) => [key, canonicalValue(child)]));
  }
  return value;
}

export function canonicalReleaseJson(value: unknown): string {
  return JSON.stringify(canonicalValue(value));
}

function sha256(value: string | Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

export function releaseArtifactSetSha256(artifacts: readonly ReleaseArtifact[]): string {
  return sha256(artifacts.map((artifact) =>
    `${artifact.path}\0${artifact.sha256}\0${artifact.bytes}\0${artifact.mode}\n`).join(""));
}

function verificationKey(key: KeyObject): KeyObject {
  return key.type === "public" ? key : createPublicKey(key);
}

export function releaseSigningKeyId(key: KeyObject): string {
  const der = verificationKey(key).export({ type: "spki", format: "der" });
  return sha256(der);
}

export function signReleaseManifest(
  input: ReleaseManifestPayload,
  privateKey: KeyObject,
): ReleaseManifest {
  if (privateKey.type !== "private" || privateKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing key must be an Ed25519 private key");
  }
  const payload = ReleaseManifestPayloadSchema.parse(input);
  const canonical = canonicalReleaseJson(payload);
  return ReleaseManifestSchema.parse({
    ...payload,
    signature: {
      algorithm: "ed25519",
      keyId: releaseSigningKeyId(privateKey),
      payloadSha256: sha256(canonical),
      value: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
    },
  });
}

export function readReleaseSigningPrivateKey(path: string): KeyObject {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o777) !== 0o600) {
    throw new Error("Release signing key must be a regular mode-0600 file");
  }
  const key = createPrivateKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Release signing key must be Ed25519");
  }
  return key;
}

export function readReleaseVerificationPublicKey(path: string): KeyObject {
  const stat = lstatSync(path);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error("Release verification key must be a regular file");
  }
  const key = createPublicKey(readFileSync(path));
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Release verification key must be Ed25519");
  }
  return key;
}

function payloadOf(manifest: ReleaseManifest): ReleaseManifestPayload {
  const { signature: _signature, ...payload } = manifest;
  return ReleaseManifestPayloadSchema.parse(payload);
}

export function verifyReleaseManifestSignature(
  manifest: ReleaseManifest,
  publicKey: KeyObject,
): void {
  if (publicKey.type !== "public" || publicKey.asymmetricKeyType !== "ed25519") {
    throw new Error("Release verification key must be an Ed25519 public key");
  }
  const payload = payloadOf(manifest);
  const canonical = canonicalReleaseJson(payload);
  if (
    manifest.signature.keyId !== releaseSigningKeyId(publicKey)
    || manifest.signature.payloadSha256 !== sha256(canonical)
    || !verify(null, Buffer.from(canonical), publicKey, Buffer.from(manifest.signature.value, "base64"))
  ) {
    throw new Error("Release manifest signature is invalid");
  }
}

function listReleaseEntries(root: string): { files: string[]; links: string[]; directories: string[] } {
  const files: string[] = [];
  const links: string[] = [];
  const directories: string[] = [];
  const visit = (directory: string): void => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) links.push(path);
      else if (stat.isDirectory()) {
        directories.push(path);
        visit(absolute);
      } else if (stat.isFile()) files.push(path);
      else throw new Error(`Release contains unsupported filesystem entry: ${path}`);
    }
  };
  visit(root);
  return { files, links, directories };
}

export interface ValidateReleaseOptions {
  releasePath: string;
  /** Trusted verification key outside the release being validated. */
  publicKeyPath: string;
  expectedSourceCommit?: string;
  expectedReleaseId?: string;
  expectedSourceRoot?: string;
}

/** Strictly validates the signed manifest, complete artifact set, links, and read-only boundary. */
export function validateFrozenRelease(options: ValidateReleaseOptions): ReleaseManifest {
  const releasePath = resolve(options.releasePath);
  const manifestPath = join(releasePath, "release-manifest.json");
  const manifestStat = lstatSync(manifestPath);
  if (!manifestStat.isFile() || manifestStat.isSymbolicLink() || (manifestStat.mode & 0o222) !== 0) {
    throw new Error("Release manifest must be a read-only regular file");
  }
  const manifest = ReleaseManifestSchema.parse(JSON.parse(readFileSync(manifestPath, "utf8")));
  const trustedPublicKeyPath = resolve(options.publicKeyPath);
  if (trustedPublicKeyPath === releasePath
    || trustedPublicKeyPath.startsWith(`${releasePath}${sep}`)) {
    throw new Error("Release verification key must be an external trust anchor");
  }
  verifyReleaseManifestSignature(
    manifest,
    readReleaseVerificationPublicKey(trustedPublicKeyPath),
  );
  const copiedPublicKey = readReleaseVerificationPublicKey(
    join(releasePath, "ops", "validation-attestation-public.pem"),
  );
  if (releaseSigningKeyId(copiedPublicKey) !== manifest.signature.keyId) {
    throw new Error("Release-copy verification key does not match the trusted signing key");
  }

  if (manifest.releasePath !== releasePath
    || basename(releasePath) !== `${manifest.sourceCommit}-${manifest.releaseId}`) {
    throw new Error("Release manifest does not bind its immutable release path");
  }
  if (manifest.stateRoot !== manifest.sourceRoot) {
    throw new Error("Release stateRoot must exactly equal its sourceRoot");
  }
  if (options.expectedSourceCommit !== undefined
    && manifest.sourceCommit !== options.expectedSourceCommit) {
    throw new Error("Release source commit does not match the expected commit");
  }
  if (options.expectedReleaseId !== undefined && manifest.releaseId !== options.expectedReleaseId) {
    throw new Error("Release ID does not match the expected release");
  }
  if (options.expectedSourceRoot !== undefined
    && manifest.sourceRoot !== resolve(options.expectedSourceRoot)) {
    throw new Error("Release source root does not match the expected source root");
  }

  const artifacts = [...manifest.artifacts];
  const sortedArtifacts = [...artifacts]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (canonicalReleaseJson(artifacts) !== canonicalReleaseJson(sortedArtifacts)
    || new Set(artifacts.map((artifact) => artifact.path)).size !== artifacts.length
    || manifest.artifactSetSha256 !== releaseArtifactSetSha256(artifacts)) {
    throw new Error("Release artifact set is not canonical or its digest is invalid");
  }
  const links = [...manifest.links];
  const sortedLinks = [...links]
    .sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  if (canonicalReleaseJson(links) !== canonicalReleaseJson(sortedLinks)
    || new Set(links.map((link) => link.path)).size !== links.length) {
    throw new Error("Release state links are not canonical and unique");
  }
  const expectedLinks = new Map<string, { target: string; purpose: string }>([
    ["analysis/output", { target: join(manifest.stateRoot, "analysis", "output"), purpose: "analysis-output" }],
    ["data", { target: join(manifest.stateRoot, "data"), purpose: "state" }],
    ["node_modules", { target: join(manifest.sourceRoot, "node_modules"), purpose: "dependencies" }],
    ["var", { target: join(manifest.stateRoot, "var"), purpose: "state" }],
  ]);
  for (const link of links) {
    const expected = expectedLinks.get(link.path);
    if (expected === undefined || link.target !== expected.target || link.purpose !== expected.purpose) {
      throw new Error(`Release state link declaration is invalid: ${link.path}`);
    }
    const linkPath = join(releasePath, ...link.path.split("/"));
    const stat = lstatSync(linkPath);
    if (!stat.isSymbolicLink() || readlinkSync(linkPath) !== link.target) {
      throw new Error(`Release state link does not match its declaration: ${link.path}`);
    }
    if (!statSync(link.target).isDirectory()) {
      throw new Error(`Release state link target is not a directory: ${link.path}`);
    }
  }

  const entries = listReleaseEntries(releasePath);
  const expectedFiles = [...artifacts.map((artifact) => artifact.path), "release-manifest.json"].sort();
  const expectedDirectories = new Set<string>();
  for (const path of [...expectedFiles, ...links.map((link) => link.path)]) {
    const segments = path.split("/");
    for (let index = 1; index < segments.length; index += 1) {
      expectedDirectories.add(segments.slice(0, index).join("/"));
    }
  }
  if (canonicalReleaseJson(entries.files) !== canonicalReleaseJson(expectedFiles)
    || canonicalReleaseJson(entries.links) !== canonicalReleaseJson(links.map((link) => link.path))
    || canonicalReleaseJson(entries.directories)
      !== canonicalReleaseJson([...expectedDirectories].sort())) {
    throw new Error("Release filesystem does not exactly match its declared artifacts and links");
  }
  for (const directory of ["", ...entries.directories]) {
    if ((lstatSync(join(releasePath, directory)).mode & 0o222) !== 0) {
      throw new Error(`Release directory is writable: ${directory || "."}`);
    }
  }
  for (const artifact of artifacts) {
    const path = join(releasePath, ...artifact.path.split("/"));
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()
      || stat.size !== artifact.bytes
      || (stat.mode & 0o777) !== artifact.mode
      || (stat.mode & 0o222) !== 0
      || sha256(readFileSync(path)) !== artifact.sha256) {
      throw new Error(`Release artifact does not match its manifest: ${artifact.path}`);
    }
  }
  return manifest;
}

function runCli(): void {
  const [command, releasePath, publicKeyPath] = process.argv.slice(2);
  if (command !== "verify" || releasePath === undefined || publicKeyPath === undefined
    || process.argv.length !== 5) {
    throw new Error("usage: release-manifest verify RELEASE_PATH TRUSTED_PUBLIC_KEY_PATH");
  }
  const manifest = validateFrozenRelease({
    releasePath,
    publicKeyPath,
  });
  process.stdout.write(`${JSON.stringify({
    status: "ok",
    releaseId: manifest.releaseId,
    sourceCommit: manifest.sourceCommit,
    artifactSetSha256: manifest.artifactSetSha256,
  })}\n`);
}

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    runCli();
  } catch (error) {
    process.stderr.write(`release-manifest: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  }
}
