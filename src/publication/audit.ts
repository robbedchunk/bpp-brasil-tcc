import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  existsSync,
  lstatSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";

import Database from "better-sqlite3";
import { parse } from "csv-parse/sync";

import { validatePublicDrillReceipt } from "../ops/acceptance-drills.js";

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
const FIXTURE_PRIVATE_CONTENT = /\b(?:set-cookie|cookie|session[_-]?id|customer[_-]?address|delivery[_-]?address|address\s*:|cpf|e-?mail|localstorage|authorization)\b/iu;
const PUBLIC_PRIVATE_CONTENT = /(?:\bset-cookie\s*:|\bcookie\s*[:=]|\bsession[_-]?(?:id|token)?\s*[:=]|\b(?:customer|delivery)[_-]?address\s*[:=]|\bcpf\s*[:=]|\be-?mail\s*[:=]|\blocalstorage\b|\bauthorization\s*:)/iu;
const DATABASE_PRIVATE_SCHEMA = /^(?:raw_html|html|response_body|body|cookie|set_cookie|authorization|secret|token|browser_state|browser_profile)$/iu;
const SQLITE_MAGIC = Buffer.from("SQLite format 3\0", "binary");

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
  { id: "SECRET_BASIC", pattern: /\bBasic\s+[A-Za-z0-9+/]{16,}={0,2}(?=[\s"']|$)/giu },
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

function isSqliteDatabase(content: Uint8Array): boolean {
  return content.length >= SQLITE_MAGIC.length
    && Buffer.from(content).subarray(0, SQLITE_MAGIC.length).equals(SQLITE_MAGIC);
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
      if (path.startsWith("tests/") && rule.id === "SECRET_URI_CREDENTIALS" && /@[^\s/]+\.test(?:[/:]|$)/iu.test(value)) continue;
      if (path.startsWith("tests/") && rule.id === "SECRET_BEARER"
        && /^Bearer\s+(?:fake-|test-|example-|should-never-|event-secret|bearer-secret)/iu.test(value)) continue;
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

function historicalUnsafeShapes(root: string): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  const revisions = safeGit(root, ["rev-list", "--all"]);
  if (revisions === "") return findings;
  for (const revision of revisions.split("\n")) {
    const tree = git(root, ["ls-tree", "-r", "-z", revision], "buffer").toString("utf8");
    for (const item of tree.split("\0").filter(Boolean)) {
      const match = /^(\d+) (?:blob|commit) ([a-f0-9]+)\t([\s\S]+)$/u.exec(item);
      if (match?.[1] === "120000" && match[2] !== undefined && match[3] !== undefined) {
        findings.push(finding("HISTORICAL_SYMLINK", "git-history", match[3], "A tracked symbolic link remains in reachable Git history", match[2]));
      } else if (match?.[1] === "160000" && match[2] !== undefined && match[3] !== undefined) {
        findings.push(finding("HISTORICAL_SUBMODULE", "git-history", match[3], "A Git submodule remains in reachable Git history", match[2]));
      }
    }
  }
  return deduplicate(findings);
}

function quoteIdentifier(value: string): string {
  return `"${value.replaceAll('"', '""')}"`;
}

function auditDatabase(
  path: string,
  root: string,
  locationOverride?: string,
  sidecars: Array<{ suffix: "wal" | "shm"; bytes: number }> = [],
): PublicationFinding[] {
  if (!existsSync(path)) return [];
  const results: PublicationFinding[] = [];
  const location = locationOverride ?? normalizePath(relative(root, path));
  const walPath = `${path}-wal`;
  if (existsSync(walPath) && lstatSync(walPath).size > 0) {
    results.push(finding("PUBLIC_DATABASE_WAL_DEPENDENCY", "public-database", `${location}-wal`, "Public SQLite data must not require an uncheckpointed WAL"));
  }
  for (const sidecar of sidecars) {
    if (sidecar.bytes > 0) {
      results.push(finding(sidecar.suffix === "wal" ? "PUBLIC_DATABASE_WAL_DEPENDENCY" : "PUBLIC_DATABASE_SIDECAR", "public-database", `${location}-${sidecar.suffix}`, "A public SQLite snapshot must not require a WAL/SHM sidecar"));
    }
  }
  let database: Database.Database;
  try {
    database = new Database(path, { readonly: true, fileMustExist: true });
  } catch {
    results.push(finding("PUBLIC_DATABASE_INTEGRITY", "public-database", location, "SQLite snapshot could not be opened read-only"));
    return results;
  }
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
      if (DATABASE_PRIVATE_SCHEMA.test(table)) {
        results.push(finding("PUBLIC_DATABASE_PRIVATE_SCHEMA", "public-database", `${location}:${table}`, "Public SQLite schema exposes a private runtime name"));
      }
      const columns = database.prepare(`PRAGMA table_info(${quoteIdentifier(table)})`).all() as Array<{
        name: string;
        type: string;
      }>;
      for (const column of columns) {
        const columnLocation = `${location}:${table}.${column.name}`;
        if (DATABASE_PRIVATE_SCHEMA.test(column.name)) {
          results.push(finding("PUBLIC_DATABASE_PRIVATE_SCHEMA", "public-database", columnLocation, "Public SQLite schema exposes a private runtime column"));
        }
        if (RAW_HTML_COLUMN.test(column.name)) {
          results.push(finding("PUBLIC_DATABASE_RAW_HTML", "public-database", columnLocation, "Raw response body columns are not publishable"));
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
          if (PUBLIC_PRIVATE_CONTENT.test(text)) {
            results.push(finding("PUBLIC_DATABASE_PRIVATE_DATA", "public-database", columnLocation, "Cookie, session, authorization, or personal data is not publishable"));
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

function decodeUtf8(content: Uint8Array): string | null {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } catch {
    return null;
  }
}

function auditCsv(content: Uint8Array, location: string): PublicationFinding[] {
  const results = secretFindings(content, location, "public-export");
  const text = decodeUtf8(content);
  if (text === null) {
    results.push(finding("PUBLIC_CSV_UTF8", "public-export", location, "Public CSV is not valid UTF-8"));
    return results;
  }
  if (PRIVATE_ABSOLUTE_PATH.test(text)) {
    results.push(finding("PUBLIC_CSV_PRIVATE_PATH", "public-export", location, "Public CSV contains a private absolute path"));
  }
  try {
    const rows = parse(text, { bom: false, relax_column_count: false, skip_empty_lines: false }) as string[][];
    const header = rows[0] ?? [];
    if (header.length === 0 || header.some((column) => column === "") || new Set(header).size !== header.length) {
      results.push(finding("PUBLIC_CSV_HEADER", "public-export", location, "Public CSV header is missing, empty, or duplicated"));
    }
    for (const column of header) {
      if (PRIVATE_COLUMN.test(column)) {
        results.push(finding("PUBLIC_CSV_PRIVATE_COLUMN", "public-export", `${location}:${column}`, "Public CSV exposes a private runtime column"));
      }
    }
    for (const [rowIndex, row] of rows.slice(1).entries()) {
      for (const [columnIndex, cell] of row.entries()) {
        const cellLocation = `${location}:${header[columnIndex] ?? `column-${columnIndex + 1}`}:row-${rowIndex + 2}`;
        if (RAW_HTML_CONTENT.test(cell)) {
          results.push(finding("PUBLIC_CSV_RAW_HTML", "public-export", cellLocation, "Raw HTML content is not publishable"));
        }
        if (PUBLIC_PRIVATE_CONTENT.test(cell)) {
          results.push(finding("PUBLIC_CSV_PRIVATE_DATA", "public-export", cellLocation, "Cookie, session, authorization, or personal data is not publishable"));
        }
      }
    }
  } catch {
    results.push(finding("PUBLIC_CSV_INVALID", "public-export", location, "Public CSV is not structurally valid"));
  }
  return results;
}

function parseJsonContent(content: Uint8Array): Record<string, unknown> | null {
  try {
    const text = decodeUtf8(content);
    if (text === null) return null;
    const parsed: unknown = JSON.parse(text);
    return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)
      ? parsed as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

function parseJson(path: string): Record<string, unknown> | null {
  return parseJsonContent(readFileSync(path));
}

function auditManifest(
  content: Uint8Array,
  location: string,
  root: string,
  prospectiveFiles: Map<string, Buffer>,
): PublicationFinding[] {
  const document = parseJsonContent(content);
  if (document === null) {
    return [finding("PUBLIC_MANIFEST_INVALID", "public-export", location, "Public manifest JSON is invalid")];
  }
  const groups: Array<{ entries: unknown[]; base: string }> = [];
  if (Array.isArray(document.files)) groups.push({ entries: document.files, base: resolve(root, dirname(location)) });
  if (Array.isArray(document.outputs)) groups.push({ entries: document.outputs, base: resolve(root, dirname(location)) });
  if (Array.isArray(document.inputs)) {
    const input = typeof document.input === "object" && document.input !== null
      ? document.input as Record<string, unknown>
      : null;
    if (typeof input?.snapshotId !== "string" || input.snapshotId === "" || input.snapshotId.includes("/") || input.snapshotId.includes("..")) {
      return [finding("PUBLIC_MANIFEST_ENTRY", "public-export", location, "Analysis manifest inputs lack a safe source snapshot identity")];
    }
    groups.push({ entries: document.inputs, base: resolve(root, "data/exports/snapshots", input.snapshotId) });
  }
  const results: PublicationFinding[] = [];
  if (groups.length === 0) {
    return [finding("PUBLIC_MANIFEST_ENTRY", "public-export", location, "Public manifest has no files/outputs array")];
  }
  for (const { entries, base } of groups) for (const entry of entries) {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      results.push(finding("PUBLIC_MANIFEST_ENTRY", "public-export", location, "Public manifest contains a malformed entry"));
      continue;
    }
    const item = entry as Record<string, unknown>;
    if (typeof item.path !== "string" || item.path === "" || typeof item.sha256 !== "string" || !SHA256_PATTERN.test(item.sha256)) {
      results.push(finding("PUBLIC_MANIFEST_ENTRY", "public-export", location, "Public manifest entry requires a relative path and SHA-256"));
      continue;
    }
    const candidate = resolve(base, item.path);
    if (isAbsolute(item.path) || !inside(base, candidate) || !inside(root, candidate)) {
      results.push(finding("PUBLIC_MANIFEST_PATH", "public-export", location, "Manifest path escapes its immutable snapshot"));
      continue;
    }
    const candidateLocation = normalizePath(relative(root, candidate));
    const candidateContent = prospectiveFiles.get(candidateLocation);
    if (candidateContent === undefined || sha256(candidateContent) !== item.sha256) {
      results.push(finding("PUBLIC_MANIFEST_HASH", "public-export", `${location}:${item.path}`, "Manifest file hash does not match"));
      continue;
    }
    if (item.bytes !== undefined && (!Number.isSafeInteger(item.bytes) || item.bytes !== candidateContent.length)) {
      results.push(finding("PUBLIC_MANIFEST_ENTRY", "public-export", `${location}:${item.path}`, "Manifest byte count does not match"));
    }
  }
  return results;
}

function auditLatest(
  content: Uint8Array,
  location: string,
  root: string,
  prospectiveFiles: Map<string, Buffer>,
): PublicationFinding[] {
  const document = parseJsonContent(content);
  if (
    document === null
    || typeof document.snapshotDirectory !== "string"
    || typeof document.manifestSha256 !== "string"
  ) {
    return [finding("PUBLIC_LATEST_INVALID", "public-export", location, "Latest pointer JSON is invalid")];
  }
  const base = resolve(root, dirname(location));
  const snapshot = resolve(base, document.snapshotDirectory);
  const manifest = resolve(snapshot, "manifest.json");
  if (isAbsolute(document.snapshotDirectory) || !inside(base, snapshot)) {
    return [finding("PUBLIC_MANIFEST_PATH", "public-export", location, "Latest pointer escapes its output root")];
  }
  const manifestLocation = normalizePath(relative(root, manifest));
  const manifestContent = prospectiveFiles.get(manifestLocation);
  if (manifestContent === undefined || !SHA256_PATTERN.test(document.manifestSha256) || sha256(manifestContent) !== document.manifestSha256) {
    return [finding("PUBLIC_MANIFEST_HASH", "public-export", location, "Latest pointer manifest hash does not match")];
  }
  return [];
}

function readmeClaimsFromText(text: string): ReadmeClaims {
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

function auditFixtureHtml(content: Uint8Array, path: string): PublicationFinding[] {
  if (!path.startsWith("tests/fixtures/") || !/\.html?$/iu.test(path)) return [];
  const text = decodeUtf8(content);
  if (text === null) {
    return [finding("FIXTURE_UTF8", "public-export", path, "Sanitized HTML fixture is not valid UTF-8")];
  }
  if (FIXTURE_PRIVATE_CONTENT.test(text) || PRIVATE_ABSOLUTE_PATH.test(text)) {
    return [finding("FIXTURE_PRIVATE_DATA", "public-export", path, "Sanitized HTML fixture contains cookie/session/address/private-path state")];
  }
  return [];
}

function documentationContentFindings(files: Map<string, Buffer>): PublicationFinding[] {
  const findings: PublicationFinding[] = [];
  const text = (path: string) => decodeUtf8(files.get(path) ?? Buffer.alloc(0)) ?? "";
  const license = text("LICENSE");
  if (!/MIT License/u.test(license)
    || !/Copyright \(c\) 2026 RobbedChunk/u.test(license)
    || !/Permission is hereby granted, free of charge/iu.test(license)) {
    findings.push(finding("LICENSE_CONTENT", "documentation", "LICENSE", "MIT license text or author identity is incomplete"));
  }
  const security = text("SECURITY.md");
  if (!/private/iu.test(security) || !/(?:rotate|revoke)/iu.test(security) || !/raw/iu.test(security)) {
    findings.push(finding("SECURITY_CONTENT", "documentation", "SECURITY.md", "Security guidance must require private reporting, rotation, and no raw evidence"));
  }
  const sources = text("docs/sources.md");
  if (!/BCB[\s\S]*EE069|EE069[\s\S]*BCB/iu.test(sources)
    || !/IBGE[\s\S]*(?:POF|Pesquisa de Orçamentos Familiares)/iu.test(sources)
    || !/SIDRA[\s\S]*7060/iu.test(sources)
    || !/10\.1257\/jep\.30\.2\.151/iu.test(sources)) {
    findings.push(finding("SOURCES_CONTENT", "documentation", "docs/sources.md", "Source documentation is missing a required official artifact or citation"));
  }
  return findings;
}

function auditAcceptanceArtifact(content: Uint8Array, path: string): PublicationFinding[] {
  try {
    const parsed: unknown = JSON.parse(decodeUtf8(content) ?? "");
    if (path.endsWith("fresh-clone.json")) validateFreshCloneReceipt(parsed);
    else if (path.endsWith("alert-drill.json")) validatePublicDrillReceipt(parsed, "alert");
    else if (path.endsWith("backup-drill.json")) validatePublicDrillReceipt(parsed, "backup");
    else if (path.endsWith("acceptance.json")) {
      if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) throw new Error("shape");
      const report = parsed as Record<string, unknown>;
      const milestones = report.milestones as Record<string, unknown> | undefined;
      const topKeys = ["databaseSha256", "evaluatedCommit", "evidence", "generatedAt", "milestones", "overallStatus", "pendingGates", "publication", "schemaVersion", "timezone"];
      const isTimestamp = (value: unknown): value is string => typeof value === "string"
        && Number.isFinite(Date.parse(value))
        && new Date(value).toISOString() === value;
      const isNonempty = (value: unknown): value is string => typeof value === "string"
        && value.trim() !== "" && !/[\r\n]/u.test(value);
      const hasExactKeys = (value: Record<string, unknown>, keys: string[]): boolean =>
        Object.keys(value).sort().join("\0") === [...keys].sort().join("\0");
      const statuses = new Set(["pass", "pending", "fail"]);
      if (!hasExactKeys(report, topKeys)
        || report.schemaVersion !== 1
        || !isTimestamp(report.generatedAt)
        || typeof report.evaluatedCommit !== "string" || !COMMIT_PATTERN.test(report.evaluatedCommit)
        || typeof report.databaseSha256 !== "string" || !SHA256_PATTERN.test(report.databaseSha256)
        || report.timezone !== "America/Sao_Paulo"
        || !statuses.has(String(report.overallStatus))
        || typeof milestones !== "object" || milestones === null
        || Object.keys(milestones).sort().join("\0") !== ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"].join("\0")
        || !Array.isArray(report.evidence) || !Array.isArray(report.pendingGates)
        || typeof report.publication !== "object" || report.publication === null || Array.isArray(report.publication)) {
        throw new Error("shape");
      }
      const publication = report.publication as Record<string, unknown>;
      const publicationKeys = [
        "commit", "findings", "generatedAt", "historicalSecrets", "publicDataFindings",
        "readmeClaims", "requiredDocsMissing", "schemaVersion", "status",
        "trackedPrivateArtifacts", "trackedRawHtml", "trackedSecrets",
        "unsafeLinksOrSubmodules", "workingTreeClean",
      ];
      const publicationArrays = [
        "findings", "historicalSecrets", "publicDataFindings", "requiredDocsMissing",
        "trackedPrivateArtifacts", "trackedRawHtml", "trackedSecrets", "unsafeLinksOrSubmodules",
      ];
      if (!hasExactKeys(publication, publicationKeys)
        || publication.schemaVersion !== 1 || publication.status !== "pass"
        || publication.commit !== report.evaluatedCommit || !isTimestamp(publication.generatedAt)
        || publication.workingTreeClean !== true
        || publicationArrays.some((key) => !Array.isArray(publication[key]) || (publication[key] as unknown[]).length !== 0)
        || typeof publication.readmeClaims !== "object" || publication.readmeClaims === null
        || Object.values(publication.readmeClaims as Record<string, unknown>).some((claim) => claim !== true)) {
        throw new Error("publication");
      }
      const evidenceIds = new Set<string>();
      for (const item of report.evidence) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("evidence");
        const row = item as Record<string, unknown>;
        const evidenceKeys = ["facts", "id", "kind", "observedAt", "source", ...(row.sha256 === undefined ? [] : ["sha256"] )];
        if (!hasExactKeys(row, evidenceKeys)
          || !isNonempty(row.id) || evidenceIds.has(row.id)
          || !["command", "database-query", "file", "service", "receipt"].includes(String(row.kind))
          || !isNonempty(row.source) || isAbsolute(row.source)
          || !isTimestamp(row.observedAt)
          || (row.sha256 !== undefined && (typeof row.sha256 !== "string" || !SHA256_PATTERN.test(row.sha256)))
          || typeof row.facts !== "object" || row.facts === null || Array.isArray(row.facts)
          || Object.entries(row.facts as Record<string, unknown>).some(([key, fact]) =>
            key.trim() === "" || fact !== null && !["string", "number", "boolean"].includes(typeof fact)
              || typeof fact === "number" && !Number.isFinite(fact))) {
          throw new Error("evidence");
        }
        evidenceIds.add(row.id as string);
      }
      const milestoneStatuses: string[] = [];
      const criteria = new Map<string, string>();
      for (const id of ["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]) {
        const milestone = milestones[id] as Record<string, unknown> | undefined;
        if (typeof milestone !== "object" || milestone === null
          || !hasExactKeys(milestone, ["criteria", "status"])
          || !statuses.has(String(milestone.status))
          || !Array.isArray(milestone.criteria) || milestone.criteria.length === 0) throw new Error("milestone");
        const criterionStatuses: string[] = [];
        for (const item of milestone.criteria) {
          if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("criterion");
          const current = item as Record<string, unknown>;
          if (!hasExactKeys(current, ["evidenceIds", "id", "reasonCodes", "status", "summary"])
            || !isNonempty(current.id) || criteria.has(current.id)
            || !statuses.has(String(current.status)) || !isNonempty(current.summary)
            || !Array.isArray(current.reasonCodes)
            || current.reasonCodes.some((code) => !isNonempty(code))
            || new Set(current.reasonCodes).size !== current.reasonCodes.length
            || !Array.isArray(current.evidenceIds) || current.evidenceIds.length === 0
            || new Set(current.evidenceIds).size !== current.evidenceIds.length
            || current.evidenceIds.some((evidenceId) => typeof evidenceId !== "string" || !evidenceIds.has(evidenceId))) {
            throw new Error("criterion");
          }
          criteria.set(current.id as string, String(current.status));
          criterionStatuses.push(String(current.status));
        }
        const milestoneAggregate = criterionStatuses.includes("fail") ? "fail"
          : criterionStatuses.includes("pending") ? "pending" : "pass";
        if (milestoneAggregate !== milestone.status) throw new Error("milestone aggregation");
        milestoneStatuses.push(String(milestone.status));
      }
      const gatedCriteria = new Set<string>();
      for (const item of report.pendingGates) {
        if (typeof item !== "object" || item === null || Array.isArray(item)) throw new Error("gate");
        const current = item as Record<string, unknown>;
        if (!hasExactKeys(current, ["criterionId", "evidenceIds", "kind", "nextAction", "reasonCode", "recheckCommand", "since"])
          || !isNonempty(current.criterionId) || criteria.get(current.criterionId) !== "pending"
          || !["time", "credential", "site", "authority"].includes(String(current.kind))
          || !isNonempty(current.reasonCode) || !isNonempty(current.nextAction)
          || !isNonempty(current.recheckCommand)
          || current.since !== null && !isTimestamp(current.since)
          || !Array.isArray(current.evidenceIds) || current.evidenceIds.length === 0
          || new Set(current.evidenceIds).size !== current.evidenceIds.length
          || current.evidenceIds.some((evidenceId) => typeof evidenceId !== "string" || !evidenceIds.has(evidenceId))) {
          throw new Error("gate");
        }
        gatedCriteria.add(current.criterionId as string);
      }
      if ([...criteria].some(([criterionId, status]) => status === "pending" && !gatedCriteria.has(criterionId))) {
        throw new Error("ungated pending criterion");
      }
      const aggregate = milestoneStatuses.includes("fail") ? "fail" : milestoneStatuses.includes("pending") ? "pending" : "pass";
      if (aggregate !== report.overallStatus
        || (aggregate === "pass" && (report.pendingGates as unknown[]).length !== 0)) throw new Error("aggregation");
    }
    const serialized = JSON.stringify(parsed);
    if (PRIVATE_ABSOLUTE_PATH.test(serialized)
      || /"(?:stdout|stderr|ntfyTopic|rawHtml|rawOutput|topic|url)"\s*:/iu.test(serialized)) {
      throw new Error("private field");
    }
    return [];
  } catch {
    return [finding("PUBLIC_ACCEPTANCE_SCHEMA", "public-export", path, "Public acceptance artifact has an invalid or non-sanitized schema")];
  }
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
  const exactKeys = (object: Record<string, unknown>, keys: string[]): boolean =>
    Object.keys(object).sort().join("\0") === [...keys].sort().join("\0");
  if (
    !exactKeys(value, ["artifacts", "checks", "completedAt", "runtimes", "schemaVersion", "sourceCommit", "status"])
    || value.schemaVersion !== 1
    || value.status !== "pass"
    || typeof value.sourceCommit !== "string"
    || !COMMIT_PATTERN.test(value.sourceCommit)
    || typeof value.completedAt !== "string"
    || !Number.isFinite(Date.parse(value.completedAt))
    || new Date(value.completedAt).toISOString() !== value.completedAt
    || typeof value.runtimes !== "object"
    || value.runtimes === null
    || !Array.isArray(value.checks)
    || !Array.isArray(value.artifacts)
  ) {
    throw new TypeError("Fresh-clone receipt has an invalid shape");
  }
  const runtimes = value.runtimes as Record<string, unknown>;
  if (!exactKeys(runtimes, ["node", "npm", "python"])) {
    throw new TypeError("Fresh-clone receipt runtimes are not exactly allowlisted");
  }
  for (const name of ["node", "npm", "python"]) {
    if (typeof runtimes[name] !== "string" || runtimes[name] === "") {
      throw new TypeError("Fresh-clone receipt runtime is invalid");
    }
  }
  if (!/^v24\./u.test(String(runtimes.node)) || !/^11\./u.test(String(runtimes.npm))) {
    throw new TypeError("Fresh-clone receipt runtime is outside the declared Node/npm range");
  }
  const expectedChecks = ["analysis", "publication", "setup", "smoke"];
  const checkIds: string[] = [];
  for (const check of value.checks) {
    if (
      typeof check !== "object"
      || check === null
      || Array.isArray(check)
      || !exactKeys(check as Record<string, unknown>, ["exitCode", "id", "outputSha256"])
      || typeof (check as Record<string, unknown>).id !== "string"
      || (check as Record<string, unknown>).exitCode !== 0
      || typeof (check as Record<string, unknown>).outputSha256 !== "string"
      || !SHA256_PATTERN.test((check as Record<string, unknown>).outputSha256 as string)
    ) {
      throw new TypeError("Fresh-clone receipt check is invalid");
    }
    checkIds.push((check as Record<string, unknown>).id as string);
  }
  if (new Set(checkIds).size !== checkIds.length
    || [...checkIds].sort().join("\0") !== expectedChecks.join("\0")) {
    throw new TypeError("Fresh-clone receipt check IDs must be unique and complete");
  }
  const artifactPaths: string[] = [];
  for (const artifact of value.artifacts) {
    if (typeof artifact !== "object" || artifact === null || Array.isArray(artifact)) {
      throw new TypeError("Fresh-clone receipt artifact is invalid");
    }
    const item = artifact as Record<string, unknown>;
    if (
      !exactKeys(item, ["path", "sha256"])
      || typeof item.path !== "string"
      || isAbsolute(item.path)
      || item.path.split("/").includes("..")
      || typeof item.sha256 !== "string"
      || !SHA256_PATTERN.test(item.sha256)
    ) {
      throw new TypeError("Fresh-clone receipt artifact path must be relative and hashed");
    }
    artifactPaths.push(item.path);
  }
  const analysisArtifacts = artifactPaths.filter((path) => /^analysis\/output\/snapshots\/[^/]+\/manifest\.json$/u.test(path));
  const exportArtifacts = artifactPaths.filter((path) => /^data\/exports\/snapshots\/[^/]+\/manifest\.json$/u.test(path));
  if (new Set(artifactPaths).size !== artifactPaths.length
    || artifactPaths.length !== 2 || analysisArtifacts.length !== 1 || exportArtifacts.length !== 1) {
    throw new TypeError("Fresh-clone receipt artifacts must be the unique generated manifests");
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
  const prospectiveFiles = new Map<string, Buffer>();
  const worktreeFiles = new Map<string, Buffer>();

  for (const path of paths) {
    const absolute = resolve(root, path);
    if (!inside(root, absolute)) continue;
    const mode = modes.get(path);
    if (mode === "160000") {
      unsafeLinksOrSubmodules.push(finding("TRACKED_SUBMODULE", "repository-shape", path, "Git submodules are outside the publication audit boundary"));
      continue;
    }
    let metadata;
    try {
      metadata = lstatSync(absolute);
    } catch {
      metadata = undefined;
    }
    if (mode === "120000" || metadata?.isSymbolicLink() === true) {
      unsafeLinksOrSubmodules.push(finding("TRACKED_SYMLINK", "repository-shape", path, "Tracked symbolic links are not publication-safe"));
      continue;
    }
    let content: Buffer;
    if (mode !== undefined) {
      try {
        content = git(root, ["show", `:${path}`], "buffer");
      } catch {
        continue;
      }
    } else {
      if (metadata?.isFile() !== true) continue;
      content = readFileSync(absolute);
    }
    prospectiveFiles.set(path, content);
    if (metadata?.isFile() === true) worktreeFiles.set(path, readFileSync(absolute));
    const kind = privatePathKind(path);
    if (kind === "raw") {
      trackedRawHtml.push(finding("TRACKED_RAW_HTML", "tracked-tree", path, "Runtime raw HTML/replay evidence must not be tracked"));
    } else if (kind === "private") {
      trackedPrivateArtifacts.push(finding("TRACKED_PRIVATE_ARTIFACT", "tracked-tree", path, "Private runtime material must not be tracked"));
    }
    trackedSecrets.push(...secretFindings(content, path, "tracked-tree"));
    publicDataFindings.push(...auditFixtureHtml(content, path));
    if (path.endsWith(".csv")) publicDataFindings.push(...auditCsv(content, path));
    if (mode !== undefined && metadata?.isFile() === true) {
      const worktreeContent = worktreeFiles.get(path) ?? readFileSync(absolute);
      if (!worktreeContent.equals(content)) {
        trackedSecrets.push(...secretFindings(worktreeContent, path, "tracked-tree"));
        publicDataFindings.push(...auditFixtureHtml(worktreeContent, path));
        if (path.endsWith(".csv")) publicDataFindings.push(...auditCsv(worktreeContent, path));
      }
    }
  }

  for (const [path, content] of prospectiveFiles) {
    if (path.endsWith("/manifest.json")) {
      publicDataFindings.push(...auditManifest(content, path, root, prospectiveFiles));
    }
    if (path === "data/exports/latest.json" || path === "analysis/output/latest.json") {
      publicDataFindings.push(...auditLatest(content, path, root, prospectiveFiles));
    }
    if (/^data\/acceptance\/(?:acceptance\.json|evidence\/(?:fresh-clone|alert-drill|backup-drill)\.json)$/u.test(path)) {
      publicDataFindings.push(...auditAcceptanceArtifact(content, path));
    }
  }
  for (const [path, content] of worktreeFiles) {
    if (prospectiveFiles.get(path)?.equals(content) === true) continue;
    if (path.endsWith("/manifest.json")) {
      publicDataFindings.push(...auditManifest(content, path, root, worktreeFiles));
    }
    if (path === "data/exports/latest.json" || path === "analysis/output/latest.json") {
      publicDataFindings.push(...auditLatest(content, path, root, worktreeFiles));
    }
    if (/^data\/acceptance\/(?:acceptance\.json|evidence\/(?:fresh-clone|alert-drill|backup-drill)\.json)$/u.test(path)) {
      publicDataFindings.push(...auditAcceptanceArtifact(content, path));
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
  unsafeLinksOrSubmodules.push(...historicalUnsafeShapes(root));

  const temporaryDatabases = mkdtempSync(join(tmpdir(), "publication-sqlite-"));
  try {
    const auditedDatabasePaths = new Set<string>();
    for (const [path, content] of prospectiveFiles) {
      if (!isSqliteDatabase(content)) continue;
      const temporary = join(temporaryDatabases, `${sha256(path)}.sqlite`);
      writeFileSync(temporary, content, { mode: 0o600 });
      const sidecars = (["wal", "shm"] as const).map((suffix) => ({
        suffix,
        bytes: prospectiveFiles.get(`${path}-${suffix}`)?.length ?? 0,
      }));
      if (resolve(root, path) === resolve(options.databasePath)) {
        const liveWal = `${resolve(options.databasePath)}-wal`;
        if (existsSync(liveWal) && lstatSync(liveWal).size > 0) {
          sidecars[0] = { suffix: "wal", bytes: lstatSync(liveWal).size };
        }
      }
      publicDataFindings.push(...auditDatabase(temporary, root, path, sidecars));
      auditedDatabasePaths.add(resolve(root, path));
    }
    for (const [path, content] of worktreeFiles) {
      if (!isSqliteDatabase(content) || prospectiveFiles.get(path)?.equals(content) === true) continue;
      const temporary = join(temporaryDatabases, `${sha256(`worktree:${path}`)}.sqlite`);
      writeFileSync(temporary, content, { mode: 0o600 });
      const sidecars = (["wal", "shm"] as const).map((suffix) => ({ suffix, bytes: worktreeFiles.get(`${path}-${suffix}`)?.length ?? 0 }));
      publicDataFindings.push(...auditDatabase(temporary, root, path, sidecars));
    }
    const configuredDatabase = resolve(options.databasePath);
    if (existsSync(configuredDatabase)) {
      publicDataFindings.push(...auditDatabase(configuredDatabase, root));
    }
  } finally {
    rmSync(temporaryDatabases, { recursive: true, force: true });
  }

  const requiredDocsMissing = REQUIRED_DOCS.filter((path) => (prospectiveFiles.get(path)?.length ?? 0) === 0);
  const claims = readmeClaimsFromText(decodeUtf8(prospectiveFiles.get("README.md") ?? Buffer.alloc(0)) ?? "");
  const requiredClaims = [
    claims.researchPilot,
    claims.activeDevelopment,
    claims.defendedMethodClaim,
    claims.noStatisticalValidationClaim,
    claims.rawHtmlExcluded,
    claims.outOfScopeExplicit,
    claims.acceptanceCommandDocumented,
    claims.acceptanceReportLinked,
  ];
  const documentationFindings = [
    ...(requiredClaims.every(Boolean)
      ? []
      : [finding("README_CLAIMS", "documentation", "README.md", "README is missing one or more required research/limitation/acceptance claims")]),
    ...documentationContentFindings(prospectiveFiles),
    ...documentationContentFindings(worktreeFiles),
  ];
  const worktreeReadme = join(root, "README.md");
  if (existsSync(worktreeReadme)) {
    const worktreeClaims = readmeClaimsFromText(readFileSync(worktreeReadme, "utf8"));
    if (!Object.values(worktreeClaims).every(Boolean)) {
      documentationFindings.push(finding("README_CLAIMS", "documentation", "README.md", "README worktree content is missing a required research/limitation/acceptance claim"));
    }
  }
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
