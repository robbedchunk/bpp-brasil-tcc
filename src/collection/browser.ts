import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";

import { canonicalizeRetailerUrl } from "../normalize/url.js";
import {
  DEFAULT_MAX_BODY_BYTES,
  DEFAULT_MAX_REDIRECTS,
  DEFAULT_RESEARCH_USER_AGENT,
  type ExtractionExecutionContext,
} from "./http.js";

const BLOCKED_RESOURCE_TYPES = new Set(["font", "image", "media"]);

export class DomainDeniedError extends Error {
  readonly url: string;

  constructor(url: string) {
    super(`URL domain is not allowed: ${url}`);
    this.name = "DomainDeniedError";
    this.url = url;
  }
}

export interface RestrictedPageSession {
  page: Page;
  deniedUrl: string | null;
  bodyLimitExceeded: boolean;
  redirectLimitExceeded: boolean;
  policyDenied: boolean;
  finalDocumentUrl: string | null;
}

interface BrowserResources {
  browser: Browser;
  browserContext: BrowserContext;
  ownsBrowser: boolean;
}

function assertAllowedUrl(url: string, allowedDomains: string[]): void {
  canonicalizeRetailerUrl(url, url, allowedDomains);
}

async function createResources(
  executionContext: ExtractionExecutionContext,
): Promise<BrowserResources> {
  const ownsBrowser = executionContext.browser === undefined;
  const browser = executionContext.browser ?? await chromium.launch({ headless: true });
  try {
    const browserContext = await browser.newContext({
      userAgent: executionContext.userAgent?.trim() || DEFAULT_RESEARCH_USER_AGENT,
      serviceWorkers: "block",
    });
    return { browser, browserContext, ownsBrowser };
  } catch (error) {
    if (ownsBrowser) await browser.close().catch(() => undefined);
    throw error;
  }
}

async function readNavigationBody(
  response: Response,
  remainingBytes: number,
): Promise<Uint8Array | null> {
  const declared = Number(response.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > remainingBytes) {
    await response.body?.cancel().catch(() => undefined);
    return null;
  }
  if (response.body === null) return new Uint8Array();

  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) break;
      total += chunk.value.byteLength;
      if (total > remainingBytes) {
        await reader.cancel();
        return null;
      }
      chunks.push(chunk.value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function responseHeaders(response: Response): Record<string, string> {
  const headers = Object.fromEntries(response.headers);
  delete headers["content-encoding"];
  delete headers["content-length"];
  return headers;
}

interface RequestBudget {
  bytes: number;
  redirects: number;
}

async function handleRequest(
  route: Route,
  session: RestrictedPageSession,
  allowedDomains: string[],
  executionContext: ExtractionExecutionContext,
  budget: RequestBudget,
): Promise<void> {
  const request = route.request();
  const isMainDocument = request.isNavigationRequest()
    && request.frame() === session.page.mainFrame();
  if (
    request.isNavigationRequest()
    && executionContext.allowDocumentUrl?.(request.url()) === false
  ) {
    if (isMainDocument) session.policyDenied = true;
    await route.abort("blockedbyclient");
    return;
  }
  const headers = new Headers(request.headers());
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const timeout = AbortSignal.timeout(executionContext.timeoutMs ?? 10_000);
  const signal = executionContext.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, executionContext.signal]);
  if (signal.aborted) {
    await route.abort("failed").catch(() => undefined);
    return;
  }
  const maximumRedirects = Math.max(
    0,
    executionContext.maxRedirects ?? DEFAULT_MAX_REDIRECTS,
  );
  const maximumBytes = executionContext.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES;
  let currentUrl = request.url();
  let currentMethod = request.method();
  const postData = request.postDataBuffer();
  let currentBody: Buffer | null = postData;

  while (true) {
    const init: RequestInit = {
      method: currentMethod,
      headers,
      redirect: "manual",
      signal,
    };
    if (currentBody !== null) init.body = currentBody;

    let response: Response;
    try {
      response = await (executionContext.fetch ?? globalThis.fetch)(currentUrl, init);
    } catch {
      await route.abort("failed").catch(() => undefined);
      return;
    }

    const responseUrl = response.url || currentUrl;
    let redirectUrl: string | null = null;
    try {
      assertAllowedUrl(responseUrl, allowedDomains);
      if (
        request.isNavigationRequest()
        && responseUrl !== currentUrl
        && executionContext.allowDocumentUrl?.(responseUrl) === false
      ) {
        if (isMainDocument) session.policyDenied = true;
        await response.body?.cancel().catch(() => undefined);
        await route.abort("blockedbyclient");
        return;
      }
      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        if (location !== null) {
          redirectUrl = new URL(location, responseUrl).toString();
          assertAllowedUrl(redirectUrl, allowedDomains);
          if (
            request.isNavigationRequest()
            && executionContext.allowDocumentUrl?.(redirectUrl) === false
          ) {
            if (isMainDocument) session.policyDenied = true;
            await response.body?.cancel().catch(() => undefined);
            await route.abort("blockedbyclient");
            return;
          }
          if (budget.redirects >= maximumRedirects) {
            session.redirectLimitExceeded = true;
            await response.body?.cancel().catch(() => undefined);
            await route.abort("blockedbyclient");
            return;
          }
        }
      }
    } catch {
      if (isMainDocument) session.deniedUrl = redirectUrl ?? responseUrl;
      await response.body?.cancel().catch(() => undefined);
      await route.abort("blockedbyclient");
      return;
    }

    const body = await readNavigationBody(response, maximumBytes - budget.bytes);
    if (body === null) {
      session.bodyLimitExceeded = true;
      await route.abort("blockedbyclient");
      return;
    }
    budget.bytes += body.byteLength;

    if (redirectUrl !== null) {
      budget.redirects += 1;
      if (new URL(redirectUrl).origin !== new URL(currentUrl).origin) {
        headers.delete("authorization");
        headers.delete("cookie");
        headers.delete("proxy-authorization");
      }
      if (
        response.status === 303
        || ((response.status === 301 || response.status === 302) && currentMethod === "POST")
      ) {
        currentMethod = "GET";
        currentBody = null;
        headers.delete("content-type");
      }
      currentUrl = redirectUrl;
      continue;
    }

    if (isMainDocument) session.finalDocumentUrl = responseUrl;
    await route.fulfill({
      status: response.status,
      headers: responseHeaders(response),
      body: Buffer.from(body),
    });
    return;
  }
}

