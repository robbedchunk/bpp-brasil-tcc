import { z } from "zod";

export const SchemaCapabilitySchema = z.object({
  status: z.enum(["compatible", "older", "newer", "incompatible", "unrecognized"]),
  currentVersion: z.number().int().nonnegative().nullable(),
  expectedVersion: z.number().int().nonnegative(),
  actionsSafe: z.boolean(),
  missingTables: z.array(z.string()),
  mismatchedMigrations: z.array(z.object({
    version: z.number().int().positive(),
    expectedName: z.string(),
    actualName: z.string().nullable(),
  })),
});

export const SourceEnvelopeSchema = z.object({
  generatedAt: z.string(),
  sourceCutoffAt: z.string().nullable(),
  dataVersion: z.number().int().nonnegative(),
  schemaCapability: SchemaCapabilitySchema,
});

export const DatabaseStateSchema = z.enum([
  "missing",
  "unrecognized",
  "older",
  "newer",
  "incompatible",
  "ready_empty",
  "ready",
]);

export const MetaResponseSchema = z.object({
  generatedAt: z.string(),
  application: z.object({
    name: z.literal("BPP Control Room"),
    interfaceLanguage: z.literal("pt-BR"),
    observerMode: z.boolean(),
    actionsEnabled: z.boolean(),
    controlProtocolVersion: z.number().int().positive(),
  }),
  database: z.object({
    state: DatabaseStateSchema,
    label: z.string(),
    dataVersion: z.number().int().nonnegative().nullable(),
    schemaCapability: SchemaCapabilitySchema.nullable(),
  }),
});

export const RunLifecycleSchema = z.enum(["running", "completed", "partial", "failed", "unknown"]);
export const RunHealthSchema = z.enum(["healthy", "drift", "blocking", "mixed", "unknown"]);
export const RunConstraintSchema = z.enum([
  "none",
  "bounded",
  "blocking_stop",
  "incomplete_evidence",
  "unknown",
]);

export const RunSummarySchema = z.object({
  id: z.string(),
  retailerId: z.string(),
  retailerName: z.string(),
  stage: z.enum(["discover", "collect"]),
  collectionDay: z.string(),
  strategyId: z.string().nullable(),
  strategyVersion: z.number().int().nullable(),
  lifecycle: RunLifecycleSchema,
  health: RunHealthSchema,
  constraint: RunConstraintSchema,
  attempted: z.number().int().nonnegative(),
  ok: z.number().int().nonnegative(),
  failed: z.number().int().nonnegative(),
  planned: z.number().int().nonnegative().nullable(),
  skipped: z.number().int().nonnegative().nullable(),
  successRate: z.number().min(0).max(1).nullable(),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  dominantFailureCategory: z.string().nullable(),
  reconciled: z.boolean(),
});

export const RetailerSummarySchema = z.object({
  id: z.string(),
  name: z.string(),
  cep: z.string(),
  platformHint: z.string().nullable(),
  active: z.boolean(),
  degraded: z.boolean(),
  degradedReason: z.string().nullable(),
  products: z.object({
    total: z.number().int().nonnegative(),
    active: z.number().int().nonnegative(),
    inScope: z.number().int().nonnegative(),
    observed: z.number().int().nonnegative(),
    classified: z.number().int().nonnegative(),
  }),
  latestRun: RunSummarySchema.nullable(),
  latestCatalogSnapshot: z.object({
    complete: z.boolean(),
    completionReason: z.string(),
    discovered: z.number().int().nonnegative(),
    inScope: z.number().int().nonnegative(),
    outOfScope: z.number().int().nonnegative(),
    disappeared: z.number().int().nonnegative().nullable(),
    completedAt: z.string(),
  }).nullable(),
});

export const PipelineStageSchema = z.object({
  id: z.enum(["registry", "discovery", "catalog", "collection", "monitor", "healing", "classification", "index"]),
  state: z.enum(["ready", "running", "attention", "waiting", "unavailable", "empty"]),
  label: z.string(),
  detail: z.string(),
  count: z.number().nonnegative().nullable(),
  route: z.string(),
});

