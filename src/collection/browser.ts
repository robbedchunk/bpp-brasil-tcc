import {
  chromium,
  type Browser,
  type BrowserContext,
  type Page,
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
    });
    return { browser, browserContext, ownsBrowser };
  } catch (error) {
    if (ownsBrowser) await browser.close().catch(() => undefined);
    throw error;
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
    const session: RestrictedPageSession = { page, deniedUrl: null };

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
