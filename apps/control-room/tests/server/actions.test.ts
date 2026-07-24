// @vitest-environment node

import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { FastifyInstance } from "fastify";
import { afterEach, describe, expect, it, vi } from "vitest";

import { openDatabase } from "../../../../src/db/database.js";
import type { ActionParameters, ActionPreview, Job } from "../../src/shared/contracts.js";
import { ActionService } from "../../src/server/actions/service.js";
import type { ControlRoomConfig } from "../../src/server/config.js";
import { buildServer } from "../../src/server/index.js";
import { ReadModelService } from "../../src/server/read-model/database.js";

const directories: string[] = [];
const servers: FastifyInstance[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
  await Promise.all(directories.splice(0).map((directory) =>
    rm(directory, { recursive: true, force: true })));
});

async function root(): Promise<string> {
  const value = await mkdtemp(join(tmpdir(), "control-room-actions-"));
  directories.push(value);
  return value;
}

function configuration(projectRoot: string, actionsEnabled: boolean): ControlRoomConfig {
  return {
    packageRoot: join(projectRoot, "apps/control-room"),
    projectRoot,
    databasePath: join(projectRoot, "data/precos.sqlite"),
    host: "127.0.0.1",
    port: 4318,
    actionsEnabled,
    development: true,
    staticRoot: join(projectRoot, "apps/control-room/dist/web"),
    openaiConfigured: true,
    notificationConfigured: false,
    modelBudgetLimitUsd: 50,
  };
}

function seed(projectRoot: string): void {
  const database = openDatabase(join(projectRoot, "data/precos.sqlite"));
  database.prepare(`
    INSERT INTO retailers (id, name, base_url, cep, domains_json, active)
    VALUES ('fork-shop', 'Fork Shop', 'https://fork.invalid',
            '01310-100', '["fork.invalid"]', 1)
  `).run();
  database.close();
}

function digest(value: Buffer): string {
  return createHash("sha256").update(value).digest("hex");
}

function plan(parameters: ActionParameters, estimatedCostUsd: number | null = null): ActionPreview["plan"] {
  return {
    title: `Preview ${parameters.kind}`,
    scope: parameters.kind === "collect" || parameters.kind === "discover"
      ? parameters.retailerId
      : parameters.kind,
    metrics: [{ label: "Itens", value: "3" }],
    estimatedCostUsd,
    warnings: ["Fixture read-only"],
  };
}

function fakeRunner(options: { changing?: boolean; estimatedCostUsd?: number | null } = {}) {
  let previews = 0;
  let executions = 0;
  return {
    get previewCount() { return previews; },
    get executionCount() { return executions; },
    async runtime(): Promise<ActionPreview["runtime"]> {
      return {
        kind: "checkout-build",
        artifactSha256: "a".repeat(64),
        protocolVersion: 1,
      };
    },
    async preview(parameters: ActionParameters) {
      previews += 1;
      const value = plan(parameters, options.estimatedCostUsd ?? null);
      return {
        plan: options.changing && previews > 1
          ? { ...value, metrics: [{ label: "Itens", value: "4" }] }
          : value,
        raw: {},
      };
    },
    async execute(parameters: ActionParameters): Promise<{
      safeResult: NonNullable<Job["result"]>;
      exitCode: number;
      stdoutSha256: string;
      stderrSha256: string;
    }> {
      executions += 1;
      return {
        safeResult: {
          title: `Executed ${parameters.kind}`,
          metrics: [{ label: "Itens", value: "3" }],
          domainIds: ["run-fixture"],
        },
        exitCode: 0,
        stdoutSha256: "b".repeat(64),
        stderrSha256: "c".repeat(64),
      };
    },
  };
}

async function enabledServer(projectRoot: string, runner = fakeRunner()) {
  const config = configuration(projectRoot, true);
  const readModel = new ReadModelService(config.projectRoot, config.databasePath);
  let tick = 0;
  const now = () => new Date(Date.parse("2026-03-02T12:00:00.000Z") + tick++ * 1_000);
  const actions = new ActionService(config, readModel, now, { runner });
  const server = await buildServer(config, readModel, actions);
  servers.push(server);
  return { server, actions, runner };
}

const actionHeaders = {
  host: "127.0.0.1:4318",
  "content-type": "application/json",
  "x-control-room-intent": "action",
};

