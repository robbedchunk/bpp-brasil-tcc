#!/usr/bin/env node

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";

const root = resolve(new URL("..", import.meta.url).pathname);
const dist = resolve(root, "dist");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const files = [];
const visit = (directory) => {
  for (const name of readdirSync(directory).sort()) {
    const path = resolve(directory, name);
    const stat = statSync(path);
    if (stat.isDirectory()) visit(path);
    else if (stat.isFile() && path !== resolve(dist, "build-manifest.json")) {
      files.push({
        path: relative(dist, path).split("\\").join("/"),
        sha256: sha256(readFileSync(path)),
        bytes: stat.size,
      });
    }
  }
};
visit(dist);
const sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: root,
  encoding: "utf8",
}).trim();
const sourceStatus = execFileSync("git", [
  "status",
  "--porcelain",
  "--untracked-files=all",
  "--",
  "scripts",
  "src",
  "retailers",
  "ops/validation-attestation-public.pem",
  "ops/validator-bundle.sha256",
  "package.json",
  "package-lock.json",
  "tsconfig.json",
], { cwd: root, encoding: "utf8" }).trim();
const artifactSetSha256 = sha256(JSON.stringify(files));
writeFileSync(resolve(dist, "build-manifest.json"), `${JSON.stringify({
  schemaVersion: 1,
  sourceCommit,
  sourceClean: sourceStatus === "",
  artifactSetSha256,
  files,
})}\n`, { mode: 0o644 });
