import type { Browser } from "playwright";

import type {
  ExtractionRequestTemplate,
  JsonTemplateValue,
} from "../strategies/schema.js";
import type {
  ExtractionFailure,
  ProductRef,
} from "../strategies/types.js";

export const DEFAULT_HTTP_TIMEOUT_MS = 15_000;
export const DEFAULT_MAX_BODY_BYTES = 2_000_000;
export const DEFAULT_MAX_REDIRECTS = 5;
export const DEFAULT_RESEARCH_USER_AGENT =
  "tcc-ultra-super/0.1 (academic price research; non-commercial collection)";

const PLACEHOLDER_PATTERN = /\{([A-Za-z][A-Za-z0-9]*)\}/gu;
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const CAPTCHA_PATTERN =
  /(?:g-recaptcha|hcaptcha|captcha\s+(?:required|challenge)|verify\s+(?:that\s+)?you\s+are\s+human|verifique\s+que\s+(?:voce|você)\s+(?:e|é)\s+humano)/iu;

export type FetchLike = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

export interface ExtractionExecutionContext {
  fetch?: FetchLike;
  browser?: Browser;
  signal?: AbortSignal;
  timeoutMs?: number;
  totalTimeoutMs?: number;
  maxBodyBytes?: number;
  maxDomMatches?: number;
  maxRedirects?: number;
  userAgent?: string;
}

export interface BoundedHttpRequest {
  url: string;
  method: "GET" | "POST";
  headers?: Record<string, string>;
  body?: Exclude<RequestInit["body"], undefined> | null;
}

export interface BoundedHttpResponse {
  url: string;
  status: number;
  headers: Headers;
  body: string;
  bytes: Uint8Array;
}

export type BoundedFetchResult =
  | { ok: true; response: BoundedHttpResponse }
  | { ok: false; failure: ExtractionFailure };

interface BodyReadSuccess {
  ok: true;
  body: string;
  bytes: Uint8Array;
}

interface BodyReadFailure {
  ok: false;
  message: string;
}

type BodyReadResult = BodyReadSuccess | BodyReadFailure;

function extractionFailure(
  category: ExtractionFailure["category"],
  message: string,
  responded: boolean,
  statusCode?: number,
): ExtractionFailure {
  return statusCode === undefined
    ? { category, message, responded }
    : { category, message, responded, statusCode };
}

function normalizedHostname(hostname: string): string {
  return hostname.toLowerCase().replace(/\.+$/u, "");
}

function assertAllowedUrl(url: string, allowedDomains: string[]): URL {
  const parsed = new URL(url);
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error(`URL protocol is not allowed: ${parsed.protocol}`);
  }
  if (parsed.username.length > 0 || parsed.password.length > 0) {
    throw new Error("URL credentials are not allowed");
  }

  const hostname = normalizedHostname(parsed.hostname);
  const allowed = allowedDomains.some((domain) => {
    const candidate = normalizedHostname(domain.trim());
    return candidate.length > 0
      && (hostname === candidate || hostname.endsWith(`.${candidate}`));
  });
  if (!allowed) {
    throw new Error(`URL domain is not allowed: ${parsed.hostname}`);
  }

  return parsed;
}

function placeholderValues(ref: ProductRef): Record<string, string> {
  return {
    productUrl: ref.canonicalUrl,
    externalId: ref.externalId ?? "",
    sourceCategory: ref.sourceCategory ?? "",
  };
}

export function renderTemplateString(template: string, ref: ProductRef): string {
  const values = placeholderValues(ref);
  return template.replace(
    PLACEHOLDER_PATTERN,
    (placeholder, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`Unsupported placeholder ${placeholder}`);
      }
      return value;
    },
  );
}

export function renderUrlTemplate(template: string, ref: ProductRef): string {
  if (template === "{productUrl}") return ref.canonicalUrl;

  const values = placeholderValues(ref);
  return template.replace(
    PLACEHOLDER_PATTERN,
    (placeholder, name: string) => {
      const value = values[name];
      if (value === undefined) {
        throw new Error(`Unsupported placeholder ${placeholder}`);
      }
      return encodeURIComponent(value);
    },
  );
}

function renderJsonTemplate(
  value: JsonTemplateValue,
  ref: ProductRef,
): JsonTemplateValue {
  if (typeof value === "string") return renderTemplateString(value, ref);
  if (Array.isArray(value)) {
    return value.map((item) => renderJsonTemplate(item, ref));
  }
  if (value !== null && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        key,
        renderJsonTemplate(item, ref),
      ]),
    );
  }
  return value;
}