export async function withRestrictedPage<T>(
  allowedDomains: string[],
  executionContext: ExtractionExecutionContext,
  run: (session: RestrictedPageSession) => Promise<T>,
): Promise<T> {
  const resources = await createResources(executionContext);
  try {
    const page = await resources.browserContext.newPage();
    page.setDefaultTimeout(executionContext.timeoutMs ?? 10_000);
    const session: RestrictedPageSession = {
      page,
      deniedUrl: null,
      bodyLimitExceeded: false,
      redirectLimitExceeded: false,
      policyDenied: false,
      finalDocumentUrl: null,
    };
    const requestBudget: RequestBudget = { bytes: 0, redirects: 0 };
    let requestQueue = Promise.resolve();

    await resources.browserContext.routeWebSocket(/.*/u, async (webSocket) => {
      await webSocket.close({ code: 1008, reason: "WebSockets are disabled" });
    });

    page.on("framenavigated", (frame) => {
      if (frame !== page.mainFrame()) return;
      try {
        assertAllowedUrl(frame.url(), allowedDomains);
      } catch {
        session.deniedUrl = frame.url();
      }
    });

    await resources.browserContext.route("**/*", async (route) => {
      const request = route.request();
      try {
        assertAllowedUrl(request.url(), allowedDomains);
      } catch {
        if (request.isNavigationRequest()) {
          session.deniedUrl = request.url();
        }
        await route.abort("blockedbyclient");
        return;
      }

      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      const previousRequest = requestQueue;
      let releaseRequest = (): void => undefined;
      requestQueue = new Promise<void>((resolve) => {
        releaseRequest = resolve;
      });
      await previousRequest;
      try {
        await handleRequest(
          route,
          session,
          allowedDomains,
          executionContext,
          requestBudget,
        );
      } finally {
        releaseRequest();
      }
    });

    return await run(session);
  } finally {
    try {
      await resources.browserContext.close();
    } finally {
      if (resources.ownsBrowser) {
        await resources.browser.close();
      }
    }
  }
}

export function assertNavigationAllowed(
  target: string,
  baseUrl: string,
  allowedDomains: string[],
): string {
  try {
    return canonicalizeRetailerUrl(target, baseUrl, allowedDomains);
  } catch {
    throw new DomainDeniedError(target);
  }
}
