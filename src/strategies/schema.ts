import { z } from "zod";

import { isSafeJsonPath } from "./json-path.js";

const EXTRACTION_PLACEHOLDERS = [
  "productUrl",
  "externalId",
  "sourceCategory",
] as const;

const DISCOVERY_PLACEHOLDERS = [
  "page",
  "pageSize",
  "offset",
  "from",
  "to",
  "cursor",
] as const;

const API_DISCOVERY_PLACEHOLDERS = [
  ...DISCOVERY_PLACEHOLDERS,
  "segment",
] as const;

export const STRATEGY_PLACEHOLDERS = [
  ...EXTRACTION_PLACEHOLDERS,
  ...API_DISCOVERY_PLACEHOLDERS,
] as const;

type Placeholder = (typeof STRATEGY_PLACEHOLDERS)[number];

export type JsonTemplateValue =
  | string
  | number
  | boolean
  | null
  | JsonTemplateValue[]
  | { [key: string]: JsonTemplateValue };

export type JsonTemplateObject = { [key: string]: JsonTemplateValue };

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/g;

function makeTemplateStringSchema(allowed: readonly Placeholder[]) {
  const allowedSet = new Set<string>(allowed);

  return z.string().min(1).superRefine((value, context) => {
    const withoutPlaceholders = value.replace(
      PLACEHOLDER_PATTERN,
      (placeholder, name: string) => {
        if (!allowedSet.has(name)) {
          context.addIssue({
            code: "custom",
            message: `Unsupported placeholder ${placeholder}`,
          });
        }
        return "";
      },
    );

    if (withoutPlaceholders.includes("{") || withoutPlaceholders.includes("}")) {
      context.addIssue({
        code: "custom",
        message: "Malformed placeholder",
      });
    }
  });
}

function makeHttpUrlTemplateSchema(allowed: readonly Placeholder[]) {
  return makeTemplateStringSchema(allowed).superRefine((value, context) => {
    const rendered = value.replace(
      PLACEHOLDER_PATTERN,
      (_placeholder, name: string) =>
        name === "productUrl"
          ? "https://placeholder.invalid/product"
          : encodeURIComponent(name),
    );

    try {
      const url = new URL(rendered);
      if (url.protocol !== "http:" && url.protocol !== "https:") {
        context.addIssue({
          code: "custom",
          message: "URL templates must use HTTP or HTTPS",
        });
      }
      if (url.username || url.password) {
        context.addIssue({
          code: "custom",
          message: "URL templates must not contain credentials",
        });
      }
    } catch {
      context.addIssue({
        code: "custom",
        message: "Invalid HTTP URL template",
      });
    }
  });
}

const SafeJsonKeySchema = z
  .string()
  .min(1)
  .max(200)
  .refine(
    (key) => key !== "__proto__" && key !== "prototype" && key !== "constructor",
    "Unsafe JSON object key",
  );

function makeJsonTemplateSchemas(templateStringSchema: z.ZodType<string>) {
  const valueSchema: z.ZodType<JsonTemplateValue> = z.lazy(() =>
    z.union([
      templateStringSchema,
      z.number().finite(),
      z.boolean(),
      z.null(),
      z.array(valueSchema),
      z.record(SafeJsonKeySchema, valueSchema),
    ]),
  );
  const objectSchema: z.ZodType<JsonTemplateObject> = z.record(
    SafeJsonKeySchema,
    valueSchema,
  );

  return { valueSchema, objectSchema };
}

function makeRequestTemplateSchema(allowed: readonly Placeholder[]) {
  const templateStringSchema = makeTemplateStringSchema(allowed);
  const urlSchema = makeHttpUrlTemplateSchema(allowed);
  const { valueSchema, objectSchema } = makeJsonTemplateSchemas(templateStringSchema);
  const headerNameSchema = z
    .string()
    .min(1)
    .max(100)
    .regex(/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/, "Invalid HTTP header name");

  return z
    .object({
      method: z.enum(["GET", "POST"]),
      url: urlSchema,
      headers: z.record(headerNameSchema, templateStringSchema),
      query: objectSchema.optional(),
      body: valueSchema.optional(),
    })
    .strict()
    .superRefine((request, context) => {
      if (request.method === "GET" && request.body !== undefined) {
        context.addIssue({
          code: "custom",
          path: ["body"],
          message: "GET request templates cannot contain a body",
        });
      }
      for (const name of Object.keys(request.headers)) {
        if (["authorization", "cookie", "proxy-authorization", "set-cookie"].includes(name.toLowerCase())) {
          context.addIssue({
            code: "custom",
            path: ["headers", name],
            message: "Credential and cookie headers cannot be stored in declarative strategies",
          });
        }
      }
    });
}