export const AttentionItemSchema = z.object({
  id: z.string(),
  severity: z.enum(["critical", "warning", "info"]),
  kind: z.string(),
  title: z.string(),
  detail: z.string(),
  route: z.string(),
  occurredAt: z.string().nullable(),
});

export const OverviewResponseSchema = SourceEnvelopeSchema.extend({
  totals: z.object({
    retailers: z.number().int().nonnegative(),
    activeRetailers: z.number().int().nonnegative(),
    degradedRetailers: z.number().int().nonnegative(),
    products: z.number().int().nonnegative(),
    observations: z.number().int().nonnegative(),
    runs: z.number().int().nonnegative(),
    pendingClassification: z.number().int().nonnegative(),
    openHealingEvents: z.number().int().nonnegative(),
  }),
  scheduledHeartbeat: z.object({
    status: z.enum(["fresh", "stale", "missing"]),
    completedAt: z.string().nullable(),
    releaseId: z.string().nullable(),
    retailerCount: z.number().int().nonnegative().nullable(),
    failedRetailerCount: z.number().int().nonnegative().nullable(),
  }),
  pipeline: z.array(PipelineStageSchema),
  attention: z.array(AttentionItemSchema),
  retailers: z.array(RetailerSummarySchema),
  recentRuns: z.array(RunSummarySchema),
});

export const RetailersResponseSchema = SourceEnvelopeSchema.extend({
  retailers: z.array(RetailerSummarySchema),
});

export const StrategySummarySchema = z.object({
  id: z.string(),
  retailerId: z.string(),
  purpose: z.enum(["discovery", "extraction"]),
  tier: z.number().int().min(1).max(4),
  version: z.number().int().positive(),
  provenance: z.string(),
  model: z.string().nullable(),
  promptVersion: z.string().nullable(),
  active: z.boolean(),
  validation: z.object({
    attempted: z.number().int().nonnegative(),
    valid: z.number().int().nonnegative(),
    score: z.number().min(0).max(1).nullable(),
    signedEvidence: z.boolean(),
    validatedAt: z.string().nullable(),
  }),
  activatedAt: z.string().nullable(),
  retiredAt: z.string().nullable(),
});

export const AdmissionUsageSchema = z.object({
  kind: z.enum(["network", "discovery_reference", "replay"]),
  day: z.string().nullable(),
  used: z.number().int().nonnegative(),
  limit: z.number().int().positive(),
  remaining: z.number().int().nonnegative(),
});

export const RetailerDetailResponseSchema = SourceEnvelopeSchema.extend({
  retailer: RetailerSummarySchema,
  strategies: z.array(StrategySummarySchema),
  admissions: z.array(AdmissionUsageSchema),
  recentRuns: z.array(RunSummarySchema),
  stateEvents: z.array(z.object({
    state: z.string(),
    purpose: z.string().nullable(),
    reason: z.string(),
    source: z.string(),
    effectiveAt: z.string(),
  })),
});

export const RunsResponseSchema = SourceEnvelopeSchema.extend({
  pagination: z.object({
    limit: z.number().int().positive(),
    offset: z.number().int().nonnegative(),
    total: z.number().int().nonnegative(),
  }),
  runs: z.array(RunSummarySchema),
});

export const RunDetailResponseSchema = SourceEnvelopeSchema.extend({
  run: RunSummarySchema,
  failureCategories: z.array(z.object({
    category: z.string(),
    responded: z.boolean(),
    count: z.number().int().positive(),
  })),
  observations: z.object({
    total: z.number().int().nonnegative(),
    available: z.number().int().nonnegative(),
    promotional: z.number().int().nonnegative(),
  }),
  catalogSnapshot: z.object({
    complete: z.boolean(),
    completionReason: z.string(),
    discovered: z.number().int().nonnegative(),
    inScope: z.number().int().nonnegative(),
    outOfScope: z.number().int().nonnegative(),
    disappeared: z.number().int().nonnegative().nullable(),
  }).nullable(),
});

