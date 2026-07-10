import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
  type Route,
} from "playwright";

import { canonicalizeRetailerUrl } from "../normalize/url.js";
import {
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

async function handleNavigation(
  route: Route,
  session: RestrictedPageSession,
  allowedDomains: string[],
  executionContext: ExtractionExecutionContext,
  navigationBudget: { bytes: number },
): Promise<void> {
  const request = route.request();
  if (request.redirectedFrom() === null) navigationBudget.bytes = 0;
  const headers = new Headers(request.headers());
  headers.delete("host");
  headers.delete("connection");
  headers.delete("content-length");
  const timeout = AbortSignal.timeout(executionContext.timeoutMs ?? 10_000);
  const signal = executionContext.signal === undefined
    ? timeout
    : AbortSignal.any([timeout, executionContext.signal]);
  const init: RequestInit = {
    method: request.method(),
    headers,
    redirect: "manual",
    signal,
  };
  const postData = request.postDataBuffer();
  if (postData !== null) init.body = postData;

  let response: Response;
  try {
    response = await (executionContext.fetch ?? globalThis.fetch)(request.url(), init);
  } catch {
    await route.abort("failed");
    return;
  }

  try {
    assertAllowedUrl(response.url || request.url(), allowedDomains);
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (location !== null) {
        const redirectUrl = new URL(location, request.url()).toString();
        assertAllowedUrl(redirectUrl, allowedDomains);
      }
    }
  } catch {
    session.deniedUrl = response.headers.get("location") ?? response.url ?? request.url();
    await response.body?.cancel().catch(() => undefined);
    await route.abort("blockedbyclient");
    return;
  }

  const maximum = executionContext.maxBodyBytes ?? 2_000_000;
  const body = await readNavigationBody(response, maximum - navigationBudget.bytes);
  if (body === null) {
    session.bodyLimitExceeded = true;
    await route.abort("blockedbyclient");
    return;
  }
  navigationBudget.bytes += body.byteLength;
  await route.fulfill({
    status: response.status,
    headers: responseHeaders(response),
    body: Buffer.from(body),
  });
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
    };
    const navigationBudget = { bytes: 0 };

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

      if (request.isNavigationRequest()) {
        await handleNavigation(
          route,
          session,
          allowedDomains,
          executionContext,
          navigationBudget,
        );
        return;
      }

      if (BLOCKED_RESOURCE_TYPES.has(request.resourceType())) {
        await route.abort("blockedbyclient");
        return;
      }
      await route.continue();
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
