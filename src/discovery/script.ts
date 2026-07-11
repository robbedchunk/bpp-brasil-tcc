import type { Page } from "playwright";

import {
  assertNavigationAllowed,
  type RestrictedPageSession,
  withRestrictedPage,
} from "../collection/browser.js";
import { fetchBounded } from "../collection/http.js";
import { canonicalizeRetailerUrl } from "../normalize/url.js";
import {
  safeJsonPathValue,
  safeJsonPathValues,
} from "../strategies/json-path.js";
import type {
  DiscoveryRequestTemplate,
  DiscoveryScriptOperation,
  ScriptDiscoveryStrategy,
} from "../strategies/schema.js";
import type { ProductRef } from "../strategies/types.js";
import { renderDiscoveryRequest } from "./api.js";
import type { DiscoveryExecutionContext } from "./executor.js";
import { DiscoveryFailureError } from "./failure.js";

const MAX_OPERATIONS = 100;
const MAX_TOTAL_RUNTIME_MS = 60_000;
const EMPTY_PAGINATION = {
  page: "0",
  pageSize: "",
  offset: "0",
  from: "0",
  to: "0",
  cursor: "",
  segment: "",
};

type DomExtract = Extract<DiscoveryScriptOperation, { op: "extract"; source: "dom" }>;
type JsonExtract = Extract<DiscoveryScriptOperation, { op: "extract"; source: "json" }>;

interface SavedJson {
  document: unknown;
  baseUrl: string;
}

interface DeadlineCancellation {
  controller: AbortController;
  cancel: () => Promise<void>;
}

function scriptFailure(error: unknown): DiscoveryFailureError {
  if (error instanceof DiscoveryFailureError) return error;
  const message = error instanceof Error ? error.message : String(error) || "Script discovery failed";
  const timeout = error instanceof Error
    && (error.name === "TimeoutError" || /exceeded|timeout|timed out/iu.test(error.message));
  const denied = /not allowed|outside|denied|blocked/iu.test(message);
  return new DiscoveryFailureError({
    category: timeout ? "timeout" : denied ? "domain-denied" : "unknown",
    message,
    responded: false,
  }, { cause: error });
}

function responseFailure(status: number): DiscoveryFailureError {
  return new DiscoveryFailureError({
    category: status === 403
      ? "http-403"
      : status === 429
        ? "http-429"
        : status === 408 || status === 504
          ? "timeout"
          : "unknown",
    message: `Script discovery navigation returned HTTP ${status}`,
    responded: true,
    statusCode: status,
  });
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  deadlineCancellation?: DeadlineCancellation,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timeoutError: Error | undefined;
  let cancellationStarted = false;
  let cancellation = Promise.resolve();
  const cancel = (reason: Error): void => {
    if (deadlineCancellation === undefined) return;
    if (!deadlineCancellation.controller.signal.aborted) {
      deadlineCancellation.controller.abort(reason);
    }
    if (!cancellationStarted) {
      cancellationStarted = true;
      cancellation = deadlineCancellation.cancel().catch(() => undefined);
    }
  };
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(`Operation exceeded ${timeoutMs} ms`);
      timeoutError.name = "TimeoutError";
      cancel(timeoutError);
      reject(timeoutError);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(operation);
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    const deadlineError = timeoutError
      ?? (error instanceof Error && error.name === "TimeoutError" ? error : undefined);
    if (deadlineError !== undefined) {
      cancel(deadlineError);
      await cancellation;
      await work.catch(() => undefined);
      throw deadlineError;
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function withPageOperationDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  context: DiscoveryExecutionContext,
  session: RestrictedPageSession,
): Promise<T> {
  const parentSignal = context.signal;
  const controller = new AbortController();
  context.signal = parentSignal === undefined
    ? controller.signal
    : AbortSignal.any([controller.signal, parentSignal]);
  try {
    return await withDeadline(operation, timeoutMs, {
      controller,
      cancel: async () => {
        await session.page.close().catch(() => undefined);
        await session.waitForInFlightRequests();
      },
    });
  } finally {
    if (parentSignal === undefined) {
      delete context.signal;
    } else {
      context.signal = parentSignal;
    }
  }
}

async function withTotalDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
  controller: AbortController,
  cancel: () => Promise<void>,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let cancellation = Promise.resolve();
  let timedOut = false;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      const error = new Error(`Script exceeded ${timeoutMs} ms`);
      controller.abort(error);
      cancellation = cancel().catch(() => undefined);
      reject(error);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(operation);
  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (timedOut) {
      await cancellation;
      await work.catch(() => undefined);
    }
    throw error;
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

function renderDiscoveryString(template: string): string {
  return template.replace(
    /\{(page|pageSize|offset|from|to|cursor|segment)\}/gu,
    (_match, name: keyof typeof EMPTY_PAGINATION) => EMPTY_PAGINATION[name],
  );
}

async function selectorLinks(
  page: Page,
  selectors: DomExtract["linkSelectors"],
  timeoutMs: number,
  maxMatches: number,
): Promise<string[]> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector);
      const count = Math.min(await locator.count(), maxMatches);
      const values: string[] = [];
      for (let index = 0; index < count; index += 1) {
        const value = await locator.nth(index).getAttribute(
          candidate.attribute ?? "href",
          { timeout: timeoutMs },
        );
        if (value !== null && value.trim().length > 0) values.push(value.trim());
      }
      if (values.length > 0) return values;
    } catch {
      // Continue through the declared fallback order.
    }
  }
  return [];
}

