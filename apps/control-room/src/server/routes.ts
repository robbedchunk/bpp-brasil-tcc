import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { z } from "zod";

import {
  ActionExecuteRequestSchema,
  ActionKindSchema,
  ActionParametersSchema,
  ActionPreviewSchema,
  ApiErrorSchema,
  ArtifactResponseSchema,
  AutomationResponseSchema,
  IndexResponseSchema,
  JobSchema,
  JobsResponseSchema,
  LimitsResponseSchema,
  MetaResponseSchema,
  OverviewResponseSchema,
  RetailerDetailResponseSchema,
  RetailersResponseSchema,
  RunDetailResponseSchema,
  RunsResponseSchema,
  SystemResponseSchema,
} from "../shared/contracts.js";
import { CONTROL_PROTOCOL_VERSION } from "../../../../src/control/capabilities.js";
import type { ActionService } from "./actions/service.js";
import { readArtifacts } from "./artifacts.js";
import type { ControlRoomConfig } from "./config.js";
import { assertSafeApiPayload } from "./privacy.js";
import type { ReadModelService } from "./read-model/database.js";
import {
  readAutomation,
  readLimits,
  readLiveIndex,
  readOverview,
  readRetailerDetail,
  readRetailers,
  readRunDetail,
  readRuns,
} from "./read-model/queries.js";
import { readSystemState } from "./system.js";

const IdentifierSchema = z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u);
const RunsQuerySchema = z.object({
  retailer: IdentifierSchema.optional(),
  stage: z.enum(["discover", "collect"]).optional(),
  status: z.string().min(1).max(40).regex(/^[a-z0-9_-]+$/u).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
});

function sendContract<T>(
  reply: FastifyReply,
  schema: z.ZodType<T>,
  value: T,
): FastifyReply {
  const parsed = schema.parse(value);
  assertSafeApiPayload(parsed);
  return reply.send(parsed);
}

function sendNotFound(reply: FastifyReply, entity: string): FastifyReply {
  const payload = ApiErrorSchema.parse({
    error: { code: "not_found", message: `${entity} não foi encontrado.` },
  });
  return reply.code(404).send(payload);
}

