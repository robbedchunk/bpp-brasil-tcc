#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const sha256 = (value) => createHash("sha256").update(value).digest("hex");

function parseArguments() {
  const options = {
    sourceRoot: resolve(fileURLToPath(new URL("..", import.meta.url))),
    releaseRoot: resolve(process.env.HOME ?? "", ".local/share/precos/releases"),
    releaseId: randomBytes(16).toString("hex"),
    deployedAt: new Date().toISOString(),
    privateKeyPath: undefined,
    npmPath: "npm",
  };
  const arguments_ = process.argv.slice(2);
  for (let index = 0; index < arguments_.length; index += 2) {
    const name = arguments_[index];
    const value = arguments_[index + 1];
    if (value === undefined) throw new Error(`missing value for ${name ?? "argument"}`);
    if (name === "--source-root") options.sourceRoot = resolve(value);
    else if (name === "--release-root") options.releaseRoot = resolve(value);
    else if (name === "--release-id") options.releaseId = value;
    else if (name === "--deployed-at") options.deployedAt = value;
    else if (name === "--private-key") options.privateKeyPath = resolve(value);
    else if (name === "--npm-path") options.npmPath = resolve(value);
    else throw new Error(`unknown argument: ${name}`);
  }
  if (!/^[a-f0-9]{32}$/u.test(options.releaseId)) {
    throw new Error("release ID must be 32 lowercase hexadecimal characters");
  }
  if (!Number.isFinite(Date.parse(options.deployedAt))) {
    throw new Error("deployedAt must be an ISO-8601 timestamp");
  }
  options.deployedAt = new Date(options.deployedAt).toISOString();
  options.privateKeyPath ??= join(
    options.sourceRoot,
    "var/operations/validation-attestation-private.pem",
  );
  if (options.releaseRoot === options.sourceRoot
    || options.releaseRoot.startsWith(`${options.sourceRoot}${sep}`)) {
    throw new Error("release root must be outside the source worktree");
  }
  return options;
}

function git(sourceRoot, arguments_) {
  return execFileSync("git", arguments_, { cwd: sourceRoot, encoding: "utf8" }).trim();
}

function assertCleanCommittedSource(sourceRoot) {
  const top = resolve(git(sourceRoot, ["rev-parse", "--show-toplevel"]));
  if (top !== sourceRoot) throw new Error("source root must be the Git worktree root");
  const commit = git(sourceRoot, ["rev-parse", "--verify", "HEAD"]);
  if (!/^[a-f0-9]{40}$/u.test(commit)) throw new Error("source HEAD is not a full commit identity");
  const status = git(sourceRoot, ["status", "--porcelain=v1", "--untracked-files=all"]);
  if (status !== "") throw new Error("release creation requires a completely clean committed source tree");
  return commit;
}

function walkRegularFiles(root, excluded = new Set()) {
  const results = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      if (excluded.has(path)) continue;
      const stat = lstatSync(absolute);
      if (stat.isDirectory()) visit(absolute);
      else if (stat.isFile() && !stat.isSymbolicLink()) results.push(path);
      else throw new Error(`unsupported build entry: ${path}`);
    }
  };
  visit(root);
  return results;
}