function queryValue(value: JsonTemplateValue): string {
  if (value === null) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  return JSON.stringify(value);
}

export function renderRequestTemplate(
  request: ExtractionRequestTemplate,
  ref: ProductRef,
): BoundedHttpRequest {
  const url = new URL(renderUrlTemplate(request.url, ref));
  if (request.query !== undefined) {
    const renderedQuery = renderJsonTemplate(request.query, ref);
    if (renderedQuery === null || Array.isArray(renderedQuery)
      || typeof renderedQuery !== "object") {
      throw new Error("Request query template did not render to an object");
    }
    for (const [key, value] of Object.entries(renderedQuery)) {
      url.searchParams.set(key, queryValue(value));
    }
  }

  const headers = new Headers();
  for (const [name, value] of Object.entries(request.headers)) {
    headers.set(name, renderTemplateString(value, ref));
  }

  if (request.body === undefined) {
    return {
      url: url.toString(),
      method: request.method,
      headers: Object.fromEntries(headers),
    };
  }
  if (request.method === "GET") {
    throw new Error("GET requests cannot include a body");
  }

  if (!headers.has("content-type")) {
    headers.set("content-type", "application/json");
  }
  return {
    url: url.toString(),
    method: request.method,
    headers: Object.fromEntries(headers),
    body: JSON.stringify(renderJsonTemplate(request.body, ref)),
  };
}

function positiveInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value > 0
    ? value
    : fallback;
}

function nonNegativeInteger(value: number | undefined, fallback: number): number {
  return value !== undefined && Number.isSafeInteger(value) && value >= 0
    ? value
    : fallback;
}

async function readBodyBounded(
  response: Response,
  maxBodyBytes: number,
): Promise<BodyReadResult> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null) {
    const declaredBytes = Number(contentLength);
    if (Number.isFinite(declaredBytes) && declaredBytes > maxBodyBytes) {
      await response.body?.cancel();
      return {
        ok: false,
        message: `Response body exceeds ${maxBodyBytes} bytes`,
      };
    }
  }

  if (response.body === null) {
    return { ok: true, body: "", bytes: new Uint8Array() };
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytesRead = 0;
  let body = "";
  const chunks: Uint8Array[] = [];

  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytesRead += chunk.value.byteLength;
      if (bytesRead > maxBodyBytes) {
        await reader.cancel();
        return {
          ok: false,
          message: `Response body exceeds ${maxBodyBytes} bytes`,
        };
      }
      chunks.push(chunk.value);
      body += decoder.decode(chunk.value, { stream: true });
    }
    body += decoder.decode();
    const bytes = new Uint8Array(bytesRead);
    let offset = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, offset);
      offset += chunk.byteLength;
    }
    return { ok: true, body, bytes };
  } finally {
    reader.releaseLock();
  }
}

function statusFailure(status: number, body: string): ExtractionFailure {
  if (CAPTCHA_PATTERN.test(body)) {
    return extractionFailure(
      "captcha",
      "Response contains a CAPTCHA or human-verification challenge",
      true,
      status,
    );
  }
  if (status === 403) {
    return extractionFailure("http-403", "HTTP request was forbidden", true, status);
  }
  if (status === 429) {
    return extractionFailure("http-429", "HTTP request was throttled", true, status);
  }
  if (status === 408 || status === 504) {
    return extractionFailure("timeout", `HTTP request timed out with ${status}`, true, status);
  }
  return extractionFailure(
    "unknown",
    `HTTP request failed with status ${status}`,
    true,
    status,
  );
}

function isTimeoutError(error: unknown, signal: AbortSignal): boolean {
  if (signal.aborted) return true;
  return error instanceof Error
    && (error.name === "TimeoutError" || error.name === "AbortError");
}

async function cancelResponseBody(response: Response): Promise<void> {
  await response.body?.cancel().catch(() => undefined);
}

