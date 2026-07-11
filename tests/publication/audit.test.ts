import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import {
  auditPublication,
  validateFreshCloneReceipt,
} from "../../src/publication/audit.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "publication-audit-"));
  roots.push(root);
  return root;
}

function git(root: string, ...args: string[]): string {
  return execFileSync("git", args, { cwd: root, encoding: "utf8" }).trim();
}

async function writeDocs(root: string): Promise<void> {
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(join(root, "README.md"), [
    "# Research pilot under active development",
    "The defended claim is the self-healing extraction method.",
    "The experimental index is a demonstration with no statistical validation claim.",
    "Raw HTML is excluded from publication.",
    "Out of scope: other regions, dashboards, hedonic adjustment, proxies.",
    "Run `npm run acceptance -- --json` for current evidence.",
  ].join("\n"));
  await writeFile(join(root, "LICENSE"), "MIT License\nCopyright (c) 2026 RobbedChunk\n");
  await writeFile(join(root, "SECURITY.md"), "Report security issues privately.\n");
  for (const name of [
    "methodology.md",
    "ethics-and-tos.md",
    "data-dictionary.md",
    "operations.md",
    "sources.md",
  ]) {
    await writeFile(join(root, "docs", name), `# ${name}\nPublication-safe research documentation.\n`);
  }
}

async function initializeRepository(root: string): Promise<void> {
  git(root, "init", "-q");
  git(root, "config", "user.name", "Audit Test");
  git(root, "config", "user.email", "audit@example.test");
  await writeDocs(root);
  await writeFile(join(root, ".gitignore"), ".env\nvar/\ndata/raw-html/\n*.sqlite-wal\n*.sqlite-shm\n");
  git(root, "add", ".");
  git(root, "commit", "-qm", "fixture");
}

function options(root: string, databasePath = join(root, "missing.sqlite")) {
  return {
    projectRoot: root,
    databasePath,
    now: () => new Date("2026-07-10T12:00:00.000Z"),
    requireClean: false,
  } as const;
}

