import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import fastifyStatic from "@fastify/static";
import Fastify, { type FastifyInstance } from "fastify";
import { ZodError } from "zod";

import { ActionService, ActionServiceError } from "./actions/service.js";
import { loadControlRoomConfig, type ControlRoomConfig } from "./config.js";
import {
  ReadModelService,
  ReadModelUnavailableError,
} from "./read-model/database.js";
import { registerApiRoutes } from "./routes.js";

function localHost(value: string): boolean {
  const host = value.toLowerCase().split(":")[0];
  return host === "127.0.0.1" || host === "localhost";
}

function localOrigin(value: string): boolean {
  try {
    const origin = new URL(value);
    return (origin.protocol === "http:" || origin.protocol === "https:")
      && localHost(origin.host);
  } catch {
    return false;
  }
}

export async function buildServer(
  config: ControlRoomConfig,
  readModel = new ReadModelService(config.projectRoot, config.databasePath),
  actionService?: ActionService,
): Promise<FastifyInstance> {
  const actions = actionService ?? new ActionService(config, readModel);
  const app = Fastify({
    logger: false,
    trustProxy: false,
    bodyLimit: 64 * 1_024,
    requestTimeout: 30_000,
  });

  app.addHook("onRequest", async (request, reply) => {
    if (!localHost(request.headers.host ?? "")) {
      return reply.code(400).send({
        error: { code: "invalid_host", message: "Host local inválido." },
      });
    }
    const origin = request.headers.origin;
    if (origin !== undefined && !localOrigin(origin)) {
      return reply.code(403).send({
        error: { code: "invalid_origin", message: "Origem não autorizada." },
      });
    }
  });

  app.addHook("onSend", async (request, reply, payload) => {
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");
    reply.header("X-Frame-Options", "DENY");
    reply.header(
      "Content-Security-Policy",
      "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; "
      + "img-src 'self' data:; font-src 'self'; connect-src 'self'; "
      + "object-src 'none'; base-uri 'none'; frame-ancestors 'none'",
    );
    if (request.url.startsWith("/api/")) {
      reply.header("Cache-Control", "no-store");
    }
    return payload;
  });

  registerApiRoutes(app, config, readModel, actions);

  if (!config.development && existsSync(config.staticRoot)) {
    await app.register(fastifyStatic, {
      root: config.staticRoot,
      prefix: "/",
      index: false,
      wildcard: false,
    });
  }

  app.setNotFoundHandler(async (request, reply) => {
    if (request.url.startsWith("/api/")) {
      return reply.code(404).send({
        error: { code: "not_found", message: "Recurso não encontrado." },
      });
    }
    if (!config.development && existsSync(config.staticRoot)) {
      return reply.type("text/html").sendFile("index.html");
    }
    return reply.code(404).send({
      error: { code: "web_not_built", message: "A interface web ainda não foi compilada." },
    });
  });

  app.setErrorHandler(async (error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: { code: "invalid_request", message: "Parâmetros inválidos." },
      });
    }
    if (error instanceof ActionServiceError) {
      return reply.code(error.statusCode).send({
        error: { code: error.code, message: error.message },
      });
    }
    if (error instanceof ReadModelUnavailableError) {
      return reply.code(503).send({
        error: { code: error.code, message: error.message },
      });
    }
    return reply.code(500).send({
      error: { code: "internal_error", message: "Falha interna no Control Room." },
    });
  });

  app.addHook("onClose", async () => {
    actions.close();
    readModel.close();
  });
  return app;
}

function loadProjectEnvironment(): void {
  const packageRoot = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const projectRoot = resolve(process.env.PROJECT_ROOT?.trim() || resolve(packageRoot, "../.."));
  try {
    process.loadEnvFile(resolve(projectRoot, ".env"));
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) throw error;
  }
}

async function start(): Promise<void> {
  loadProjectEnvironment();
  const config = loadControlRoomConfig();
  const app = await buildServer(config);
  await app.listen({ host: config.host, port: config.port });
  process.stdout.write(`BPP Control Room API: http://${config.host}:${config.port}\n`);

  const close = async (signal: NodeJS.Signals) => {
    await app.close();
    process.exitCode = signal === "SIGINT" ? 130 : 143;
  };
  process.once("SIGINT", () => void close("SIGINT"));
  process.once("SIGTERM", () => void close("SIGTERM"));
}

const invokedPath = process.argv[1];
if (invokedPath !== undefined && import.meta.url === pathToFileURL(resolve(invokedPath)).href) {
  await start();
}