export const AutomationResponseSchema = SourceEnvelopeSchema.extend({
  classification: z.object({
    latestVersion: z.number().int().positive().nullable(),
    eligible: z.number().int().nonnegative(),
    assigned: z.number().int().nonnegative(),
    excluded: z.number().int().nonnegative(),
    pending: z.number().int().nonnegative(),
    reservations: z.array(z.object({
      id: z.string(),
      version: z.number().int().positive(),
      model: z.string(),
      status: z.string(),
      projectedCostUsd: z.number().nonnegative(),
      actualCostUsd: z.number().nonnegative().nullable(),
      reservedAt: z.string(),
    })),
    batchJobs: z.array(z.object({
      id: z.string(),
      version: z.number().int().positive(),
      status: z.string(),
      totalItems: z.number().int().nonnegative(),
      completedItems: z.number().int().nonnegative(),
      failedItems: z.number().int().nonnegative(),
      projectedCostUsd: z.number().nonnegative().nullable(),
      actualCostUsd: z.number().nonnegative().nullable(),
      submittedAt: z.string().nullable(),
      finalizedAt: z.string().nullable(),
    })),
    shapeFailures: z.number().int().nonnegative(),
    quarantinedProducts: z.number().int().nonnegative(),
    byRetailer: z.array(z.object({
      retailerId: z.string(),
      retailerName: z.string(),
      eligible: z.number().int().nonnegative(),
      assigned: z.number().int().nonnegative(),
      excluded: z.number().int().nonnegative(),
      pending: z.number().int().nonnegative(),
    })),
  }),
  strategies: z.array(StrategySummarySchema),
  healingEvents: z.array(z.object({
    id: z.string(),
    retailerId: z.string(),
    retailerName: z.string(),
    purpose: z.enum(["discovery", "extraction"]),
    category: z.string(),
    status: z.string(),
    attempts: z.number().int().nonnegative(),
    tierFrom: z.number().int().nullable(),
    tierTo: z.number().int().nullable(),
    detectedAt: z.string(),
    recoveredAt: z.string().nullable(),
    durationSeconds: z.number().int().nonnegative().nullable(),
  })),
  explorations: z.array(z.object({
    id: z.string(),
    retailerId: z.string(),
    retailerName: z.string(),
    purpose: z.enum(["discovery", "extraction"]),
    trigger: z.string(),
    status: z.string(),
    outcome: z.string().nullable(),
    eventsUsed: z.number().int().nonnegative(),
    costUsd: z.number().nonnegative(),
    startedAt: z.string(),
    finishedAt: z.string().nullable(),
  })),
});

export const LimitsResponseSchema = SourceEnvelopeSchema.extend({
  model: z.object({
    month: z.string().nullable(),
    spentUsd: z.number().nonnegative(),
    reservedUsd: z.number().nonnegative(),
    configuredLimitUsd: z.number().positive().nullable(),
    remainingUsd: z.number().nonnegative().nullable(),
    byCategory: z.array(z.object({
      category: z.string(),
      events: z.number().int().nonnegative(),
      costUsd: z.number().nonnegative(),
      inputTokens: z.number().int().nonnegative(),
      outputTokens: z.number().int().nonnegative(),
    })),
  }),
  admissions: z.array(z.object({
    retailerId: z.string(),
    retailerName: z.string(),
    day: z.string().nullable(),
    network: AdmissionUsageSchema,
    discoveryReferences: AdmissionUsageSchema,
    replay: AdmissionUsageSchema,
  })),
});

