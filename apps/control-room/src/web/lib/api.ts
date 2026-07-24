import type { QueryKey } from "@tanstack/react-query";
import { useQuery } from "@tanstack/react-query";
import type { z } from "zod";

import {
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
  type ActionParameters,
} from "../../shared/contracts.js";

export class ApiRequestError extends Error {
  constructor(readonly status: number, message: string) {
    super(message);
    this.name = "ApiRequestError";
  }
}

async function request<T>(
  path: string,
  schema: z.ZodType<T>,
  init: RequestInit = {},
  fallbackMessage = "Não foi possível consultar o Control Room.",
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Accept", "application/json");
  const response = await fetch(path, {
    ...init,
    headers,
    credentials: "same-origin",
  });
  if (!response.ok) {
    let message = fallbackMessage;
    try {
      const parsed = ApiErrorSchema.safeParse(await response.json());
      if (parsed.success) message = parsed.data.error.message;
    } catch {
      // Keep the safe generic message.
    }
    throw new ApiRequestError(response.status, message);
  }
  return schema.parse(await response.json());
}

function actionRequest<T>(
  path: string,
  body: unknown,
  schema: z.ZodType<T>,
): Promise<T> {
  return request(path, schema, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "X-Control-Room-Intent": "action",
    },
    body: JSON.stringify(body),
  }, "A operação foi recusada pelo Control Room.");
}

function useResource<T>(
  queryKey: QueryKey,
  path: string,
  schema: z.ZodType<T>,
  refetchInterval: number | false = 10_000,
) {
  return useQuery({
    queryKey,
    queryFn: () => request(path, schema),
    refetchInterval,
    staleTime: 4_000,
    retry: (failureCount, error) => !(error instanceof ApiRequestError && error.status < 500)
      && failureCount < 2,
  });
}

export const api = {
  useMeta: () => useResource(["meta"], "/api/v1/meta", MetaResponseSchema, 5_000),
  useOverview: () => useResource(["overview"], "/api/v1/overview", OverviewResponseSchema, 8_000),
  useRetailers: () => useResource(["retailers"], "/api/v1/retailers", RetailersResponseSchema, 10_000),
  useRetailer: (id: string) => useResource(
    ["retailer", id],
    `/api/v1/retailers/${encodeURIComponent(id)}`,
    RetailerDetailResponseSchema,
    10_000,
  ),
  useRuns: (search: { retailer?: string; stage?: string; status?: string }) => {
    const parameters = new URLSearchParams();
    if (search.retailer) parameters.set("retailer", search.retailer);
    if (search.stage) parameters.set("stage", search.stage);
    if (search.status) parameters.set("status", search.status);
    const suffix = parameters.size === 0 ? "" : `?${parameters.toString()}`;
    return useResource(["runs", search], `/api/v1/runs${suffix}`, RunsResponseSchema, 8_000);
  },
  useRun: (id: string) => useResource(
    ["run", id],
    `/api/v1/runs/${encodeURIComponent(id)}`,
    RunDetailResponseSchema,
    8_000,
  ),
  useAutomation: () => useResource(["automation"], "/api/v1/automation", AutomationResponseSchema, 12_000),
  useLimits: () => useResource(["limits"], "/api/v1/limits", LimitsResponseSchema, 10_000),
  useIndex: () => useResource(["index"], "/api/v1/index/live", IndexResponseSchema, 30_000),
  useArtifacts: () => useResource(["artifacts"], "/api/v1/artifacts/latest", ArtifactResponseSchema, 30_000),
  useSystem: () => useResource(["system"], "/api/v1/system", SystemResponseSchema, 8_000),
  useJobs: () => useResource(["jobs"], "/api/v1/jobs", JobsResponseSchema, 2_000),
  previewAction: (parameters: ActionParameters) => actionRequest(
    `/api/v1/actions/${parameters.kind}/preview`,
    parameters,
    ActionPreviewSchema,
  ),
  executeAction: (
    kind: ActionParameters["kind"],
    input: { previewId: string; confirmationPhrase: string; authorizedSpendUsd?: number | null },
  ) => actionRequest(`/api/v1/actions/${kind}/execute`, input, JobSchema),
};