function jsonItems(document: unknown, path: string): unknown[] {
  const wildcardMatch = /^(.*)\[\*\]$/u.exec(path);
  const containers = wildcardMatch === null
    ? safeJsonPathValues(document, path)
    : safeJsonPathValues(document, wildcardMatch[1] ?? "");
  if (containers.length === 0 || containers.some((value) => !Array.isArray(value))) {
    throw new DiscoveryFailureError({
      category: "parse",
      message: `Script discovery items path ${path} was missing or not an array`,
      responded: true,
    });
  }
  return containers.flatMap((value) => value as unknown[]);
}

function jsonValue(document: unknown, path: string | undefined): unknown {
  if (path === undefined) return undefined;
  return safeJsonPathValue(document, path);
}

function optionalString(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  const string = String(value).trim();
  return string.length === 0 ? null : string;
}

function jsonRefs(
  saved: SavedJson,
  operation: JsonExtract,
  strategy: ScriptDiscoveryStrategy,
): ProductRef[] {
  const refs: ProductRef[] = [];
  for (const item of jsonItems(saved.document, operation.itemsPath)) {
    const rawUrl = jsonValue(item, operation.refFields.url);
    if (typeof rawUrl !== "string" || rawUrl.trim().length === 0) continue;
    try {
      refs.push({
        canonicalUrl: canonicalizeRetailerUrl(
          rawUrl,
          saved.baseUrl,
          strategy.allowedDomains,
        ),
        externalId: optionalString(jsonValue(item, operation.refFields.externalId)),
        sourceCategory: optionalString(jsonValue(item, operation.refFields.sourceCategory)),
      });
    } catch {
      // Ignore malformed or cross-domain discovered URLs.
    }
  }
  if (refs.length === 0) {
    throw new DiscoveryFailureError({
      category: "parse",
      message: "Script discovery mapping produced no valid product references",
      responded: true,
    });
  }
  return refs;
}

async function pageOperation(
  operation: Exclude<DiscoveryScriptOperation, { op: "http" } | { op: "extract" }>,
  page: Page,
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<void> {
  const timeout = operation.timeoutMs ?? context.timeoutMs ?? 10_000;
  switch (operation.op) {
    case "goto": {
      const rendered = renderDiscoveryString(operation.url);
      const target = assertNavigationAllowed(rendered, rendered, strategy.allowedDomains);
      await context.beforeRequest?.();
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout });
      if (response === null) {
        throw new DiscoveryFailureError({
          category: "network",
          message: "Script discovery navigation returned no response",
          responded: false,
        });
      }
      if (!response.ok()) throw responseFailure(response.status());
      assertNavigationAllowed(page.url(), target, strategy.allowedDomains);
      return;
    }
    case "click":
      await context.beforeRequest?.();
      await page.locator(operation.selector).first().click({ timeout });
      return;
    case "fill":
      await page.locator(operation.selector).first().fill(
        renderDiscoveryString(operation.value),
        { timeout },
      );
      return;
    case "select":
      await page.locator(operation.selector).first().selectOption(
        renderDiscoveryString(operation.value),
        { timeout },
      );
      return;
    case "waitFor":
      await page.locator(operation.selector).first().waitFor({
        state: operation.state ?? "visible",
        timeout,
      });
      return;
    case "scroll":
      await page.mouse.wheel(0, operation.deltaY);
      return;
  }
}