function requireActionRequest(
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | null {
  if (request.headers["x-control-room-intent"] !== "action") {
    return reply.code(403).send({
      error: { code: "intent_required", message: "Cabeçalho de intenção ausente." },
    });
  }
  if (!request.headers["content-type"]?.startsWith("application/json")) {
    return reply.code(415).send({
      error: { code: "json_required", message: "Ações exigem JSON." },
    });
  }
  return null;
}

export function registerApiRoutes(
  app: FastifyInstance,
  config: ControlRoomConfig,
  readModel: ReadModelService,
  actions: ActionService,
): void {
  app.get("/api/v1/meta", async (_request, reply) => {
    const database = readModel.inspect();
    return sendContract(reply, MetaResponseSchema, {
      generatedAt: new Date().toISOString(),
      application: {
        name: "BPP Control Room",
        interfaceLanguage: "pt-BR",
        observerMode: !config.actionsEnabled,
        actionsEnabled: config.actionsEnabled,
        controlProtocolVersion: CONTROL_PROTOCOL_VERSION,
      },
      database,
    });
  });

  app.get("/api/v1/overview", async (_request, reply) =>
    sendContract(reply, OverviewResponseSchema, readModel.snapshot(readOverview)));

  app.get("/api/v1/retailers", async (_request, reply) =>
    sendContract(reply, RetailersResponseSchema, readModel.snapshot(readRetailers)));

  app.get("/api/v1/retailers/:id", async (request, reply) => {
    const { id } = z.object({ id: IdentifierSchema }).parse(request.params);
    const result = readModel.snapshot((context) => readRetailerDetail(context, id));
    return result === null
      ? sendNotFound(reply, "O varejista")
      : sendContract(reply, RetailerDetailResponseSchema, result);
  });

  app.get("/api/v1/runs", async (request, reply) => {
    const query = RunsQuerySchema.parse(request.query);
    const result = readModel.snapshot((context) => readRuns(context, {
      ...(query.retailer === undefined ? {} : { retailerId: query.retailer }),
      ...(query.stage === undefined ? {} : { stage: query.stage }),
      ...(query.status === undefined ? {} : { status: query.status }),
      limit: query.limit,
      offset: query.offset,
    }));
    return sendContract(reply, RunsResponseSchema, result);
  });

  app.get("/api/v1/runs/:id", async (request, reply) => {
    const { id } = z.object({ id: IdentifierSchema }).parse(request.params);
    const result = readModel.snapshot((context) => readRunDetail(context, id));
    return result === null
      ? sendNotFound(reply, "A execução")
      : sendContract(reply, RunDetailResponseSchema, result);
  });

  app.get("/api/v1/automation", async (_request, reply) =>
    sendContract(reply, AutomationResponseSchema, readModel.snapshot(readAutomation)));

  app.get("/api/v1/limits", async (_request, reply) =>
    sendContract(
      reply,
      LimitsResponseSchema,
      readModel.snapshot((context) => readLimits(context, config.modelBudgetLimitUsd)),
    ));

  app.get("/api/v1/index/live", async (_request, reply) =>
    sendContract(reply, IndexResponseSchema, readModel.snapshot(readLiveIndex)));

  app.get("/api/v1/artifacts/latest", async (_request, reply) =>
    sendContract(
      reply,
      ArtifactResponseSchema,
      await readArtifacts(config.projectRoot),
    ));

  app.get("/api/v1/system", async (_request, reply) =>
    sendContract(
      reply,
      SystemResponseSchema,
      await readSystemState(config, readModel.inspect()),
    ));

  app.get("/api/v1/jobs", async (_request, reply) =>
    sendContract(reply, JobsResponseSchema, {
      generatedAt: new Date().toISOString(),
      actionsEnabled: config.actionsEnabled,
      jobs: actions.store.listJobs(),
    }));

  app.get("/api/v1/jobs/:id", async (request, reply) => {
    const { id } = z.object({ id: IdentifierSchema }).parse(request.params);
    const job = actions.store.job(id);
    return job === null ? sendNotFound(reply, "A ação") : sendContract(reply, JobSchema, job);
  });

  app.post("/api/v1/actions/:kind/preview", async (request, reply) => {
    const rejection = requireActionRequest(request, reply);
    if (rejection !== null) return rejection;
    const { kind } = z.object({ kind: ActionKindSchema }).parse(request.params);
    const parameters = ActionParametersSchema.parse(request.body);
    if (parameters.kind !== kind) {
      return reply.code(400).send({
        error: { code: "action_mismatch", message: "A rota e o corpo descrevem ações diferentes." },
      });
    }
    return sendContract(reply, ActionPreviewSchema, await actions.preview(parameters));
  });

  app.post("/api/v1/actions/:kind/execute", async (request, reply) => {
    const rejection = requireActionRequest(request, reply);
    if (rejection !== null) return rejection;
    const { kind } = z.object({ kind: ActionKindSchema }).parse(request.params);
    const input = ActionExecuteRequestSchema.parse(request.body);
    const stored = actions.store.preview(input.previewId);
    if (stored !== null && stored.preview.action !== kind) {
      return reply.code(400).send({
        error: { code: "action_mismatch", message: "A rota não corresponde ao preview." },
      });
    }
    return sendContract(reply, JobSchema, await actions.execute({
      previewId: input.previewId,
      confirmationPhrase: input.confirmationPhrase,
      ...(input.authorizedSpendUsd === undefined
        ? {}
        : { authorizedSpendUsd: input.authorizedSpendUsd }),
    }));
  });

  app.get("/api/v1/jobs/:id/events", async (request, reply) => {
    const { id } = z.object({ id: IdentifierSchema }).parse(request.params);
    const query = z.object({ after: z.coerce.number().int().nonnegative().default(0) })
      .parse(request.query);
    if (actions.store.job(id) === null) return sendNotFound(reply, "A ação");
    reply.hijack();
    reply.raw.writeHead(200, {
      "Content-Type": "text/event-stream; charset=utf-8",
      "Cache-Control": "no-store",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    });
    let sequence = query.after;
    const flush = () => {
      const events = actions.store.events(id, sequence);
      for (const event of events) {
        assertSafeApiPayload(event);
        reply.raw.write(`id: ${event.sequence}\nevent: status\ndata: ${JSON.stringify(event)}\n\n`);
        sequence = event.sequence;
      }
      const job = actions.store.job(id);
      if (job !== null && ["succeeded", "failed", "blocked_by_lock", "interrupted_unknown"].includes(job.status)) {
        reply.raw.write(`event: complete\ndata: ${JSON.stringify({ status: job.status })}\n\n`);
        clearInterval(timer);
        reply.raw.end();
      }
    };
    const timer = setInterval(flush, 750);
    timer.unref();
    request.raw.once("close", () => clearInterval(timer));
    flush();
  });
}