function assertCleanBuild(sourceRoot, sourceCommit) {
  const dist = join(sourceRoot, "dist");
  const manifestPath = join(dist, "build-manifest.json");
  const build = JSON.parse(readFileSync(manifestPath, "utf8"));
  if (build.schemaVersion !== 1 || build.sourceCommit !== sourceCommit || build.sourceClean !== true
    || !Array.isArray(build.files) || !/^[a-f0-9]{64}$/u.test(build.artifactSetSha256)) {
    throw new Error("dist build manifest is absent, dirty, or bound to another source commit");
  }
  const actualPaths = walkRegularFiles(dist, new Set(["build-manifest.json"]));
  const declaredPaths = build.files.map((file) => file.path);
  if (JSON.stringify(actualPaths) !== JSON.stringify(declaredPaths)) {
    throw new Error("dist does not exactly match its build manifest file set");
  }
  for (const file of build.files) {
    const path = join(dist, ...file.path.split("/"));
    const stat = statSync(path);
    if (stat.size !== file.bytes || sha256(readFileSync(path)) !== file.sha256) {
      throw new Error(`dist artifact does not match its build manifest: ${file.path}`);
    }
  }
  if (sha256(JSON.stringify(build.files)) !== build.artifactSetSha256) {
    throw new Error("dist artifact-set digest does not match the build manifest");
  }
  const expectedValidator = readFileSync(join(sourceRoot, "ops/validator-bundle.sha256"), "utf8").trim();
  const actualValidator = sha256(readFileSync(join(dist, "scripts/validate-strategies.js")));
  if (!/^[a-f0-9]{64}$/u.test(expectedValidator) || expectedValidator !== actualValidator) {
    throw new Error("tracked validator bundle digest does not match the clean dist validator");
  }
}

function copyRequiredArtifacts(sourceRoot, destination) {
  const directories = ["dist", "retailers"];
  const files = [
    "package.json",
    "package-lock.json",
    "analysis/README.md",
    "analysis/generate.py",
    "analysis/requirements.txt",
    "scripts/create-release.mjs",
    "ops/backup.sh",
    "ops/check-heartbeat.sh",
    "ops/install-systemd.sh",
    "ops/lib.sh",
    "ops/run-weekly-index.sh",
    "ops/setup-analysis.sh",
    "ops/validation-attestation-public.pem",
    "ops/validator-bundle.sha256",
  ];
  for (const name of readdirSync(join(sourceRoot, "ops")).sort()) {
    if (/^precos-.+\.(?:service|timer)$/u.test(name)) files.push(`ops/${name}`);
  }
  for (const path of directories) {
    cpSync(join(sourceRoot, path), join(destination, path), {
      recursive: true,
      dereference: false,
      preserveTimestamps: true,
    });
  }
  for (const path of files.sort()) {
    const target = join(destination, path);
    mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
    cpSync(join(sourceRoot, path), target, { dereference: false, preserveTimestamps: true });
  }
}

function makeArtifactsReadOnly(root) {
  const artifacts = [];
  const visit = (directory) => {
    for (const name of readdirSync(directory).sort()) {
      const absolute = join(directory, name);
      const path = relative(root, absolute).split(sep).join("/");
      const stat = lstatSync(absolute);
      if (stat.isSymbolicLink()) continue;
      if (stat.isDirectory()) {
        visit(absolute);
        chmodSync(absolute, 0o555);
      } else if (stat.isFile()) {
        const mode = (stat.mode & 0o111) === 0 ? 0o444 : 0o555;
        chmodSync(absolute, mode);
        const finalStat = lstatSync(absolute);
        artifacts.push({
          path,
          sha256: sha256(readFileSync(absolute)),
          bytes: finalStat.size,
          mode: finalStat.mode & 0o777,
        });
      } else throw new Error(`unsupported release artifact: ${path}`);
    }
  };
  visit(root);
  return artifacts.sort((left, right) => left.path < right.path ? -1 : left.path > right.path ? 1 : 0);
}

function makeTreeWritable(root) {
  if (!existsSync(root)) return;
  const visit = (directory) => {
    chmodSync(directory, 0o700);
    for (const name of readdirSync(directory)) {
      const path = join(directory, name);
      const stat = lstatSync(path);
      if (stat.isDirectory() && !stat.isSymbolicLink()) visit(path);
      else if (!stat.isSymbolicLink()) chmodSync(path, 0o600);
    }
  };
  visit(root);
}

