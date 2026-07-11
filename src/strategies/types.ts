export type FailureCategory =
  | "http-403"
  | "http-429"
  | "captcha"
  | "timeout"
  | "network"
  | "parse"
  | "missing-fields"
  | "invalid-price"
  | "domain-denied"
  | "unknown";

export interface ExtractionFailure {
  category: FailureCategory;
  message: string;
  responded: boolean;
  statusCode?: number;
}

export interface ReplayPayload {
  body: string;
  mediaType: "application/json" | "text/html" | "text/plain";
}

export interface ProductRef {
  canonicalUrl: string;
  externalId: string | null;
  sourceCategory: string | null;
}

export interface ExtractionResult {
  ok: boolean;
  fields?: {
    title: string;
    brand: string | null;
    price: number;
    promoPrice: number | null;
    unit: string | null;
    available: boolean;
  };
  failure?: ExtractionFailure;
  /** Private bounded response material offered to the daily replay sampler. */
  replay?: ReplayPayload;
  /** @deprecated Compatibility alias for older HTML-returning test executors. */
  html?: string;
}

export type DiscoveryResult =
  | { ok: true; refs: ProductRef[] }
  | { ok: false; refs: []; failure: ExtractionFailure };