describe("Control Room guarded actions", () => {
  it("keeps observer mode non-mutating and rejects previews", async () => {
    const projectRoot = await root();
    seed(projectRoot);
    const config = configuration(projectRoot, false);
    const server = await buildServer(config);
    servers.push(server);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/preview",
      headers: actionHeaders,
      payload: { kind: "collect", retailerId: "fork-shop", limit: 3 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "actions_disabled" } });
    await expect(stat(join(projectRoot, "var/control-room/control.sqlite")))
      .rejects.toMatchObject({ code: "ENOENT" });
  });

  it("previews read-only, confirms once, and stores only a sanitized receipt", async () => {
    const projectRoot = await root();
    seed(projectRoot);
    const databasePath = join(projectRoot, "data/precos.sqlite");
    const before = digest(await readFile(databasePath));
    const { server, runner } = await enabledServer(projectRoot);

    const previewResponse = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/preview",
      headers: actionHeaders,
      payload: { kind: "collect", retailerId: "fork-shop", limit: 3 },
    });
    expect(previewResponse.statusCode).toBe(200);
    const preview = previewResponse.json<ActionPreview>();
    expect(preview).toMatchObject({
      action: "collect",
      impact: { network: true, primaryDatabaseWrites: true, lockState: "unlocked" },
      plan: { scope: "fork-shop" },
    });
    expect(digest(await readFile(databasePath))).toBe(before);
    await expect(stat(join(projectRoot, "var/precos-pipeline.lock")))
      .rejects.toMatchObject({ code: "ENOENT" });

    const wrong = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/execute",
      headers: actionHeaders,
      payload: { previewId: preview.id, confirmationPhrase: "WRONG" },
    });
    expect(wrong.statusCode).toBe(400);

    const execute = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/execute",
      headers: actionHeaders,
      payload: {
        previewId: preview.id,
        confirmationPhrase: preview.confirmationPhrase,
      },
    });
    expect(execute.statusCode).toBe(200);
    const jobId = execute.json<Job>().id;
    await vi.waitFor(() => {
      expect(runner.executionCount).toBe(1);
    });
    const jobs = await server.inject({ method: "GET", url: "/api/v1/jobs" });
    expect(jobs.json()).toMatchObject({
      jobs: [{
        id: jobId,
        status: "succeeded",
        result: { domainIds: ["run-fixture"] },
        stdoutSha256: "b".repeat(64),
        stderrSha256: "c".repeat(64),
      }],
    });
    expect(jobs.body).not.toContain("stdout\"");
    expect(jobs.body).not.toContain("stderr\"");
    expect(digest(await readFile(databasePath))).toBe(before);

    const repeated = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/execute",
      headers: actionHeaders,
      payload: {
        previewId: preview.id,
        confirmationPhrase: preview.confirmationPhrase,
      },
    });
    expect(repeated.statusCode).toBe(409);
    expect(repeated.json()).toMatchObject({ error: { code: "preview_consumed" } });
  });

  it("requires the exact paid-model authorization", async () => {
    const projectRoot = await root();
    seed(projectRoot);
    const { server } = await enabledServer(projectRoot, fakeRunner({ estimatedCostUsd: 1.234567 }));
    const preview = (await server.inject({
      method: "POST",
      url: "/api/v1/actions/classify/preview",
      headers: actionHeaders,
      payload: {
        kind: "classify",
        batchSize: 10,
        concurrency: 1,
        version: 1,
        confidenceThreshold: 0.8,
      },
    })).json<ActionPreview>();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/actions/classify/execute",
      headers: actionHeaders,
      payload: {
        previewId: preview.id,
        confirmationPhrase: preview.confirmationPhrase,
        authorizedSpendUsd: 1.2,
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toMatchObject({ error: { code: "spend_mismatch" } });
  });

  it("rejects execution when the read-only plan changes", async () => {
    const projectRoot = await root();
    seed(projectRoot);
    const runner = fakeRunner({ changing: true });
    const { server } = await enabledServer(projectRoot, runner);
    const preview = (await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/preview",
      headers: actionHeaders,
      payload: { kind: "collect", retailerId: "fork-shop", limit: 3 },
    })).json<ActionPreview>();

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/execute",
      headers: actionHeaders,
      payload: {
        previewId: preview.id,
        confirmationPhrase: preview.confirmationPhrase,
      },
    });

    expect(response.statusCode).toBe(409);
    expect(response.json()).toMatchObject({ error: { code: "state_changed" } });
    expect(runner.executionCount).toBe(0);
  });

  it("requires the anti-CSRF intent header", async () => {
    const projectRoot = await root();
    seed(projectRoot);
    const { server } = await enabledServer(projectRoot);

    const response = await server.inject({
      method: "POST",
      url: "/api/v1/actions/collect/preview",
      headers: { host: "127.0.0.1:4318", "content-type": "application/json" },
      payload: { kind: "collect", retailerId: "fork-shop", limit: 3 },
    });

    expect(response.statusCode).toBe(403);
    expect(response.json()).toMatchObject({ error: { code: "intent_required" } });
  });
});
