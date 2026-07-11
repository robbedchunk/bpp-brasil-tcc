import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  readFileSync,
  realpathSync,
} from "node:fs";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";

export type PublicationAuditStatus = "pass" | "fail";

export type PublicationFindingScope =
  | "tracked-tree"
  | "git-history"
  | "public-database"
  | "public-export"
  | "documentation"
  | "repository-shape";

export interface PublicationFinding {
  ruleId: string;
  scope: PublicationFindingScope;
  location: string;
  objectId?: string;
  message: string;
}

export interface ReadmeClaims {
  researchPilot: boolean;
  activeDevelopment: boolean;
  defendedMethodClaim: boolean;
  noStatisticalValidationClaim: boolean;
  rawHtmlExcluded: boolean;
  outOfScopeExplicit: boolean;
  acceptanceCommandDocumented: boolean;
  acceptanceReportLinked: boolean;
}

export interface PublicationAuditReport {
  schemaVersion: 1;
  generatedAt: string;
  commit: string;
  status: PublicationAuditStatus;
  trackedSecrets: PublicationFinding[];
  historicalSecrets: PublicationFinding[];
  trackedPrivateArtifacts: PublicationFinding[];
  trackedRawHtml: PublicationFinding[];
  unsafeLinksOrSubmodules: PublicationFinding[];
  publicDataFindings: PublicationFinding[];
  requiredDocsMissing: string[];
  readmeClaims: ReadmeClaims;
  workingTreeClean: boolean;
  findings: PublicationFinding[];
}

export interface PublicationAuditOptions {
  projectRoot: string;
  databasePath: string;
  now: () => Date;
  requireClean: boolean;
}

export interface FreshCloneReceipt {
  schemaVersion: 1;
  status: "pass";
  sourceCommit: string;
  completedAt: string;
  runtimes: { node: string; npm: string; python: string };
  checks: Array<{ id: string; exitCode: 0; outputSha256: string }>;
  artifacts: Array<{ path: string; sha256: string }>;
}

const REQUIRED_DOCS = [
  "README.md",
  "LICENSE",
  "SECURITY.md",
  "docs/methodology.md",
  "docs/ethics-and-tos.md",
  "docs/data-dictionary.md",
  "docs/operations.md",
  "docs/sources.md",
] as const;