describe("publication audit", () => {
  it("reports every missing required public document", async () => {
    const root = await temporaryRoot();
    git(root, "init", "-q");

    const report = await auditPublication(options(root));

    expect(report.requiredDocsMissing).toEqual([
      "README.md",
      "LICENSE",
      "SECURITY.md",
      "docs/methodology.md",
      "docs/ethics-and-tos.md",
      "docs/data-dictionary.md",
      "docs/operations.md",
      "docs/sources.md",
    ]);
    expect(report.status).toBe("fail");
  });

  it("finds a credential deleted from the current tree without returning its value", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const credential = ["sk", "proj", "A".repeat(32)].join("-");
    await writeFile(join(root, "temporary-key.txt"), credential);
    git(root, "add", "temporary-key.txt");
    git(root, "commit", "-qm", "add credential by mistake");
    await rm(join(root, "temporary-key.txt"));
    git(root, "add", "-u");
    git(root, "commit", "-qm", "delete credential");

    const report = await auditPublication(options(root));
    const serialized = JSON.stringify(report);

    expect(report.historicalSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_OPENAI_KEY", location: "temporary-key.txt:1" }),
    ]));
    expect(serialized).not.toContain(credential);
    expect(report.status).toBe("fail");
  });

  it("allows blank example credentials and rejects configured tracked credentials", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await writeFile(join(root, ".env.example"), "OPENAI_API_KEY=\nCODEX_API_KEY=\nNTFY_TOPIC=\n");
    git(root, "add", ".env.example");
    git(root, "commit", "-qm", "add safe example");
    const safe = await auditPublication(options(root));
    expect(safe.trackedSecrets).toEqual([]);

    await writeFile(join(root, ".env.example"), `OPENAI_API_KEY=${["sk", "A".repeat(32)].join("-")}\n`);
    const unsafe = await auditPublication(options(root));
    expect(unsafe.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_OPENAI_KEY", location: ".env.example:1" }),
    ]));
  });

  it("allows sanitized fixture HTML but rejects runtime raw HTML and tracked symlinks", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "tests", "fixtures"), { recursive: true });
    await writeFile(join(root, "tests", "fixtures", "product.html"), "<main>Arroz</main>\n");
    await mkdir(join(root, "data", "raw-html"), { recursive: true });
    await writeFile(join(root, "data", "raw-html", "page.html"), "<html>runtime response</html>\n");
    await symlink("../.env", join(root, "published-secret-link"));
    git(root, "add", "-f", "tests/fixtures/product.html", "data/raw-html/page.html", "published-secret-link");

    const report = await auditPublication(options(root));

    expect(report.trackedRawHtml).toEqual([
      expect.objectContaining({ location: "data/raw-html/page.html" }),
    ]);
    expect(report.unsafeLinksOrSubmodules).toEqual([
      expect.objectContaining({ location: "published-secret-link" }),
    ]);
    expect(report.trackedRawHtml).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ location: "tests/fixtures/product.html" }),
    ]));
  });

  it("audits public SQLite text without mutating the database", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data"), { recursive: true });
    const databasePath = join(root, "data", "precos.sqlite");
    const database = new Database(databasePath);
    database.exec("CREATE TABLE published(id TEXT PRIMARY KEY, response_body TEXT, response_path TEXT);");
    database.prepare("INSERT INTO published VALUES (?, ?, ?)")
      .run("1", "<!doctype html><html>raw</html>", "/home/operator/private/page.html");
    database.close();
    const before = await readFile(databasePath);
    git(root, "add", "-f", "data/precos.sqlite");

    const report = await auditPublication(options(root, databasePath));

    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_RAW_HTML" }),
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_PRIVATE_PATH" }),
    ]));
    expect(await readFile(databasePath)).toEqual(before);
  });

  it("rejects unsafe public CSV columns and manifest traversal", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const snapshot = join(root, "data", "exports", "snapshots", "unsafe");
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "runs.csv"), "run_id,response_path\n1,/home/private/page.html\n");
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({
      schemaVersion: 1,
      files: [{ path: "../../../../outside.csv", sha256: "0".repeat(64) }],
    }));
    git(root, "add", "data");

    const report = await auditPublication(options(root));

    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_CSV_PRIVATE_COLUMN" }),
      expect.objectContaining({ ruleId: "PUBLIC_MANIFEST_PATH" }),
    ]));
  });

  it("validates strict fresh-clone receipts and rejects absolute paths", () => {
    const valid = {
      schemaVersion: 1,
      status: "pass",
      sourceCommit: "a".repeat(40),
      completedAt: "2026-07-10T12:00:00.000Z",
      runtimes: { node: "v24.18.0", npm: "11.16.0", python: "3.14.4" },
      checks: [{ id: "smoke", exitCode: 0, outputSha256: "b".repeat(64) }],
      artifacts: [{ path: "analysis/output/latest.json", sha256: "c".repeat(64) }],
    };
    expect(validateFreshCloneReceipt(valid)).toEqual(valid);
    expect(() => validateFreshCloneReceipt({
      ...valid,
      artifacts: [{ path: "/home/operator/private.json", sha256: "c".repeat(64) }],
    })).toThrow(/relative/i);
  });

  it("passes against the prospective real publication tree", async () => {
    const root = resolve(".");
    const report = await auditPublication(options(root, resolve("data/precos.sqlite")));

    expect(report.status).toBe("pass");
    expect(report.findings).toEqual([]);
    expect(report.readmeClaims).toMatchObject({
      researchPilot: true,
      activeDevelopment: true,
      defendedMethodClaim: true,
      noStatisticalValidationClaim: true,
      rawHtmlExcluded: true,
      outOfScopeExplicit: true,
    });
  }, 30_000);
});