const AllTemplateStringSchema = makeTemplateStringSchema(STRATEGY_PLACEHOLDERS);
const ExtractionTemplateStringSchema = makeTemplateStringSchema(
  EXTRACTION_PLACEHOLDERS,
);
const DiscoveryTemplateStringSchema = makeTemplateStringSchema(
  DISCOVERY_PLACEHOLDERS,
);

export const HttpUrlTemplateSchema = makeHttpUrlTemplateSchema(
  STRATEGY_PLACEHOLDERS,
);
export const ExtractionHttpUrlTemplateSchema = makeHttpUrlTemplateSchema(
  EXTRACTION_PLACEHOLDERS,
);
export const DiscoveryHttpUrlTemplateSchema = makeHttpUrlTemplateSchema(
  DISCOVERY_PLACEHOLDERS,
);

export const RequestTemplateSchema = makeRequestTemplateSchema(
  STRATEGY_PLACEHOLDERS,
);
export const ExtractionRequestTemplateSchema = makeRequestTemplateSchema(
  EXTRACTION_PLACEHOLDERS,
);
export const DiscoveryRequestTemplateSchema = makeRequestTemplateSchema(
  DISCOVERY_PLACEHOLDERS,
);
export const ApiDiscoveryRequestTemplateSchema = makeRequestTemplateSchema(
  API_DISCOVERY_PLACEHOLDERS,
);

export type RequestTemplate = z.infer<typeof RequestTemplateSchema>;
export type ExtractionRequestTemplate = z.infer<
  typeof ExtractionRequestTemplateSchema
>;
export type DiscoveryRequestTemplate = z.infer<
  typeof DiscoveryRequestTemplateSchema
>;

export const AllowedDomainSchema = z
  .string()
  .min(1)
  .max(253)
  .regex(
    /^(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)*[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?$/,
    "Expected a hostname without scheme, port, path, or wildcard",
  );

const CommonStrategyShape = {
  schemaVersion: z.literal(1),
  allowedDomains: z.array(AllowedDomainSchema).min(1).max(20),
};

export const JsonPathSchema = z
  .string()
  .min(1)
  .max(1_000)
  .startsWith("$")
  .refine(isSafeJsonPath, "Unsafe JSONPath expression");

export const JsonFieldMapSchema = z
  .object({
    title: JsonPathSchema,
    brand: JsonPathSchema,
    price: JsonPathSchema,
    promoPrice: JsonPathSchema,
    unit: JsonPathSchema,
    availability: JsonPathSchema,
    priceOrder: z.enum(["regular-promo", "sale-list"]).optional(),
  })
  .strict();

export const FieldMapSchema = JsonFieldMapSchema;
export type JsonFieldMap = z.infer<typeof JsonFieldMapSchema>;
export type FieldMap = JsonFieldMap;

export const DomSelectorSchema = z
  .object({
    selector: z.string().min(1).max(1_000),
    attribute: z.string().min(1).max(200).optional(),
  })
  .strict();

export const DomSelectorListSchema = z.array(DomSelectorSchema).min(1).max(20);

export const DomFieldSelectorsSchema = z
  .object({
    title: DomSelectorListSchema,
    brand: DomSelectorListSchema,
    price: DomSelectorListSchema,
    promoPrice: DomSelectorListSchema,
    unit: DomSelectorListSchema,
    availability: DomSelectorListSchema,
  })
  .strict();

export type DomSelector = z.infer<typeof DomSelectorSchema>;
export type DomFieldSelectors = z.infer<typeof DomFieldSelectorsSchema>;

export const RegionalContextSchema = z.object({
  kind: z.literal("vtex-segment"),
  regionId: z.string().min(1).max(300).regex(/^v\d+\.[A-Za-z0-9_-]+$/u),
  salesChannel: z.string().regex(/^\d{1,6}$/u),
  catalogSellerId: z.string().min(1).max(200).optional(),
}).strict();

export type RegionalContext = z.infer<typeof RegionalContextSchema>;

export const EmbeddedSourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("json-ld") }).strict(),
  z.object({ kind: z.literal("next-data") }).strict(),
  z
    .object({
      kind: z.literal("script"),
      selector: z.string().min(1).max(1_000),
    })
    .strict(),
]);

