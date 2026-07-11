import { randomUUID } from "node:crypto";

import type Database from "better-sqlite3";

import type { ReplayReference } from "../db/repositories.js";
import { redactSandboxText } from "../explorer/package.js";
import {
  ExtractionStrategySchema,
  type ExtractionStrategy,
} from "../strategies/schema.js";
import type { ExtractionResult, ProductRef } from "../strategies/types.js";
import { executeExtraction } from "./executor.js";
import type { ExtractionExecutionContext } from "./http.js";
import { readReplayPayload } from "./replay.js";

export interface ReplayReextractionOptions
  extends Omit<ExtractionExecutionContext, "browser" | "fetch"> {
  replayRoot: string;
}

export interface ReplayReextractionSummary {
  id: string;
  observationId: string;
  retailerId: string;
  productId: string;
  strategyId: string;
  strategyVersion: number;
  status: "succeeded" | "failed";
  executedAt: string;
  result: ExtractionResult;
}

export interface RunReplayReextractionOptions extends ReplayReextractionOptions {
  database: Database.Database;
  observationId: string;
  now?: () => Date;
  id?: () => string;
}

/**
 * Re-runs deterministic HTTP extraction without touching the network. Browser
 * and interaction strategies need their original navigation state and are not
 * falsely represented as replayable from a single response body.
 */
export async function reextractFromReplay(
  strategy: ExtractionStrategy,
  ref: ProductRef,
  replay: ReplayReference,
  options: ReplayReextractionOptions,
): Promise<ExtractionResult> {
  if (strategy.tier !== "api" && strategy.tier !== "embedded-json") {
    throw new Error(`Offline replay re-extraction is unsupported for ${strategy.tier}`);
  }
  const { replayRoot, ...executionContext } = options;
  const verified = await readReplayPayload(
    replayRoot,
    replay,
    options.maxBodyBytes,
  );
  let requests = 0;
  return executeExtraction(strategy, ref, {
    ...executionContext,
    fetch: async () => {
      requests += 1;
      if (requests > 1) throw new Error("Offline replay attempted more than one request");
      return new Response(verified.body, {
        status: 200,
        headers: { "content-type": verified.mediaType },
      });
    },
  });
}

/**
 * Runs the private offline workflow and appends a structured audit result. Raw
 * replay bytes never enter the returned object, JSON result, or database row.
 */
export async function runReplayReextraction(
  options: RunReplayReextractionOptions,
): Promise<ReplayReextractionSummary> {
  const source = options.database.prepare(`
    SELECT observations.id AS observationId,
           products.retailer_id AS retailerId,
           products.id AS productId,
           products.canonical_url AS canonicalUrl,
           products.retailer_product_id AS externalId,
           products.source_category AS sourceCategory,
           observations.strategy_id AS strategyId,
           observations.strategy_version AS strategyVersion,
           observations.response_path AS responsePath,
           observations.response_sha256 AS responseSha256,
           strategies.strategy_json AS strategyJson
    FROM observations
    JOIN products ON products.id = observations.product_id
    JOIN strategies ON strategies.id = observations.strategy_id
    WHERE observations.id = ?
      AND observations.response_path IS NOT NULL
      AND observations.response_sha256 IS NOT NULL
  `).get(options.observationId) as {
    observationId: string;
    retailerId: string;
    productId: string;
    canonicalUrl: string;
    externalId: string | null;
    sourceCategory: string | null;
    strategyId: string;
    strategyVersion: number;
    responsePath: string;
    responseSha256: string;
    strategyJson: string;
  } | undefined;
  if (source === undefined) {
    throw new Error(`Observation ${options.observationId} has no replayable evidence`);
  }
  const strategy = ExtractionStrategySchema.parse(JSON.parse(source.strategyJson));
  const executedAt = (options.now ?? (() => new Date()))().toISOString();
  let auditedResult: ExtractionResult;
  try {
    const result = await reextractFromReplay(
      strategy,
      {
        canonicalUrl: source.canonicalUrl,
        externalId: source.externalId,
        sourceCategory: source.sourceCategory,
      },
      { path: source.responsePath, sha256: source.responseSha256 },
      options,
    );
    auditedResult = result.ok === true && result.fields !== undefined
      ? { ok: true, fields: result.fields }
      : {
          ok: false,
          failure: result.failure ?? {
            category: "unknown",
            message: "Offline re-extraction returned no structured result",
            responded: false,
          },
        };
  } catch (error) {
    auditedResult = {
      ok: false,
      failure: {
        category: "unknown",
        message: redactSandboxText(
          error instanceof Error ? error.message : String(error) || "Offline replay failed",
        ).slice(0, 2_000),
        responded: false,
      },
    };
  }
  const id = (options.id ?? randomUUID)();
  const status = auditedResult.ok === true && auditedResult.fields !== undefined
    ? "succeeded" as const
    : "failed" as const;
  options.database.prepare(`
    INSERT INTO replay_reextractions
      (id, observation_id, retailer_id, product_id, strategy_id,
       strategy_version, response_path, response_sha256, status,
       result_json, executed_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    id,
    source.observationId,
    source.retailerId,
    source.productId,
    source.strategyId,
    source.strategyVersion,
    source.responsePath,
    source.responseSha256,
    status,
    JSON.stringify(auditedResult),
    executedAt,
  );
  return {
    id,
    observationId: source.observationId,
    retailerId: source.retailerId,
    productId: source.productId,
    strategyId: source.strategyId,
    strategyVersion: source.strategyVersion,
    status,
    executedAt,
    result: auditedResult,
  };
}