export const IndexResponseSchema = SourceEnvelopeSchema.extend({
  status: z.enum(["complete", "no_index_data"]),
  methodVersion: z.string(),
  throughDay: z.string().nullable(),
  movementPoints: z.number().int().nonnegative(),
  aggregate: z.array(z.object({
    day: z.string(),
    previousDay: z.string().nullable(),
    chainSegment: z.number().int().positive(),
    dailyRelative: z.string().nullable(),
    indexLevel: z.string().nullable(),
    coverageFraction: z.string(),
    coveredSubitemCount: z.number().int().nonnegative(),
    retailerCount: z.number().int().nonnegative(),
    productPairCount: z.number().int().nonnegative(),
  })),
  coverage: z.array(z.object({
    day: z.string(),
    coverageFraction: z.string(),
    coveredSubitemCount: z.number().int().nonnegative(),
    retailerCount: z.number().int().nonnegative(),
    productPairCount: z.number().int().nonnegative(),
    unclassifiedCount: z.number().int().nonnegative(),
    noHealthyRunCount: z.number().int().nonnegative(),
    unavailableCount: z.number().int().nonnegative(),
    carriedExpiredCount: z.number().int().nonnegative(),
    noDenominatorCount: z.number().int().nonnegative(),
    invalidPriceCount: z.number().int().nonnegative(),
  })),
  caveats: z.array(z.string()),
});

export const ArtifactResponseSchema = z.object({
  generatedAt: z.string(),
  export: z.object({
    available: z.boolean(),
    verified: z.boolean(),
    snapshotId: z.string().nullable(),
    generatedAt: z.string().nullable(),
    status: z.string().nullable(),
    methodVersion: z.string().nullable(),
    files: z.number().int().nonnegative(),
    rows: z.number().int().nonnegative(),
  }),
  analysis: z.object({
    available: z.boolean(),
    verified: z.boolean(),
    snapshotId: z.string().nullable(),
  }),
});

export const LockInspectionSchema = z.object({
  name: z.enum(["pipeline", "explorer", "classification", "index"]),
  state: z.enum(["unlocked", "active", "stale", "malformed"]),
  blocksAcquisition: z.boolean(),
  startedAt: z.string().nullable(),
  ageMs: z.number().int().nonnegative().nullable(),
});

export const SystemResponseSchema = z.object({
  generatedAt: z.string(),
  database: z.object({
    label: z.string(),
    state: DatabaseStateSchema,
    schemaCapability: SchemaCapabilitySchema.nullable(),
  }),
  capabilities: z.object({
    protocolVersion: z.number().int().positive(),
    actionsEnabled: z.boolean(),
    openaiConfigured: z.boolean(),
    notificationConfigured: z.boolean(),
  }),
  checkout: z.object({
    commit: z.string().nullable(),
    dirty: z.boolean().nullable(),
  }),
  installedRelease: z.object({
    available: z.boolean(),
    releaseId: z.string().nullable(),
    sourceCommit: z.string().nullable(),
    deployedAt: z.string().nullable(),
    scheduleActivatedAt: z.string().nullable(),
    unitCount: z.number().int().nonnegative(),
  }),
  locks: z.array(LockInspectionSchema),
});

export const ApiErrorSchema = z.object({
  error: z.object({
    code: z.string(),
    message: z.string(),
  }),
});

export const ActionKindSchema = z.enum([
  "collect",
  "discover",
  "daily",
  "classify",
  "index-export",
]);

export const ActionParametersSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("collect"),
    retailerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u),
    limit: z.number().int().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal("discover"),
    retailerId: z.string().min(1).max(200).regex(/^[A-Za-z0-9._:-]+$/u),
    limit: z.number().int().min(1).max(3_000),
  }),
  z.object({
    kind: z.literal("daily"),
    limit: z.number().int().min(1).max(2_000),
  }),
  z.object({
    kind: z.literal("classify"),
    batchSize: z.number().int().min(1).max(2_000),
    concurrency: z.number().int().min(1).max(3),
    version: z.number().int().positive(),
    confidenceThreshold: z.number().min(0).max(1),
  }),
  z.object({
    kind: z.literal("index-export"),
    classificationVersion: z.number().int().positive(),
    throughDay: z.string().regex(/^\d{4}-\d{2}-\d{2}$/u).nullable(),
    requireOfficial: z.boolean(),
  }),
]);