export type EmbeddedSource = z.infer<typeof EmbeddedSourceSchema>;

const TimeoutSchema = z.number().int().min(1).max(30_000).optional();
const IdentifierSchema = z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,63}$/);

function makeGotoOperationSchema(urlSchema: z.ZodType<string>) {
  return z
    .object({
      op: z.literal("goto"),
      url: urlSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict();
}

function makeFillOperationSchema(
  op: "fill" | "select",
  valueSchema: z.ZodType<string>,
) {
  return z
    .object({
      op: z.literal(op),
      selector: z.string().min(1).max(1_000),
      value: valueSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict();
}

function makeHttpOperationSchema<T extends z.ZodType>(requestSchema: T) {
  return z
    .object({
      op: z.literal("http"),
      request: requestSchema,
      saveAs: IdentifierSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict();
}

export const GotoOperationSchema = makeGotoOperationSchema(HttpUrlTemplateSchema);
export const ExtractionGotoOperationSchema = makeGotoOperationSchema(
  ExtractionHttpUrlTemplateSchema,
);
export const DiscoveryGotoOperationSchema = makeGotoOperationSchema(
  DiscoveryHttpUrlTemplateSchema,
);

export const ClickOperationSchema = z
  .object({
    op: z.literal("click"),
    selector: z.string().min(1).max(1_000),
    timeoutMs: TimeoutSchema,
  })
  .strict();

export const FillOperationSchema = makeFillOperationSchema(
  "fill",
  AllTemplateStringSchema,
);
export const ExtractionFillOperationSchema = makeFillOperationSchema(
  "fill",
  ExtractionTemplateStringSchema,
);
export const DiscoveryFillOperationSchema = makeFillOperationSchema(
  "fill",
  DiscoveryTemplateStringSchema,
);

export const SelectOperationSchema = makeFillOperationSchema(
  "select",
  AllTemplateStringSchema,
);
export const ExtractionSelectOperationSchema = makeFillOperationSchema(
  "select",
  ExtractionTemplateStringSchema,
);
export const DiscoverySelectOperationSchema = makeFillOperationSchema(
  "select",
  DiscoveryTemplateStringSchema,
);

export const WaitForOperationSchema = z
  .object({
    op: z.literal("waitFor"),
    selector: z.string().min(1).max(1_000),
    state: z.enum(["attached", "visible", "hidden", "detached"]).optional(),
    timeoutMs: TimeoutSchema,
  })
  .strict();

export const ScrollOperationSchema = z
  .object({
    op: z.literal("scroll"),
    deltaY: z.number().int().min(-100_000).max(100_000),
    timeoutMs: TimeoutSchema,
  })
  .strict();

export const HttpOperationSchema = makeHttpOperationSchema(RequestTemplateSchema);
export const ExtractionHttpOperationSchema = makeHttpOperationSchema(
  ExtractionRequestTemplateSchema,
);
export const DiscoveryHttpOperationSchema = makeHttpOperationSchema(
  DiscoveryRequestTemplateSchema,
);

export const ExtractionExtractOperationSchema = z.discriminatedUnion("source", [
  z
    .object({
      op: z.literal("extract"),
      source: z.literal("dom"),
      selectors: DomFieldSelectorsSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("extract"),
      source: z.literal("json"),
      from: IdentifierSchema,
      fields: JsonFieldMapSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict(),
]);

export const DiscoveryRefFieldsSchema = z
  .object({
    url: JsonPathSchema,
    externalId: JsonPathSchema.optional(),
    sourceCategory: JsonPathSchema.optional(),
  })
  .strict();

export const DiscoveryExtractOperationSchema = z.discriminatedUnion("source", [
  z
    .object({
      op: z.literal("extract"),
      source: z.literal("dom"),
      linkSelectors: DomSelectorListSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict(),
  z
    .object({
      op: z.literal("extract"),
      source: z.literal("json"),
      from: IdentifierSchema,
      itemsPath: JsonPathSchema,
      refFields: DiscoveryRefFieldsSchema,
      timeoutMs: TimeoutSchema,
    })
    .strict(),
]);

export const ExtractionScriptOperationSchema = z.union([
  ExtractionGotoOperationSchema,
  ClickOperationSchema,
  ExtractionFillOperationSchema,
  ExtractionSelectOperationSchema,
  WaitForOperationSchema,
  ScrollOperationSchema,
  ExtractionHttpOperationSchema,
  ExtractionExtractOperationSchema,
]);

export const DiscoveryScriptOperationSchema = z.union([
  DiscoveryGotoOperationSchema,
  ClickOperationSchema,
  DiscoveryFillOperationSchema,
  DiscoverySelectOperationSchema,
  WaitForOperationSchema,
  ScrollOperationSchema,
  DiscoveryHttpOperationSchema,
  DiscoveryExtractOperationSchema,
]);

export const ScriptOperationSchema = z.union([
  ExtractionScriptOperationSchema,
  DiscoveryScriptOperationSchema,
]);

export type GotoOperation = z.infer<typeof GotoOperationSchema>;
export type ClickOperation = z.infer<typeof ClickOperationSchema>;
export type FillOperation = z.infer<typeof FillOperationSchema>;
export type SelectOperation = z.infer<typeof SelectOperationSchema>;
export type WaitForOperation = z.infer<typeof WaitForOperationSchema>;
export type ScrollOperation = z.infer<typeof ScrollOperationSchema>;
export type HttpOperation = z.infer<typeof HttpOperationSchema>;
export type ExtractionExtractOperation = z.infer<
  typeof ExtractionExtractOperationSchema
>;
export type DiscoveryExtractOperation = z.infer<
  typeof DiscoveryExtractOperationSchema
>;
export type ExtractionScriptOperation = z.infer<
  typeof ExtractionScriptOperationSchema
>;
export type DiscoveryScriptOperation = z.infer<
  typeof DiscoveryScriptOperationSchema
>;
export type ScriptOperation = z.infer<typeof ScriptOperationSchema>;

export const ApiExtractionStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("extraction"),
    tier: z.literal("api"),
    request: ExtractionRequestTemplateSchema,
    regionalContext: RegionalContextSchema.optional(),
    fields: JsonFieldMapSchema,
  })
  .strict();

export const EmbeddedJsonExtractionStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("extraction"),
    tier: z.literal("embedded-json"),
    request: ExtractionRequestTemplateSchema,
    source: EmbeddedSourceSchema,
    fields: JsonFieldMapSchema,
  })
  .strict();

export const DomExtractionStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("extraction"),
    tier: z.literal("dom"),
    url: ExtractionHttpUrlTemplateSchema,
    selectors: DomFieldSelectorsSchema,
  })
  .strict();

export const ScriptExtractionStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("extraction"),
    tier: z.literal("script"),
    operations: z.array(ExtractionScriptOperationSchema).min(1).max(100),
  })
  .strict();

export const ScriptStrategySchema = ScriptExtractionStrategySchema;

export const ExtractionStrategySchema = z.discriminatedUnion("tier", [
  ApiExtractionStrategySchema,
  EmbeddedJsonExtractionStrategySchema,
  DomExtractionStrategySchema,
  ScriptExtractionStrategySchema,
]);

export type ApiExtractionStrategy = z.infer<typeof ApiExtractionStrategySchema>;
export type EmbeddedJsonExtractionStrategy = z.infer<
  typeof EmbeddedJsonExtractionStrategySchema
>;
export type DomExtractionStrategy = z.infer<typeof DomExtractionStrategySchema>;
export type ScriptExtractionStrategy = z.infer<
  typeof ScriptExtractionStrategySchema
>;
export type ExtractionStrategy = z.infer<typeof ExtractionStrategySchema>;

const MaxSitemapsSchema = z.number().int().min(1).max(10_000).default(1_000);
const MaxPagesSchema = z.number().int().min(1).max(10_000).default(100);
const MaxProductsSchema = z.number().int().min(1).max(1_000_000).default(100_000);

export const SitemapDiscoveryStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("discovery"),
    tier: z.literal("sitemap"),
    sitemapUrls: z
      .array(DiscoveryHttpUrlTemplateSchema)
      .min(1)
      .max(100),
    maxSitemaps: MaxSitemapsSchema,
    maxProducts: MaxProductsSchema,
  })
  .strict();