const SHA256_PATTERN = /^[a-f0-9]{64}$/u;
const COMMIT_PATTERN = /^[a-f0-9]{40}$/u;
const PRIVATE_PATH_PATTERNS = [
  /(^|\/)\.env(?:\.|$)/u,
  /(^|\/)var\//u,
  /(^|\/)replay\//u,
  /(^|\/)backups?\//u,
  /(^|\/)data\/raw-html\//u,
  /(^|\/)browser-profiles?\//u,
  /(^|\/)playwright-report\//u,
  /\.sqlite-(?:wal|shm)$/u,
  /\.sqlite\.(?:legacy-migration|migration-)/u,
  /\.log$/u,
] as const;
const RAW_HTML_PATH = /(^|\/)(?:data\/raw-html|var\/replay|replay)\//u;
const PRIVATE_COLUMN = /^(?:raw_html|html|response_body|body|cookie|set_cookie|authorization|secret|token|response_path|replay_path)$/iu;
const RAW_HTML_COLUMN = /^(?:raw_html|html|response_body|body)$/iu;
const RAW_HTML_CONTENT = /<!doctype\s+html|<html(?:\s|>)/iu;
const PRIVATE_ABSOLUTE_PATH = /(?:^|[\s"'])\/(?:home|root|Users|private|tmp)\//u;
const SYNTHETIC_TEST_MARKER = /(?:fake-|test-|example-|should-never-|event-secret|bearer-secret|never-log|secret-value|\.test(?:[/:]|$))/iu;

interface SecretRule {
  id: string;
  pattern: RegExp;
}

const SECRET_RULES: SecretRule[] = [
  { id: "SECRET_OPENAI_KEY", pattern: /\bsk-(?:(?:proj|svcacct)-)?[A-Za-z0-9_-]{20,}\b/gu },
  {
    id: "SECRET_CONFIGURED_ENV",
    pattern: /^(?:OPENAI_API_KEY|CODEX_API_KEY|NTFY_TOPIC)[ \t]*=[ \t]*[^\s#][^\r\n]*$/gmu,
  },
  { id: "SECRET_PRIVATE_KEY", pattern: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/gu },
  { id: "SECRET_BEARER", pattern: /\bBearer\s+[A-Za-z0-9._~+/=-]{20,}\b/giu },
  { id: "SECRET_URI_CREDENTIALS", pattern: /https?:\/\/[^\s/:@]+:[^\s/@]+@[^\s/]+/giu },
];

function normalizePath(path: string): string {
  return path.split(sep).join("/").replace(/^\.\//u, "");
}

function inside(root: string, candidate: string): boolean {
  const path = relative(root, candidate);
  return path === "" || (!path.startsWith(`..${sep}`) && path !== ".." && !isAbsolute(path));
}

function sha256(value: Uint8Array | string): string {
  return createHash("sha256").update(value).digest("hex");
}

function git(root: string, args: string[], encoding: "utf8"): string;
function git(root: string, args: string[], encoding: "buffer"): Buffer;
function git(root: string, args: string[], encoding: "utf8" | "buffer"): string | Buffer {
  return execFileSync("git", args, {
    cwd: root,
    encoding: encoding === "utf8" ? "utf8" : "buffer",
    maxBuffer: 128 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function safeGit(root: string, args: string[]): string {
  try {
    return git(root, args, "utf8").trim();
  } catch {
    return "";
  }
}

function currentPaths(root: string): string[] {
  const output = git(
    root,
    ["ls-files", "-z", "--cached", "--others", "--exclude-standard"],
    "buffer",
  );
  return output.toString("utf8").split("\0").filter(Boolean).map(normalizePath).sort();
}

function currentModes(root: string): Map<string, string> {
  const modes = new Map<string, string>();
  const output = git(root, ["ls-files", "-s", "-z"], "buffer").toString("utf8");
  for (const entry of output.split("\0").filter(Boolean)) {
    const match = /^(\d+) [a-f0-9]+ \d+\t([\s\S]+)$/u.exec(entry);
    if (match?.[1] !== undefined && match[2] !== undefined) {
      modes.set(normalizePath(match[2]), match[1]);
    }
  }
  return modes;
}

function finding(
  ruleId: string,
  scope: PublicationFindingScope,
  location: string,
  message: string,
  objectId?: string,
): PublicationFinding {
  return {
    ruleId,
    scope,
    location: normalizePath(location),
    ...(objectId === undefined ? {} : { objectId }),
    message,
  };
}

function secretFindings(
  content: Uint8Array,
  path: string,
  scope: "tracked-tree" | "git-history" | "public-database" | "public-export",
  objectId?: string,
): PublicationFinding[] {
  const text = Buffer.from(content).toString("utf8");
  const results: PublicationFinding[] = [];
  for (const rule of SECRET_RULES) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      const value = match[0];
      if (path.startsWith("tests/") && SYNTHETIC_TEST_MARKER.test(value)) continue;
      const line = text.slice(0, match.index).split("\n").length;
      results.push(finding(
        rule.id,
        scope,
        `${path}:${line}`,
        "Credential-like material matched a publication safety rule",
        objectId,
      ));
    }
  }
  return results;
}

function privatePathKind(path: string): "raw" | "private" | null {
  if (path === ".env.example") return null;
  if (RAW_HTML_PATH.test(path)) return "raw";
  return PRIVATE_PATH_PATTERNS.some((pattern) => pattern.test(path)) ? "private" : null;
}

function historicalEntries(root: string): Map<string, Set<string>> {
  const entries = new Map<string, Set<string>>();
  const revisions = safeGit(root, ["rev-list", "--all"]);
  if (revisions === "") return entries;
  for (const revision of revisions.split("\n")) {
    const tree = git(root, ["ls-tree", "-r", "-z", revision], "buffer").toString("utf8");
    for (const item of tree.split("\0").filter(Boolean)) {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/u.exec(item);
      if (match?.[2] === undefined || match[3] === undefined) continue;
      const paths = entries.get(match[2]) ?? new Set<string>();
      paths.add(normalizePath(match[3]));
      entries.set(match[2], paths);
    }
  }
  return entries;
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function auditDatabase(path: string, root: string): PublicationFinding[] {
  if (!existsSync(path)) return [];
  const results: PublicationFinding[] = [];
  const location = normalizePath(relative(root, path));
  const database = new Database(path, { readonly: true, fileMustExist: true });
  try {
    const quick = database.pragma("quick_check") as Array<Record<string, unknown>>;
    if (quick.length !== 1 || Object.values(quick[0] ?? {})[0] !== "ok") {
      results.push(finding("PUBLIC_DATABASE_INTEGRITY", "public-database", location, "SQLite quick_check failed"));
    }
    const foreignKeys = database.pragma("foreign_key_check") as unknown[];
    if (foreignKeys.length > 0) {
      results.push(finding("PUBLIC_DATABASE_FOREIGN_KEY", "public-database", location, "SQLite foreign_key_check returned rows"));
    }
    const tables = database.prepare(
      "SELECT name FROM sqlite_schema WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name",
    ).all() as Array<{ name: string }>;
    for (const { name: table } of tables) {
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns) {
        const columnLocation = `${location}:${table}.${column.name}`;
        if (RAW_HTML_COLUMN.test(column.name)) {
          results.push(finding("PUBLIC_DATABASE_RAW_HTML", "public-database", columnLocation, "Raw response body columns are not publishable"));
        }
        if (!/TEXT|BLOB|CLOB|JSON/iu.test(column.type) && !RAW_HTML_COLUMN.test(column.name) && column.name !== "response_path") {
          continue;
        }
        const rows = database.prepare(
          `SELECT ${quoteIdentifier(column.name)} AS value FROM ${quoteIdentifier(table)} WHERE ${quoteIdentifier(column.name)} IS NOT NULL`,
        ).iterate() as Iterable<{ value: unknown }>;
        for (const row of rows) {
          const value = typeof row.value === "string"
            ? Buffer.from(row.value)
            : Buffer.isBuffer(row.value)
              ? row.value
              : Buffer.from(String(row.value));
          const text = value.toString("utf8");
          if (RAW_HTML_CONTENT.test(text)) {
            results.push(finding("PUBLIC_DATABASE_RAW_HTML", "public-database", columnLocation, "Raw HTML content is not publishable"));
          }
          if (PRIVATE_ABSOLUTE_PATH.test(text)) {
            results.push(finding("PUBLIC_DATABASE_PRIVATE_PATH", "public-database", columnLocation, "Private absolute paths are not publishable"));
          }
          results.push(...secretFindings(value, columnLocation, "public-database"));
          if (column.name === "response_path") {
            const normalized = normalizePath(text);
            const safeReplay = !isAbsolute(text)
              && !normalized.split("/").includes("..")
              && (normalized.startsWith("data/raw-html/") || normalized.startsWith("var/replay/"));
            if (!safeReplay || safeGit(root, ["ls-files", "--error-unmatch", normalized]) !== "") {
              results.push(finding("PUBLIC_DATABASE_REPLAY_PATH", "public-database", columnLocation, "Replay metadata must point only to an ignored untracked runtime path"));
            }
          }
        }
      }
    }
  } finally {
    database.close();
  }
  return results;
}

function auditCsv(path: string, root: string): PublicationFinding[] {
  const location = normalizePath(relative(root, path));
  const content = readFileSync(path);
  const results = secretFindings(content, location, "public-export");
  const text = content.toString("utf8");
  if (PRIVATE_ABSOLUTE_PATH.test(text)) {
    results.push(finding("PUBLIC_CSV_PRIVATE_PATH", "public-export", location, "Public CSV contains a private absolute path"));
  }
  try {
    const rows = parse(text, { bom: false, relax_column_count: false, skip_empty_lines: false }) as string[][];
    const header = rows[0] ?? [];
    for (const column of header) {
      if (PRIVATE_COLUMN.test(column)) {
        results.push(finding("PUBLIC_CSV_PRIVATE_COLUMN", "public-export", `${location}:${column}`, "Public CSV exposes a private runtime column"));
      }
    }
  } catch {
    results.push(finding("PUBLIC_CSV_INVALID", "public-export", location, "Public CSV is not structurally valid"));
  }
  return results;
}

function parseJson(path: string): Record<string, unknown> | null {
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function auditManifest(path: string, root: string): PublicationFinding[] {
  const location = normalizePath(relative(root, path));
  const document = parseJson(path);
  if (document === null) {
    return [finding("PUBLIC_MANIFEST_INVALID", "public-export", location, "Public manifest JSON is invalid")];
  }
  const entries = Array.isArray(document.files)
    ? document.files
    : Array.isArray(document.outputs)
      ? document.outputs
      : [];
  const results: PublicationFinding[] = [];
  for (const entry of entries) {
    if (typeof entry !== "object" || entry === null) continue;
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || typeof item.sha256 !== "string") continue;
    const candidate = resolve(dirname(path), item.path);
    if (isAbsolute(item.path) || !inside(dirname(path), candidate)) {
      results.push(finding("PUBLIC_MANIFEST_PATH", "public-export", location, "Manifest path escapes its immutable snapshot"));
      continue;
    }
    if (!existsSync(candidate) || !SHA256_PATTERN.test(item.sha256) || sha256(readFileSync(candidate)) !== item.sha256) {
      results.push(finding("PUBLIC_MANIFEST_HASH", "public-export", `${location}:${item.path}`, "Manifest file hash does not match"));
    }
  }
  return results;
}

function auditLatest(path: string, root: string): PublicationFinding[] {
  const location = normalizePath(relative(root, path));
  const document = parseJson(path);
  if (
    document === null
    || typeof document.snapshotDirectory !== "string"
    || typeof document.manifestSha256 !== "string"
  ) {
    return [finding("PUBLIC_LATEST_INVALID", "public-export", location, "Latest pointer JSON is invalid")];
  }
  const base = dirname(path);
  const snapshot = resolve(base, document.snapshotDirectory);
  const manifest = resolve(snapshot, "manifest.json");
  if (isAbsolute(document.snapshotDirectory) || !inside(base, snapshot)) {
    return [finding("PUBLIC_MANIFEST_PATH", "public-export", location, "Latest pointer escapes its output root")];
  }
  if (!existsSync(manifest) || !SHA256_PATTERN.test(document.manifestSha256) || sha256(readFileSync(manifest)) !== document.manifestSha256) {
    return [finding("PUBLIC_MANIFEST_HASH", "public-export", location, "Latest pointer manifest hash does not match")];
  }
  return [];
}

function readmeClaims(root: string): ReadmeClaims {
  const path = join(root, "README.md");
  const text = existsSync(path) ? readFileSync(path, "utf8") : "";
  return {
    researchPilot: /research pilot/iu.test(text),
    activeDevelopment: /active development/iu.test(text),
    defendedMethodClaim: /defended claim[\s\S]{0,120}(?:method|strategy|self-heal)/iu.test(text),
    noStatisticalValidationClaim: /no statistical validation|does not claim statistical validation/iu.test(text),
    rawHtmlExcluded: /raw HTML[\s\S]{0,100}(?:not published|excluded|never published)/iu.test(text),
    outOfScopeExplicit: /out of scope/iu.test(text),
    acceptanceCommandDocumented: /npm run acceptance\s+--\s+--json/iu.test(text),
    acceptanceReportLinked: /docs\/acceptance-report\.md/iu.test(text),
  };
}

function deduplicate(findings: PublicationFinding[]): PublicationFinding[] {
  const unique = new Map<string, PublicationFinding>();
  for (const item of findings) {
    const key = [item.ruleId, item.scope, item.location, item.objectId ?? ""].join("\0");
    unique.set(key, item);
  }
  return [...unique.values()].sort((left, right) =>
    `${left.scope}\0${left.location}\0${left.ruleId}`.localeCompare(`${right.scope}\0${right.location}\0${right.ruleId}`));
}

export function validateFreshCloneReceipt(input: unknown): FreshCloneReceipt {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    throw new TypeError("Fresh-clone receipt must be an object");
  }
  const value = input as Record<string, unknown>;
  if (
    value.schemaVersion !== 1
    || value.status !== "pass"
    || typeof value.sourceCommit !== "string"
    || !COMMIT_PATTERN.test(value.sourceCommit)
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
    || typeof value.runtimes !== "object"
    || value.runtimes === null
    || !Array.isArray(value.checks)
    || !Array.isArray(value.artifacts)
  ) {
    throw new TypeError("Fresh-clone receipt has an invalid shape");
  }
  const runtimes = value.runtimes as Record<string, unknown>;
  for (const name of ["node", "npm", "python"]) {
    if (typeof runtimes[name] !== "string" || runtimes[name] === "") {
      throw new TypeError("Fresh-clone receipt runtime is invalid");
    }
  }
  for (const check of value.checks) {
    if (
      typeof check !== "object"
      || check === null
      || typeof (check as Record<string, unknown>).id !== "string"
      || (check as Record<string, unknown>).exitCode !== 0
      || typeof (check as Record<string, unknown>).outputSha256 !== "string"
      || !SHA256_PATTERN.test((check as Record<string, unknown>).outputSha256 as string)
    ) {
      throw new TypeError("Fresh-clone receipt check is invalid");
    }
  }
  for (const artifact of value.artifacts) {
    const item = artifact as Record<string, unknown>;
    if (
      typeof item?.path !== "string"
      || isAbsolute(item.path)
      || item.path.split("/").includes("..")
      || typeof item.sha256 !== "string"
      || !SHA256_PATTERN.test(item.sha256)
    ) {
      throw new TypeError("Fresh-clone receipt artifact path must be relative and hashed");
    }
  }
  return input as FreshCloneReceipt;
}

export async function auditPublication(
  options: PublicationAuditOptions,
): Promise<PublicationAuditReport> {
  const root = realpathSync(options.projectRoot);
  const paths = currentPaths(root);
  const modes = currentModes(root);
  const trackedSecrets: PublicationFinding[] = [];
  const trackedPrivateArtifacts: PublicationFinding[] = [];
  const trackedRawHtml: PublicationFinding[] = [];
  const unsafeLinksOrSubmodules: PublicationFinding[] = [];
  const publicDataFindings: PublicationFinding[] = [];

  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!inside(root, absolute)) continue;
    const mode = modes.get(path);
    let metadata;
    try {
      metadata = lstatSync(absolute);
    } catch {
      continue;
    }
    if (mode === "160000") {
      unsafeLinksOrSubmodules.push(finding("TRACKED_SUBMODULE", "repository-shape", path, "Git submodules are outside the publication audit boundary"));
      continue;
    }
    if (mode === "120000" || metadata.isSymbolicLink()) {
      unsafeLinksOrSubmodules.push(finding("TRACKED_SYMLINK", "repository-shape", path, "Tracked symbolic links are not publication-safe"));
      continue;
    }
    if (!metadata.isFile()) continue;
    const kind = privatePathKind(path);
    if (kind === "raw") {
      trackedRawHtml.push(finding("TRACKED_RAW_HTML", "tracked-tree", path, "Runtime raw HTML/replay evidence must not be tracked"));
    } else if (kind === "private") {
      trackedPrivateArtifacts.push(finding("TRACKED_PRIVATE_ARTIFACT", "tracked-tree", path, "Private runtime material must not be tracked"));
    }
    const content = readFileSync(absolute);
    trackedSecrets.push(...secretFindings(content, path, "tracked-tree"));
    if (path.endsWith(".csv")) publicDataFindings.push(...auditCsv(absolute, root));
    if (path.endsWith("/manifest.json")) publicDataFindings.push(...auditManifest(absolute, root));
    if (path === "data/exports/latest.json" || path === "analysis/output/latest.json") {
      publicDataFindings.push(...auditLatest(absolute, root));
    }
  }

  const historicalSecrets: PublicationFinding[] = [];
  for (const [objectId, objectPaths] of historicalEntries(root)) {
    const content = git(root, ["cat-file", "blob", objectId], "buffer");
    for (const path of objectPaths) {
      historicalSecrets.push(...secretFindings(content, path, "git-history", objectId));
      const kind = privatePathKind(path);
      if (kind === "raw") {
        trackedRawHtml.push(finding("HISTORICAL_RAW_HTML", "git-history", path, "Runtime raw HTML/replay evidence exists in reachable Git history", objectId));
      } else if (kind === "private") {
        trackedPrivateArtifacts.push(finding("HISTORICAL_PRIVATE_ARTIFACT", "git-history", path, "Private runtime material exists in reachable Git history", objectId));
      }
    }
  }

  publicDataFindings.push(...auditDatabase(resolve(options.databasePath), root));

  const requiredDocsMissing = REQUIRED_DOCS.filter((path) => {
    const absolute = join(root, path);
    return !existsSync(absolute) || readFileSync(absolute).length === 0;
  });
  const claims = readmeClaims(root);
  const requiredClaims = [
    claims.researchPilot,
    claims.activeDevelopment,
    claims.defendedMethodClaim,
    claims.noStatisticalValidationClaim,
    claims.rawHtmlExcluded,
    claims.outOfScopeExplicit,
  ];
  const documentationFindings = requiredClaims.every(Boolean)
    ? []
    : [finding("README_CLAIMS", "documentation", "README.md", "README is missing one or more required research/limitation claims")];
  const porcelain = safeGit(root, ["status", "--porcelain=v1"]);
  const workingTreeClean = porcelain === "";
  const cleanlinessFindings = options.requireClean && !workingTreeClean
    ? [finding("WORKTREE_DIRTY", "repository-shape", ".", "Publication cut requires a clean worktree and index")]
    : [];

  const sections = {
    trackedSecrets: deduplicate(trackedSecrets),
    historicalSecrets: deduplicate(historicalSecrets),
    trackedPrivateArtifacts: deduplicate(trackedPrivateArtifacts),
    trackedRawHtml: deduplicate(trackedRawHtml),
    unsafeLinksOrSubmodules: deduplicate(unsafeLinksOrSubmodules),
    publicDataFindings: deduplicate(publicDataFindings),
  };
  const missingFindings = requiredDocsMissing.map((path) =>
    finding("REQUIRED_DOCUMENT", "documentation", path, "Required public document is missing or empty"));
  const findings = deduplicate([
    ...sections.trackedSecrets,
    ...sections.historicalSecrets,
    ...sections.trackedPrivateArtifacts,
    ...sections.trackedRawHtml,
    ...sections.unsafeLinksOrSubmodules,
    ...sections.publicDataFindings,
    ...missingFindings,
    ...documentationFindings,
    ...cleanlinessFindings,
  ]);

  return {
    schemaVersion: 1,
    generatedAt: options.now().toISOString(),
    commit: safeGit(root, ["rev-parse", "HEAD"]),
    status: findings.length === 0 ? "pass" : "fail",
    ...sections,
    requiredDocsMissing: [...requiredDocsMissing],
    readmeClaims: claims,
    workingTreeClean,
    findings,
  };
}
