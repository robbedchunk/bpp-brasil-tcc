import { createHash, generateKeyPairSync } from "node:crypto";
import {
  chmod,
  lstat,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { afterEach, describe, expect, it } from "vitest";

import {
  releaseArtifactSetSha256,
  signReleaseManifest,
  validateFrozenRelease,
  type ReleaseArtifact,
} from "../../src/ops/release-manifest.js";
const sha256 = (value: Buffer): string => createHash("sha256").update(value).digest("hex");
const temporaryDirectories: string[] = [];

async function removeReadOnlyTree(path: string): Promise<void> {
  const stat = await lstat(path).catch(() => null);
  if (stat === null) return;
  if (stat.isDirectory() && !stat.isSymbolicLink()) {
    await chmod(path, 0o700);
    await Promise.all((await readdir(path)).map((name) => removeReadOnlyTree(join(path, name))));
  } else if (!stat.isSymbolicLink()) await chmod(path, 0o600);
}

afterEach(async () => Promise.all(temporaryDirectories.splice(0).map(async (path) => {
  await removeReadOnlyTree(path);
  await rm(path, { recursive: true, force: true });
})));

async function temporaryDirectory(prefix: string): Promise<string> {
  const path = await mkdtemp(join(tmpdir(), prefix));
  temporaryDirectories.push(path);
  return path;
}

async function fixture(): Promise<{
  releasePath: string;
  artifactPath: string;
  publicKeyPath: string;
}> {
  const root = await temporaryDirectory("precos-release-");
  const sourceRoot = join(root, "source");
  const sourceCommit = "a".repeat(40);
  const releaseId = "b".repeat(32);
  const releasePath = join(root, "releases", `${sourceCommit}-${releaseId}`);
  for (const path of [
    "data",
    "var",
    "analysis/output",
    "node_modules",
  ]) await mkdir(join(sourceRoot, path), { recursive: true });
  await mkdir(join(releasePath, "dist"), { recursive: true });
  await mkdir(join(releasePath, "ops"), { recursive: true });
  await mkdir(join(releasePath, "analysis"), { recursive: true });
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const artifactPath = join(releasePath, "dist", "cli.js");
  const publicKeyPath = join(releasePath, "ops", "validation-attestation-public.pem");
  const trustedPublicKeyPath = join(sourceRoot, "ops", "validation-attestation-public.pem");
  await mkdir(join(sourceRoot, "ops"), { recursive: true });
  await writeFile(artifactPath, "#!/usr/bin/env node\n", { mode: 0o755 });
  await writeFile(publicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o644 });
  await writeFile(trustedPublicKeyPath, publicKey.export({ type: "spki", format: "pem" }), { mode: 0o444 });
  await chmod(artifactPath, 0o555);
  await chmod(publicKeyPath, 0o444);
  const artifactFiles = [artifactPath, publicKeyPath];
  const artifacts: ReleaseArtifact[] = await Promise.all(artifactFiles.map(async (path) => {
    const content = await readFile(path);
    const stat = await lstat(path);
    return {
      path: path.slice(releasePath.length + 1),
      sha256: sha256(content),
      bytes: content.length,
      mode: stat.mode & 0o777,
    };
  }));
  artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
  const links = [
    { path: "analysis/output" as const, target: join(sourceRoot, "analysis/output"), purpose: "analysis-output" as const },
    { path: "data" as const, target: join(sourceRoot, "data"), purpose: "state" as const },
    { path: "node_modules" as const, target: join(sourceRoot, "node_modules"), purpose: "dependencies" as const },
    { path: "var" as const, target: join(sourceRoot, "var"), purpose: "state" as const },
  ];
  for (const link of links) await symlink(link.target, join(releasePath, link.path));
  const manifest = signReleaseManifest({
    schemaVersion: 1,
    sourceCommit,
    releaseId,
    releasePath,
    sourceRoot,
    stateRoot: sourceRoot,
    deployedAt: "2026-07-11T12:00:00.000Z",
    artifactSetSha256: releaseArtifactSetSha256(artifacts),
    artifacts,
    links,
  }, privateKey);
  const manifestPath = join(releasePath, "release-manifest.json");
  await writeFile(manifestPath, `${JSON.stringify(manifest)}\n`, { mode: 0o444 });
  await chmod(manifestPath, 0o444);
  for (const directory of [
    join(releasePath, "analysis"),
    join(releasePath, "dist"),
    join(releasePath, "ops"),
    releasePath,
  ]) await chmod(directory, 0o555);
  return { releasePath, artifactPath, publicKeyPath: trustedPublicKeyPath };
}

describe("frozen release manifest", () => {
  it("validates a signed complete read-only artifact set and explicit state links", async () => {
    const { releasePath, publicKeyPath } = await fixture();

    const manifest = validateFrozenRelease({ releasePath, publicKeyPath });

    expect(manifest).toMatchObject({
      schemaVersion: 1,
      sourceCommit: "a".repeat(40),
      releaseId: "b".repeat(32),
      stateRoot: expect.stringContaining("/source"),
      links: expect.arrayContaining([
        expect.objectContaining({ path: "data", purpose: "state" }),
        expect.objectContaining({ path: "analysis/output", purpose: "analysis-output" }),
      ]),
    });
  });

  it("rejects an artifact changed after signing", async () => {
    const { releasePath, artifactPath, publicKeyPath } = await fixture();
    await chmod(artifactPath, 0o755);
    await writeFile(artifactPath, "tampered\n");
    await chmod(artifactPath, 0o555);

    expect(() => validateFrozenRelease({ releasePath, publicKeyPath }))
      .toThrow(/does not match its manifest/u);
  });

  it("rejects undeclared files even when the signed artifacts are intact", async () => {
    const { releasePath, publicKeyPath } = await fixture();
    await chmod(join(releasePath, "dist"), 0o755);
    await writeFile(join(releasePath, "dist", "extra.js"), "extra", { mode: 0o444 });
    await chmod(join(releasePath, "dist"), 0o555);

    expect(() => validateFrozenRelease({ releasePath, publicKeyPath })).toThrow(/does not exactly match/u);
  });

  it("cannot substitute a release-local key for the external trust anchor", async () => {
    const { releasePath, publicKeyPath } = await fixture();
    const replacement = generateKeyPairSync("ed25519").publicKey
      .export({ type: "spki", format: "pem" });
    const copiedKey = join(releasePath, "ops", "validation-attestation-public.pem");
    await chmod(copiedKey, 0o644);
    await writeFile(copiedKey, replacement);
    await chmod(copiedKey, 0o444);

    expect(() => validateFrozenRelease({ releasePath, publicKeyPath }))
      .toThrow(/does not match the trusted signing key/u);
  });

  it("refuses to use even an intact release-local key as the trust anchor", async () => {
    const { releasePath } = await fixture();

    expect(() => validateFrozenRelease({
      releasePath,
      publicKeyPath: join(releasePath, "ops", "validation-attestation-public.pem"),
    })).toThrow(/external trust anchor/u);
  });
});