async function runDiscoveryProgram(
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
  session: RestrictedPageSession,
): Promise<ProductRef[]> {
  const refs: ProductRef[] = [];
  const seenRefs = new Set<string>();
  const savedJson = new Map<string, SavedJson>();

  const appendRef = (ref: ProductRef): boolean => {
    if (seenRefs.has(ref.canonicalUrl)) return false;
    seenRefs.add(ref.canonicalUrl);
    refs.push(ref);
    return refs.length >= strategy.maxProducts;
  };

  try {
    for (const operation of strategy.operations) {
      if (session.deniedUrl !== null || session.policyDenied) {
        throw new DiscoveryFailureError({
          category: "domain-denied",
          message: "Script discovery request was denied before parsing",
          responded: false,
        });
      }
      if (session.bodyLimitExceeded) {
        throw new DiscoveryFailureError({
          category: "parse",
          message: "Script discovery response exceeded the body limit",
          responded: true,
        });
      }
      if (session.redirectLimitExceeded) {
        throw new DiscoveryFailureError({
          category: "network",
          message: "Script discovery exceeded the redirect limit",
          responded: true,
        });
      }

      if (operation.op === "http") {
        const request = renderDiscoveryRequest(
          operation.request as DiscoveryRequestTemplate,
          EMPTY_PAGINATION,
        );
        const requestContext = operation.timeoutMs === undefined
          ? context
          : { ...context, timeoutMs: operation.timeoutMs };
        await context.beforeRequest?.();
        const fetched = await fetchBounded(request, strategy.allowedDomains, requestContext);
        if (!fetched.ok) throw new DiscoveryFailureError(fetched.failure);
        try {
          savedJson.set(operation.saveAs, {
            document: JSON.parse(fetched.response.body),
            baseUrl: fetched.response.url,
          });
        } catch (error) {
          throw new DiscoveryFailureError({
            category: "parse",
            message: "Script discovery HTTP response was not valid JSON",
            responded: true,
            statusCode: fetched.response.status,
          }, { cause: error });
        }
        continue;
      }

      if (operation.op === "extract") {
        const timeout = operation.timeoutMs ?? context.timeoutMs ?? 10_000;
        if (operation.source === "dom") {
          const links = await withDeadline(
            async () => selectorLinks(
              session.page,
              operation.linkSelectors,
              timeout,
              context.maxDomMatches ?? 1_000,
            ),
            timeout,
          );
          for (const link of links) {
            try {
              if (appendRef({
                canonicalUrl: canonicalizeRetailerUrl(
                  link,
                  session.finalDocumentUrl ?? session.page.url(),
                  strategy.allowedDomains,
                ),
                externalId: null,
                sourceCategory: null,
              })) {
                context.reportCompletion?.({ complete: false, reason: "product_cap_reached" });
                return refs;
              }
            } catch {
              // Ignore malformed or cross-domain discovered URLs.
            }
          }
        } else {
          const saved = savedJson.get(operation.from);
          if (saved === undefined) {
            throw new DiscoveryFailureError({
              category: "parse",
              message: `Script discovery JSON source ${operation.from} is missing`,
              responded: false,
            });
          }
          const discovered = await withDeadline(
            async () => jsonRefs(saved, operation, strategy),
            timeout,
          );
          for (const ref of discovered) {
            if (appendRef(ref)) {
              context.reportCompletion?.({ complete: false, reason: "product_cap_reached" });
              return refs;
            }
          }
        }
        continue;
      }

      session.deniedUrl = null;
      await withPageOperationDeadline(
        async () => pageOperation(operation, session.page, strategy, context),
        operation.timeoutMs ?? context.timeoutMs ?? 10_000,
        context,
        session,
      );
    }
  } catch (error) {
    throw scriptFailure(error);
  }

  if (refs.length === 0) {
    throw new DiscoveryFailureError({
      category: "parse",
      message: "Script discovery completed without product references",
      responded: true,
    });
  }
  context.reportCompletion?.({ complete: false, reason: "page_cap_reached" });
  return refs.slice(0, strategy.maxProducts);
}

export async function discoverScript(
  strategy: ScriptDiscoveryStrategy,
  context: DiscoveryExecutionContext,
): Promise<ProductRef[]> {
  if (strategy.operations.length > MAX_OPERATIONS) {
    throw new DiscoveryFailureError({
      category: "parse",
      message: `Script discovery exceeds the ${MAX_OPERATIONS}-operation limit`,
      responded: false,
    });
  }

  const totalController = new AbortController();
  const totalSignal = context.signal === undefined
    ? totalController.signal
    : AbortSignal.any([totalController.signal, context.signal]);
  const programContext: DiscoveryExecutionContext = {
    ...context,
    signal: totalSignal,
  };

  try {
    return await withRestrictedPage(
      strategy.allowedDomains,
      programContext,
      async (session) => {
        totalSignal.throwIfAborted();
        return withTotalDeadline(
          async () => runDiscoveryProgram(strategy, programContext, session),
          context.totalTimeoutMs ?? MAX_TOTAL_RUNTIME_MS,
          totalController,
          async () => {
            await session.page.close().catch(() => undefined);
            await session.waitForInFlightRequests();
          },
        );
      },
    );
  } catch (error) {
    throw scriptFailure(error);
  }
}