export const ApiPaginationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("page"),
      start: z.number().int().min(0),
      step: z.number().int().min(1).default(1),
      pageSize: z.number().int().min(1).max(1_000),
      maxPages: MaxPagesSchema,
      pageCountPath: JsonPathSchema.optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("offset"),
      start: z.number().int().min(0),
      step: z.number().int().min(1),
      pageSize: z.number().int().min(1).max(1_000),
      maxPages: MaxPagesSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("cursor"),
      initial: z.string().max(10_000).nullable().default(null),
      nextCursorPath: JsonPathSchema,
      maxPages: MaxPagesSchema,
    })
    .strict(),
]);

export type ApiPagination = z.infer<typeof ApiPaginationSchema>;

export const ApiDiscoverySegmentSchema = z.object({
  value: z.string().min(1).max(300),
  sourceCategory: z.string().min(1).max(500).optional(),
  maxProducts: z.number().int().min(1).max(3_000),
}).strict();

export const ApiDiscoveryStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("discovery"),
    tier: z.literal("api"),
    request: ApiDiscoveryRequestTemplateSchema,
    itemsPath: JsonPathSchema,
    refFields: DiscoveryRefFieldsSchema,
    pagination: ApiPaginationSchema,
    segments: z.array(ApiDiscoverySegmentSchema).min(1).max(50).optional(),
    maxProducts: MaxProductsSchema,
  })
  .strict()
  .superRefine((strategy, context) => {
    const usesSegment = JSON.stringify(strategy.request).includes("{segment}");
    if (usesSegment !== (strategy.segments !== undefined)) {
      context.addIssue({
        code: "custom",
        path: [strategy.segments === undefined ? "segments" : "request"],
        message: "Segmented discovery requires both segments and a {segment} request placeholder",
      });
    }
    if (strategy.segments !== undefined && strategy.pagination.kind === "cursor") {
      context.addIssue({
        code: "custom",
        path: ["pagination"],
        message: "Segmented discovery supports bounded page or offset pagination",
      });
    }
    if (
      strategy.segments !== undefined
      && new Set(strategy.segments.map(({ value }) => value)).size
        !== strategy.segments.length
    ) {
      context.addIssue({
        code: "custom",
        path: ["segments"],
        message: "Segment values must be unique",
      });
    }
    if (
      strategy.segments !== undefined
      && strategy.segments.reduce((sum, segment) => sum + segment.maxProducts, 0)
        > strategy.maxProducts
    ) {
      context.addIssue({
        code: "custom",
        path: ["segments"],
        message: "Segment product allocations must not exceed maxProducts",
      });
    }
  });

export const DomCrawlDiscoveryStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("discovery"),
    tier: z.literal("dom-crawl"),
    startUrls: z.array(DiscoveryHttpUrlTemplateSchema).min(1).max(100),
    linkSelectors: DomSelectorListSchema,
    paginationSelectors: DomSelectorListSchema.optional(),
    maxPages: MaxPagesSchema,
    maxProducts: MaxProductsSchema,
  })
  .strict();

export const ScriptDiscoveryStrategySchema = z
  .object({
    ...CommonStrategyShape,
    purpose: z.literal("discovery"),
    tier: z.literal("script"),
    operations: z.array(DiscoveryScriptOperationSchema).min(1).max(100),
    maxProducts: MaxProductsSchema,
  })
  .strict();

export const DiscoveryStrategySchema = z.discriminatedUnion("tier", [
  SitemapDiscoveryStrategySchema,
  ApiDiscoveryStrategySchema,
  DomCrawlDiscoveryStrategySchema,
  ScriptDiscoveryStrategySchema,
]);

export type SitemapDiscoveryStrategy = z.infer<
  typeof SitemapDiscoveryStrategySchema
>;
export type ApiDiscoveryStrategy = z.infer<typeof ApiDiscoveryStrategySchema>;
export type DomCrawlDiscoveryStrategy = z.infer<
  typeof DomCrawlDiscoveryStrategySchema
>;
export type ScriptDiscoveryStrategy = z.infer<
  typeof ScriptDiscoveryStrategySchema
>;
export type DiscoveryStrategy = z.infer<typeof DiscoveryStrategySchema>;

export const StrategySchema = z.union([
  ExtractionStrategySchema,
  DiscoveryStrategySchema,
]);

export type Strategy = z.infer<typeof StrategySchema>;

export function parseStrategy(json: unknown): Strategy {
  const value = typeof json === "string" ? JSON.parse(json) : json;
  return StrategySchema.parse(value);
}