export const ActionPreviewSchema = z.object({
  id: z.string(),
  action: ActionKindSchema,
  parameters: ActionParametersSchema,
  createdAt: z.string(),
  expiresAt: z.string(),
  confirmationPhrase: z.string(),
  fingerprint: z.string().regex(/^[a-f0-9]{64}$/u),
  runtime: z.object({
    kind: z.literal("checkout-build"),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
    protocolVersion: z.number().int().positive(),
  }),
  impact: z.object({
    network: z.boolean(),
    primaryDatabaseWrites: z.boolean(),
    filesystemWrites: z.boolean(),
    paidModel: z.boolean(),
    lock: z.enum(["pipeline", "classification", "index"]),
    lockState: z.enum(["unlocked", "active", "stale", "malformed"]),
  }),
  plan: z.object({
    title: z.string(),
    scope: z.string(),
    metrics: z.array(z.object({ label: z.string(), value: z.string() })),
    estimatedCostUsd: z.number().nonnegative().nullable(),
    warnings: z.array(z.string()),
  }),
});

export const ActionExecuteRequestSchema = z.object({
  previewId: z.string().min(1).max(200),
  confirmationPhrase: z.string().min(1).max(200),
  authorizedSpendUsd: z.number().nonnegative().nullable().optional(),
});

export const JobStatusSchema = z.enum([
  "confirmed",
  "started",
  "succeeded",
  "failed",
  "blocked_by_lock",
  "interrupted_unknown",
]);

export const JobSchema = z.object({
  id: z.string(),
  previewId: z.string(),
  action: ActionKindSchema,
  parameters: ActionParametersSchema,
  status: JobStatusSchema,
  runtime: z.object({
    kind: z.literal("checkout-build"),
    artifactSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  }),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
  exitCode: z.number().int().nullable(),
  result: z.object({
    title: z.string(),
    metrics: z.array(z.object({ label: z.string(), value: z.string() })),
    domainIds: z.array(z.string()),
  }).nullable(),
  stdoutSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  stderrSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
  receiptSha256: z.string().regex(/^[a-f0-9]{64}$/u).nullable(),
});

export const JobsResponseSchema = z.object({
  generatedAt: z.string(),
  actionsEnabled: z.boolean(),
  jobs: z.array(JobSchema),
});

export type MetaResponse = z.infer<typeof MetaResponseSchema>;
export type OverviewResponse = z.infer<typeof OverviewResponseSchema>;
export type RetailersResponse = z.infer<typeof RetailersResponseSchema>;
export type RetailerDetailResponse = z.infer<typeof RetailerDetailResponseSchema>;
export type RunsResponse = z.infer<typeof RunsResponseSchema>;
export type RunDetailResponse = z.infer<typeof RunDetailResponseSchema>;
export type AutomationResponse = z.infer<typeof AutomationResponseSchema>;
export type LimitsResponse = z.infer<typeof LimitsResponseSchema>;
export type IndexResponse = z.infer<typeof IndexResponseSchema>;
export type ArtifactResponse = z.infer<typeof ArtifactResponseSchema>;
export type SystemResponse = z.infer<typeof SystemResponseSchema>;
export type RunSummary = z.infer<typeof RunSummarySchema>;
export type RetailerSummary = z.infer<typeof RetailerSummarySchema>;
export type StrategySummary = z.infer<typeof StrategySummarySchema>;
export type ActionKind = z.infer<typeof ActionKindSchema>;
export type ActionParameters = z.infer<typeof ActionParametersSchema>;
export type ActionPreview = z.infer<typeof ActionPreviewSchema>;
export type Job = z.infer<typeof JobSchema>;
export type JobsResponse = z.infer<typeof JobsResponseSchema>;