async function createRelease() {
  const options = parseArguments();
  const sourceCommit = assertCleanCommittedSource(options.sourceRoot);
  execFileSync(options.npmPath, ["run", "build"], {
    cwd: options.sourceRoot,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
  assertCleanBuild(options.sourceRoot, sourceCommit);
  // Do not execute code from dist until its clean-build manifest, complete file
  // set, and validator digest have all been checked with native primitives.
  const {
    releaseArtifactSetSha256,
    readReleaseSigningPrivateKey,
    signReleaseManifest,
    validateFrozenRelease,
  } = await import("../dist/ops/release-manifest.js");
  for (const path of ["data", "var", "analysis/output", "node_modules"]) {
    if (!statSync(join(options.sourceRoot, path)).isDirectory()) {
      throw new Error(`required release state/dependency directory is absent: ${path}`);
    }
  }
  const privateKey = readReleaseSigningPrivateKey(options.privateKeyPath);
  mkdirSync(options.releaseRoot, { recursive: true, mode: 0o700 });
  chmodSync(options.releaseRoot, 0o700);
  const name = `${sourceCommit}-${options.releaseId}`;
  const releasePath = join(options.releaseRoot, name);
  const temporary = join(options.releaseRoot, `.creating-${name}-${process.pid}`);
  if (existsSync(releasePath) || existsSync(temporary)) {
    throw new Error("release ID already exists; releases are never overwritten");
  }
  try {
    mkdirSync(temporary, { mode: 0o700 });
    copyRequiredArtifacts(options.sourceRoot, temporary);
    rmSync(join(temporary, "analysis", "output"), { recursive: true, force: true });
    const links = [
      { path: "analysis/output", target: join(options.sourceRoot, "analysis/output"), purpose: "analysis-output" },
      { path: "data", target: join(options.sourceRoot, "data"), purpose: "state" },
      { path: "node_modules", target: join(options.sourceRoot, "node_modules"), purpose: "dependencies" },
      { path: "var", target: join(options.sourceRoot, "var"), purpose: "state" },
    ];
    for (const link of links) {
      symlinkSync(link.target, join(temporary, ...link.path.split("/")));
    }
    const artifacts = makeArtifactsReadOnly(temporary);
    const manifest = signReleaseManifest({
      schemaVersion: 1,
      releaseId: options.releaseId,
      sourceCommit,
      deployedAt: options.deployedAt,
      releasePath,
      sourceRoot: options.sourceRoot,
      stateRoot: options.sourceRoot,
      artifactSetSha256: releaseArtifactSetSha256(artifacts),
      artifacts,
      links,
    }, privateKey);
    writeFileSync(join(temporary, "release-manifest.json"), `${JSON.stringify(manifest)}\n`, {
      mode: 0o444,
      flag: "wx",
    });
    chmodSync(join(temporary, "release-manifest.json"), 0o444);
    chmodSync(temporary, 0o555);
    if (assertCleanCommittedSource(options.sourceRoot) !== sourceCommit) {
      throw new Error("source commit changed during release creation");
    }
    assertCleanBuild(options.sourceRoot, sourceCommit);
    renameSync(temporary, releasePath);
    validateFrozenRelease({
      releasePath,
      publicKeyPath: join(options.sourceRoot, "ops/validation-attestation-public.pem"),
      expectedReleaseId: options.releaseId,
      expectedSourceCommit: sourceCommit,
      expectedSourceRoot: options.sourceRoot,
    });
    process.stdout.write(`${JSON.stringify({
      releasePath,
      releaseId: options.releaseId,
      sourceCommit,
      deployedAt: options.deployedAt,
      manifestSha256: sha256(readFileSync(join(releasePath, "release-manifest.json"))),
      artifactSetSha256: manifest.artifactSetSha256,
    })}\n`);
  } catch (error) {
    for (const path of [temporary, releasePath]) {
      if (existsSync(path)) {
        makeTreeWritable(path);
        rmSync(path, { recursive: true, force: true });
      }
    }
    throw error;
  }
}

try {
  await createRelease();
} catch (error) {
  process.stderr.write(`release-create: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