export async function fetchBounded(
  request: BoundedHttpRequest,
  allowedDomains: string[],
  context: ExtractionExecutionContext = {},
): Promise<BoundedFetchResult> {
  const fetchImplementation = context.fetch ?? globalThis.fetch;
  const timeoutMs = positiveInteger(context.timeoutMs, DEFAULT_HTTP_TIMEOUT_MS);
  const maxBodyBytes = positiveInteger(
    context.maxBodyBytes,
    DEFAULT_MAX_BODY_BYTES,
  );
  const maxRedirects = nonNegativeInteger(
    context.maxRedirects,
    DEFAULT_MAX_REDIRECTS,
  );
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = context.signal === undefined
    ? timeoutSignal
    : AbortSignal.any([timeoutSignal, context.signal]);
  const headers = new Headers(request.headers);
  headers.set(
    "user-agent",
    context.userAgent?.trim() || DEFAULT_RESEARCH_USER_AGENT,
  );

  let currentUrl = request.url;
  let currentMethod = request.method;
  let currentBody = request.body;
  let previousStatus: number | undefined;

  for (let redirects = 0; redirects <= maxRedirects; redirects += 1) {
    try {
      assertAllowedUrl(currentUrl, allowedDomains);
    } catch (error) {
      return {
        ok: false,
        failure: extractionFailure(
          "domain-denied",
          error instanceof Error ? error.message : "URL domain is not allowed",
          previousStatus !== undefined,
          previousStatus,
        ),
      };
    }

    const init: RequestInit = {
      method: currentMethod,
      headers,
      redirect: "manual",
      signal,
    };
    if (currentBody !== undefined && currentBody !== null) {
      init.body = currentBody;
    }

    let response: Response;
    try {
      response = await fetchImplementation(currentUrl, init);
    } catch (error) {
      const timeout = isTimeoutError(error, signal);
      return {
        ok: false,
        failure: extractionFailure(
          timeout ? "timeout" : "network",
          timeout
            ? `HTTP request exceeded ${timeoutMs} ms`
            : error instanceof Error
              ? error.message
              : "HTTP request failed",
          false,
        ),
      };
    }

    if (response.url.length > 0) {
      try {
        assertAllowedUrl(response.url, allowedDomains);
      } catch (error) {
        await cancelResponseBody(response);
        return {
          ok: false,
          failure: extractionFailure(
            "domain-denied",
            error instanceof Error ? error.message : "Response domain is not allowed",
            true,
            response.status,
          ),
        };
      }
    }

    if (REDIRECT_STATUSES.has(response.status)) {
      const location = response.headers.get("location");
      if (location === null) {
        await cancelResponseBody(response);
        return {
          ok: false,
          failure: extractionFailure(
            "unknown",
            "Redirect response did not include a Location header",
            true,
            response.status,
          ),
        };
      }
      await cancelResponseBody(response);
      let nextUrl: string;
      try {
        nextUrl = new URL(location, currentUrl).toString();
      } catch (error) {
        return {
          ok: false,
          failure: extractionFailure(
            "network",
            error instanceof Error ? error.message : "Redirect URL is invalid",
            true,
            response.status,
          ),
        };
      }
      try {
        assertAllowedUrl(nextUrl, allowedDomains);
      } catch (error) {
        return {
          ok: false,
          failure: extractionFailure(
            "domain-denied",
            error instanceof Error ? error.message : "Redirect domain is not allowed",
            true,
            response.status,
          ),
        };
      }
      if (redirects === maxRedirects) {
        return {
          ok: false,
          failure: extractionFailure(
            "network",
            `HTTP request exceeded ${maxRedirects} redirects`,
            true,
            response.status,
          ),
        };
      }

      previousStatus = response.status;
      currentUrl = nextUrl;
      if (
        response.status === 303
        || ((response.status === 301 || response.status === 302)
          && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = null;
        headers.delete("content-length");
        headers.delete("content-type");
      }
      continue;
    }

    let bodyResult: BodyReadResult;
    try {
      bodyResult = await readBodyBounded(response, maxBodyBytes);
    } catch (error) {
      const timeout = isTimeoutError(error, signal);
      return {
        ok: false,
        failure: extractionFailure(
          timeout ? "timeout" : "network",
          timeout
            ? `HTTP response exceeded ${timeoutMs} ms`
            : error instanceof Error
              ? error.message
              : "HTTP response stream failed",
          true,
          response.status,
        ),
      };
    }
    if (!bodyResult.ok) {
      if (!response.ok) {
        return { ok: false, failure: statusFailure(response.status, "") };
      }
      return {
        ok: false,
        failure: extractionFailure(
          "parse",
          bodyResult.message,
          true,
          response.status,
        ),
      };
    }

    if (!response.ok || CAPTCHA_PATTERN.test(bodyResult.body)) {
      return {
        ok: false,
        failure: statusFailure(response.status, bodyResult.body),
      };
    }

    return {
      ok: true,
      response: {
        url: response.url || currentUrl,
        status: response.status,
        headers: response.headers,
        body: bodyResult.body,
        bytes: bodyResult.bytes,
      },
    };
  }

  return {
    ok: false,
    failure: extractionFailure(
      "network",
      `HTTP request exceeded ${maxRedirects} redirects`,
      true,
    ),
  };
}
