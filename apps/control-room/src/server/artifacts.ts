import { createHash } from "node:crypto";
import { readFile, realpath } from "node:fs/promises";
import { relative, resolve, sep } from "node:path";

import { z } from "zod";

import type { ArtifactResponse } from "../shared/contracts.js";

const PointerSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string().regex(/^[A-Za-z0-9._-]+$/u),
  snapshotDirectory: z.string().regex(/^snapshots\/[A-Za-z0-9._-]+$/u),
  manifestSha256: z.string().regex(/^[a-f0-9]{64}$/u),
});

const ExportManifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string(),
  generatedAt: z.string(),
  methodVersion: z.string(),
  status: z.string(),
  files: z.array(z.object({ rows: z.number().int().nonnegative() })),
});

const AnalysisManifestSchema = z.object({
  schemaVersion: z.literal(1),
  snapshotId: z.string(),
});

function sha256(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function isContained(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === "" || (path !== ".." && !path.startsWith(`..${sep}`) && !path.startsWith(sep));
}

async function verifiedManifest(
  root: string,
  pointerName = "latest.json",
): Promise<{ pointer: z.infer<typeof PointerSchema>; bytes: Buffer } | null> {
  try {
    const rootPath = await realpath(root);
    const pointer = PointerSchema.parse(JSON.parse(await readFile(
      resolve(rootPath, pointerName),
      "utf8",
    )));
    const manifestPath = await realpath(resolve(rootPath, pointer.snapshotDirectory, "manifest.json"));
    if (!isContained(rootPath, manifestPath)) return null;
    const bytes = await readFile(manifestPath);
    if (sha256(bytes) !== pointer.manifestSha256) return null;
    return { pointer, bytes };
  } catch {
    return null;
  }
}

export async function readArtifacts(
  projectRoot: string,
  now: () => Date = () => new Date(),
): Promise<ArtifactResponse> {
  const [exportManifest, analysisManifest] = await Promise.all([
    verifiedManifest(resolve(projectRoot, "data/exports")),
    verifiedManifest(resolve(projectRoot, "analysis/output")),
  ]);
  let exportResult: ArtifactResponse["export"] = {
    available: false,
    verified: false,
    snapshotId: null,
    generatedAt: null,
    status: null,
    methodVersion: null,
    files: 0,
    rows: 0,
  };
  if (exportManifest !== null) {
    try {
      const manifest = ExportManifestSchema.parse(JSON.parse(exportManifest.bytes.toString("utf8")));
      if (manifest.snapshotId === exportManifest.pointer.snapshotId) {
        exportResult = {
          available: true,
          verified: true,
          snapshotId: manifest.snapshotId,
          generatedAt: manifest.generatedAt,
          status: manifest.status,
          methodVersion: manifest.methodVersion,
          files: manifest.files.length,
          rows: manifest.files.reduce((sum, file) => sum + file.rows, 0),
        };
      }
    } catch {
      exportResult = {
        available: true,
        verified: false,
        snapshotId: exportManifest.pointer.snapshotId,
        generatedAt: null,
        status: null,
        methodVersion: null,
        files: 0,
        rows: 0,
      };
    }
  }

  let analysisResult: ArtifactResponse["analysis"] = {
    available: false,
    verified: false,
    snapshotId: null,
  };
  if (analysisManifest !== null) {
    try {
      const manifest = AnalysisManifestSchema.parse(JSON.parse(analysisManifest.bytes.toString("utf8")));
      analysisResult = {
        available: true,
        verified: manifest.snapshotId === analysisManifest.pointer.snapshotId,
        snapshotId: manifest.snapshotId,
      };
    } catch {
      analysisResult = {
        available: true,
        verified: false,
        snapshotId: analysisManifest.pointer.snapshotId,
      };
    }
  }

  return {
    generatedAt: now().toISOString(),
    export: exportResult,
    analysis: analysisResult,
  };
}
