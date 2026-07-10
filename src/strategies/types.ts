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
  html?: string;
}

export type DiscoveryResult =
  | { ok: true; refs: ProductRef[] }
  | { ok: false; refs: []; failure: ExtractionFailure };
