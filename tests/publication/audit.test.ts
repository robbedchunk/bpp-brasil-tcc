import { execFileSync } from "node:child_process";
import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import Database from "better-sqlite3";
import { afterEach, describe, expect, it } from "vitest";

import { writeReplayPayload } from "../../src/collection/replay.js";
import { openDatabase } from "../../src/db/database.js";
import { createRun, insertObservation } from "../../src/db/repositories.js";
import {
  auditPublication,
  validateFreshCloneReceipt,
} from "../../src/publication/audit.js";
import {
  signHealingSabotageDrillReceipt,
  type HealingSabotageDrillPayload,
} from "../../src/ops/healing-drill.js";
import {
  canonicalEvidenceJson,
  validationAttestationKeyId,
} from "../../src/strategies/validation-evidence.js";
import {
  extractionStrategy,
  seedRetailer,
  seedStrategy,
} from "../pipeline/helpers.js";

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
    "See docs/acceptance-report.md for the generated report.",
  ].join("\n"));
  await writeFile(join(root, "LICENSE"), "MIT License\nCopyright (c) 2026 RobbedChunk\nPermission is hereby granted, free of charge, to any person obtaining a copy.\n");
  await writeFile(join(root, "SECURITY.md"), "Report security issues privately. Rotate exposed credentials; never attach raw retailer pages.\n");
  for (const name of [
    "methodology.md",
    "ethics-and-tos.md",
    "data-dictionary.md",
    "operations.md",
    "sources.md",
  ]) {
    const body = name === "sources.md"
      ? "IBGE POF 2017-2018, SIDRA table 7060, BCB EE069, DOI 10.1257/jep.30.2.151.\n"
      : "Publication-safe research documentation.\n";
    await writeFile(join(root, "docs", name), `# ${name}\n${body}`);
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

function historicalHealingPayload(sourceCommit: string): HealingSabotageDrillPayload {
  const retailerId = `m5-drill-${"1".repeat(12)}`;
  return {
    schemaVersion: 1,
    drill: "installed-release-healing-sabotage",
    status: "pass",
    drillId: "1".repeat(32),
    observedAt: "2024-01-01T12:00:00.000Z",
    release: {
      releaseId: "2".repeat(32),
      sourceCommit,
      manifestSha256: "3".repeat(64),
      artifactSetSha256: "4".repeat(64),
      implementationSha256: "5".repeat(64),
    },
    staging: {
      databaseRelativePath: `var/acceptance/m5-healing/${"1".repeat(32)}/staging.sqlite`,
      databaseSha256: "6".repeat(64),
      schemaVersion: 15,
      integrityCheck: "ok",
      foreignKeyViolations: 0,
      sourceSnapshotSha256Before: "7".repeat(64),
      sourceSnapshotSha256After: "7".repeat(64),
      sourceUnchanged: true,
      templateRetailerId: "extra-mercado",
      disposableRetailerId: retailerId,
      configSha256: "8".repeat(64),
      sabotageKind: "staging-only-invalid-json-field-selectors",
      brokenStrategySha256: "9".repeat(64),
      restoredSafetyTriggerSetSha256: "a".repeat(64),
    },
    brokenRun: {
      id: "broken-run",
      strategyId: `${retailerId}-extraction-v1`,
      strategyVersion: 1,
      attempted: 30,
      ok: 0,
      failed: 30,
      successRate: 0,
      status: "failed",
    },
    monitor: {
      health: "drift",
      action: "queued",
      healingEventId: "healing-event",
    },
    healing: {
      status: "recovered",
      attempts: 1,
      activated: true,
      explorationRunId: "exploration-run",
      successorStrategyId: `${retailerId}-extraction-v2`,
      successorStrategyVersion: 2,
    },
    cost: {
      provider: "codex-sdk",
      model: "gpt-5.6-sol",
      reservationStatus: "settled",
      reservationAmountUsd: 25,
      actualCostUsd: 0.12,
      ledgerRows: 1,
      inputTokens: 1_000,
      outputTokens: 200,
    },
    validation: {
      receiptPath: `data/validation/${retailerId}-extraction-v2.json`,
      receiptSha256: "b".repeat(64),
      sampleSetSha256: "c".repeat(64),
      attempted: 30,
      valid: 30,
      score: 1,
      executorMode: "trusted-live-host",
      validatorArtifactSha256: "d".repeat(64),
      challengeAlgorithm: "active-in-scope-category-url-bucket-round-robin-v1",
    },
    recoveredRun: {
      id: "recovered-run",
      strategyId: `${retailerId}-extraction-v2`,
      strategyVersion: 2,
      attempted: 30,
      ok: 30,
      failed: 0,
      successRate: 1,
      status: "completed",
    },
  };
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

  it("requires final acceptance JSON and Markdown only at the publication cut", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);

    const duringImplementation = await auditPublication(options(root));
    expect(duringImplementation.requiredDocsMissing).not.toContain("data/acceptance/acceptance.json");
    expect(duringImplementation.requiredDocsMissing).not.toContain("docs/acceptance-report.md");

    const finalCut = await auditPublication({
      ...options(root),
      requireAcceptanceEvidence: true,
    });
    expect(finalCut.requiredDocsMissing).toEqual(expect.arrayContaining([
      "data/acceptance/acceptance.json",
      "docs/acceptance-report.md",
    ]));
    expect(finalCut.status).toBe("fail");

    await mkdir(join(root, "data", "acceptance"), { recursive: true });
    await writeFile(join(root, "data", "acceptance", "acceptance.json"), "{}\n");
    await writeFile(join(root, "docs", "acceptance-report.md"), "# Generated acceptance\n");
    const malformed = await auditPublication({
      ...options(root),
      requireAcceptanceEvidence: true,
    });
    expect(malformed.requiredDocsMissing).toEqual([]);
    expect(malformed.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_ACCEPTANCE_SCHEMA" }),
    ]));
  });

  it("rejects a malformed or filename-misbound public classification review result", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data", "acceptance", "evidence"), { recursive: true });
    await writeFile(join(root, "data", "acceptance", "evidence", "classification-review-v2.json"), JSON.stringify({
      schemaVersion: 1,
      status: "complete",
      classificationVersion: 3,
      sampleSize: 200,
    }));

    const report = await auditPublication({
      ...options(root),
      requireAcceptanceEvidence: true,
    });
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        ruleId: "PUBLIC_ACCEPTANCE_SCHEMA",
        location: "data/acceptance/evidence/classification-review-v2.json",
      }),
    ]));
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

  it("does not mix an unrelated local ref into the prospective publication history", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const publicationBranch = git(root, "branch", "--show-current");
    git(root, "checkout", "-qb", "unrelated-history");
    const credential = ["sk", "proj", "C".repeat(32)].join("-");
    await writeFile(join(root, "unrelated-key.txt"), credential);
    git(root, "add", "unrelated-key.txt");
    git(root, "commit", "-qm", "unrelated unpublished history");
    git(root, "checkout", "-q", publicationBranch);

    const report = await auditPublication(options(root));

    expect(report.historicalSecrets).toEqual([]);
    expect(report.status).toBe("pass");
  });

  it("audits staged index bytes even when the worktree hides them", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const credential = ["sk", "proj", "B".repeat(32)].join("-");
    await writeFile(join(root, "staged.txt"), credential);
    git(root, "add", "staged.txt");
    await writeFile(join(root, "staged.txt"), "safe worktree text\n");

    const report = await auditPublication(options(root));

    expect(report.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_OPENAI_KEY", location: "staged.txt:1" }),
    ]));
    expect(JSON.stringify(report)).not.toContain(credential);
  });

  it("allows blank example credentials and rejects configured tracked credentials", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await writeFile(
      join(root, ".env.example"),
      "OPENAI_API_KEY=\nOPENAI_BASE_URL=\nCODEX_API_KEY=\nCODEX_BASE_URL=\nNTFY_TOPIC=\n",
    );
    git(root, "add", ".env.example");
    git(root, "commit", "-qm", "add safe example");
    const safe = await auditPublication(options(root));
    expect(safe.trackedSecrets).toEqual([]);

    await writeFile(join(root, ".env.example"), `OPENAI_API_KEY=${["sk", "A".repeat(32)].join("-")}\n`);
    const unsafe = await auditPublication(options(root));
    expect(unsafe.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_OPENAI_KEY", location: ".env.example:1" }),
    ]));

    await writeFile(join(root, ".env.example"), "OPENAI_BASE_URL=https://gateway.example/v1\n");
    const configuredEndpoint = await auditPublication(options(root));
    expect(configuredEndpoint.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_CONFIGURED_ENV", location: ".env.example:1" }),
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

  it("does not allowlist configured credentials merely because they are test sentinels", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "tests"), { recursive: true });
    await writeFile(join(root, "tests", "unsafe-env.txt"), "OPENAI_API_KEY=test-secret-value-123456789\n");
    git(root, "add", "tests/unsafe-env.txt");

    const report = await auditPublication(options(root));

    expect(report.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_CONFIGURED_ENV" }),
    ]));
  });

  it("detects long Basic authorization material without returning it", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const encoded = Buffer.from("operator:private-password").toString("base64");
    await writeFile(join(root, "request.txt"), `Authorization: Basic ${encoded}\n`);

    const report = await auditPublication(options(root));
    expect(report.trackedSecrets).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "SECRET_BASIC", location: "request.txt:1" }),
    ]));
    expect(JSON.stringify(report)).not.toContain(encoded);
  });

  it("rejects sensitive state even inside sanitized fixture HTML", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "tests", "fixtures"), { recursive: true });
    await writeFile(join(root, "tests", "fixtures", "leak.html"), "<main data-session-id=\"abc\">Set-Cookie: cart=abc; address: private</main>\n");
    git(root, "add", "tests/fixtures/leak.html");

    const report = await auditPublication(options(root));
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "FIXTURE_PRIVATE_DATA" }),
    ]));
  });

  it("audits public SQLite text without mutating the database", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data"), { recursive: true });
    const databasePath = join(root, "data", "precos.sqlite");
    const database = new Database(databasePath);
    database.pragma("journal_mode = WAL");
    database.exec("CREATE TABLE published(id TEXT PRIMARY KEY, response_body TEXT, response_path TEXT);");
    database.prepare("INSERT INTO published VALUES (?, ?, ?)")
      .run("1", "<!doctype html><html>raw</html>", "/home/operator/private/page.html");
    const before = await readFile(databasePath);
    git(root, "add", "-f", "data/precos.sqlite");

    const report = await auditPublication(options(root, databasePath));

    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_RAW_HTML" }),
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_PRIVATE_PATH" }),
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_WAL_DEPENDENCY" }),
    ]));
    expect(await readFile(databasePath)).toEqual(before);
    database.close();
  });

  it("accepts exact logical replay references but still rejects a tracked private artifact", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const databasePath = join(root, "data", "precos.sqlite");
    const replayRoot = join(root, "data", "raw-html");
    const database = openDatabase(":memory:");
    seedRetailer(database);
    const strategyId = seedStrategy(database, "extraction", extractionStrategy);
    database.prepare(`
      INSERT INTO products
        (id, retailer_id, canonical_url, retailer_product_id, title, first_seen, last_seen)
      VALUES ('product-1', 'retailer-1', 'https://shop.test/arroz', '123',
              'Arroz tipo 1 pacote 5 kg', '2026-07-10T00:00:00.000Z',
              '2026-07-10T00:00:00.000Z')
    `).run();
    createRun(database, {
      id: "collection-1",
      retailerId: "retailer-1",
      stage: "collect",
      collectionDay: "2026-07-10",
      strategyId,
      strategyVersion: 1,
      startedAt: "2026-07-10T12:00:00.000Z",
    });
    const artifact = await writeReplayPayload({
      body: JSON.stringify({ title: "Arroz tipo 1 pacote 5 kg", price: 12.99 }),
      mediaType: "application/json",
    }, replayRoot, "2026-07-10", "retailer-1");
    insertObservation(database, {
      product: {
        id: "product-1",
        canonicalUrl: "https://shop.test/arroz",
        externalId: "123",
        sourceCategory: "Mercearia",
      },
      runId: "collection-1",
      result: {
        ok: true,
        fields: {
          title: "Arroz tipo 1 pacote 5 kg",
          brand: "Marca",
          price: 12.99,
          promoPrice: null,
          unit: "5 kg",
          available: true,
        },
      },
      observedAt: "2026-07-10T12:00:01.000Z",
      collectionDay: "2026-07-10",
      strategyId,
      strategyVersion: 1,
      replay: { path: artifact.path, sha256: artifact.sha256 },
    });
    await database.backup(databasePath);
    database.close();

    const safe = await auditPublication(options(root, databasePath));
    expect(safe.publicDataFindings).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_REPLAY_PATH" }),
    ]));

    git(root, "add", "-f", join("data", "raw-html", artifact.path));
    const tracked = await auditPublication(options(root, databasePath));
    expect(tracked.trackedRawHtml).toEqual(expect.arrayContaining([
      expect.objectContaining({ location: `data/raw-html/${artifact.path}` }),
    ]));
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

  it("rejects malformed manifest entries and non-UTF-8 public CSV bytes", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const snapshot = join(root, "data", "exports", "snapshots", "unsafe");
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "bad.csv"), Uint8Array.from([0xff, 0xfe, 0x0a]));
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ files: [
      { path: "bad.csv" },
      null,
    ] }));
    git(root, "add", "data");

    const report = await auditPublication(options(root));
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_CSV_UTF8" }),
      expect.objectContaining({ ruleId: "PUBLIC_MANIFEST_ENTRY" }),
    ]));
  });

  it("audits a divergent unstaged manifest instead of trusting only the index", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const snapshot = join(root, "data", "exports", "snapshots", "safe");
    await mkdir(snapshot, { recursive: true });
    await writeFile(join(snapshot, "rows.csv"), "id\n1\n");
    const digest = createHash("sha256").update("id\n1\n").digest("hex");
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ files: [{ path: "rows.csv", sha256: digest }] }));
    git(root, "add", "data");
    git(root, "commit", "-qm", "safe manifest");
    await writeFile(join(snapshot, "manifest.json"), JSON.stringify({ files: [{ path: "rows.csv" }] }));

    const report = await auditPublication(options(root));
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_MANIFEST_ENTRY" }),
    ]));
  });

  it("rejects a deleted symlink that remains in reachable history", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await symlink("README.md", join(root, "historical-link"));
    git(root, "add", "historical-link");
    git(root, "commit", "-qm", "historical symlink");
    await rm(join(root, "historical-link"));
    git(root, "add", "-u");
    git(root, "commit", "-qm", "remove symlink");

    const report = await auditPublication(options(root));
    expect(report.unsafeLinksOrSubmodules).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "HISTORICAL_SYMLINK", location: "historical-link" }),
    ]));
  });

  it("audits every tracked SQLite file, private schema names, and sidecars", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data"), { recursive: true });
    const secondPath = join(root, "data", "other.sqlite");
    const second = new Database(secondPath);
    second.exec("CREATE TABLE unsafe(cookie TEXT, public_value TEXT);");
    second.close();
    await writeFile(`${secondPath}-shm`, "runtime-sidecar");
    git(root, "add", "-f", "data/other.sqlite", "data/other.sqlite-shm");

    const report = await auditPublication(options(root));
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_PRIVATE_SCHEMA" }),
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_SIDECAR" }),
    ]));
  });

  it("detects SQLite by magic and scans typeless cells plus CSV values", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data"), { recursive: true });
    const extensionless = join(root, "data", "public-snapshot");
    const database = new Database(extensionless);
    database.exec("CREATE TABLE payload(value);");
    database.prepare("INSERT INTO payload(value) VALUES (?)")
      .run("<html>Set-Cookie: session_id=private</html>");
    database.close();
    await writeFile(join(root, "data", "values.csv"),
      'id,value\n1,"<html>Set-Cookie: session_id=private</html>"\n');
    git(root, "add", "data");

    const report = await auditPublication(options(root));
    expect(report.publicDataFindings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_RAW_HTML", location: "data/public-snapshot:payload.value" }),
      expect.objectContaining({ ruleId: "PUBLIC_DATABASE_PRIVATE_DATA", location: "data/public-snapshot:payload.value" }),
      expect.objectContaining({ ruleId: "PUBLIC_CSV_RAW_HTML" }),
      expect.objectContaining({ ruleId: "PUBLIC_CSV_PRIVATE_DATA" }),
    ]));
  });

  it("makes dynamic README acceptance claims mandatory", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const readme = await readFile(join(root, "README.md"), "utf8");
    await writeFile(join(root, "README.md"), readme.replace("docs/acceptance-report.md", "evidence report"));

    const report = await auditPublication(options(root));
    expect(report.status).toBe("fail");
    expect(report.findings).toEqual(expect.arrayContaining([
      expect.objectContaining({ ruleId: "README_CLAIMS" }),
    ]));
  });

  it("validates strict fresh-clone receipts and rejects absolute paths", () => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    const payload = {
      schemaVersion: 2,
      status: "pass",
      sourceCommit: "a".repeat(40),
      cloneCommit: "a".repeat(40),
      completedAt: "2026-07-10T12:00:00.000Z",
      verifierSha256: "e".repeat(64),
      runtimes: { node: "v24.18.0", npm: "11.16.0", python: "3.14.4" },
      checks: ["setup", "smoke", "publication", "analysis"].map((id) => ({
        id,
        exitCode: 0 as const,
        outputSha256: "b".repeat(64),
      })),
      artifacts: [
        { path: "analysis/output/snapshots/sample/manifest.json", sha256: "c".repeat(64) },
        { path: "data/exports/snapshots/sample/manifest.json", sha256: "d".repeat(64) },
      ],
    };
    const canonical = canonicalEvidenceJson(payload);
    const valid = {
      ...payload,
      attestation: {
        algorithm: "ed25519",
        keyId: validationAttestationKeyId(publicKey),
        payloadSha256: createHash("sha256").update(canonical).digest("hex"),
        signature: sign(null, Buffer.from(canonical), privateKey).toString("base64"),
      },
    };
    expect(validateFreshCloneReceipt(valid, publicKey)).toEqual(valid);
    expect(() => validateFreshCloneReceipt({
      ...valid,
      artifacts: [{ path: "/home/operator/private.json", sha256: "c".repeat(64) }],
    }, publicKey)).toThrow(/relative/i);
    expect(() => validateFreshCloneReceipt({
      ...valid,
      checks: [valid.checks[0], valid.checks[0]],
    }, publicKey)).toThrow(/unique|check/i);
    expect(() => validateFreshCloneReceipt({
      ...valid,
      verifierSha256: "f".repeat(64),
    }, publicKey)).toThrow(/attestation/i);
  });

  it("retains optional signed healing evidence as an ancestor-bound historical fact", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    await mkdir(join(root, "ops"), { recursive: true });
    await writeFile(
      join(root, "ops", "validation-attestation-public.pem"),
      publicKey.export({ type: "spki", format: "pem" }),
    );
    git(root, "add", "ops/validation-attestation-public.pem");
    git(root, "commit", "-qm", "add validation key");
    const ancestorCommit = git(root, "rev-parse", "HEAD");
    await writeFile(join(root, "docs", "methodology.md"), "# Methodology\nLater cut.\n");
    git(root, "add", "docs/methodology.md");
    git(root, "commit", "-qm", "later implementation cut");
    const evaluatedCommit = git(root, "rev-parse", "HEAD");
    const receiptPath = join(
      root,
      "data",
      "acceptance",
      "evidence",
      "healing-sabotage-drill.json",
    );
    await mkdir(join(root, "data", "acceptance", "evidence"), { recursive: true });
    const writeReceipt = async (sourceCommit: string) => {
      const receipt = signHealingSabotageDrillReceipt(
        historicalHealingPayload(sourceCommit),
        privateKey,
      );
      await writeFile(receiptPath, `${JSON.stringify(receipt)}\n`);
    };
    const receiptFindings = async () => {
      const report = await auditPublication({
        ...options(root),
        now: () => new Date("2026-07-24T12:00:00.000Z"),
        requireAcceptanceEvidence: true,
        evaluatedCommit,
      });
      return report.publicDataFindings.filter(({ location }) =>
        location === "data/acceptance/evidence/healing-sabotage-drill.json");
    };

    await writeReceipt(ancestorCommit);
    expect(await receiptFindings()).toEqual([]);

    await writeReceipt("f".repeat(40));
    expect(await receiptFindings()).toEqual([
      expect.objectContaining({ ruleId: "PUBLIC_ACCEPTANCE_SCHEMA" }),
    ]);
  });

  it("rejects malformed public acceptance timestamps, criteria, summaries, and evidence", async () => {
    const root = await temporaryRoot();
    await initializeRepository(root);
    await mkdir(join(root, "data", "acceptance"), { recursive: true });
    const evaluatedCommit = git(root, "rev-parse", "HEAD");
    const generatedAt = "2026-07-10T12:00:00.000Z";
    const readmeClaims = Object.fromEntries([
      "researchPilot", "activeDevelopment", "defendedMethodClaim",
      "noStatisticalValidationClaim", "rawHtmlExcluded", "outOfScopeExplicit",
      "acceptanceCommandDocumented", "acceptanceReportLinked",
    ].map((key) => [key, true]));
    const publication = {
      schemaVersion: 1,
      generatedAt,
      commit: evaluatedCommit,
      status: "pass",
      trackedSecrets: [],
      historicalSecrets: [],
      trackedPrivateArtifacts: [],
      trackedRawHtml: [],
      unsafeLinksOrSubmodules: [],
      publicDataFindings: [],
      requiredDocsMissing: [],
      readmeClaims,
      workingTreeClean: true,
      findings: [],
    };
    const criterion = {
      id: "verified-criterion",
      status: "pass",
      summary: "Verified with public evidence",
      reasonCodes: [],
      evidenceIds: ["public-evidence"],
    };
    const valid = {
      schemaVersion: 1,
      generatedAt,
      timezone: "America/Sao_Paulo",
      evaluatedCommit,
      databaseSha256: "a".repeat(64),
      overallStatus: "pass",
      milestones: Object.fromEntries(["M0", "M1", "M2", "M3", "M4", "M5", "M6", "M7"]
        .map((id) => [id, { status: "pass", criteria: [{ ...criterion, id: `${id.toLowerCase()}-verified` }] }])),
      publication,
      pendingGates: [],
      evidence: [{
        id: "public-evidence",
        kind: "file",
        source: "README.md",
        observedAt: generatedAt,
        facts: { verified: true },
      }],
    };
    const path = join(root, "data", "acceptance", "acceptance.json");
    const schemaFindings = async (value: unknown) => {
      await writeFile(path, `${JSON.stringify(value)}\n`);
      const report = await auditPublication({ ...options(root), requireAcceptanceEvidence: true });
      return report.publicDataFindings.filter((item) => item.ruleId === "PUBLIC_ACCEPTANCE_SCHEMA");
    };
    expect(await schemaFindings(valid)).toEqual([]);
    expect(await schemaFindings({ ...valid, generatedAt: 123 })).not.toEqual([]);
    const emptyId = structuredClone(valid);
    emptyId.milestones.M0.criteria[0]!.id = "";
    expect(await schemaFindings(emptyId)).not.toEqual([]);
    const missingSummary = structuredClone(valid) as unknown as { milestones: Record<string, { criteria: Array<Record<string, unknown>> }> };
    delete missingSummary.milestones.M0!.criteria[0]!.summary;
    expect(await schemaFindings(missingSummary)).not.toEqual([]);
    const noEvidence = structuredClone(valid);
    noEvidence.milestones.M0.criteria[0]!.evidenceIds = [];
    expect(await schemaFindings(noEvidence)).not.toEqual([]);
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
  }, 90_000);
});
