import type { Page } from "playwright";

import type {
  ExtractionRequestTemplate,
  ScriptExtractionStrategy,
} from "../strategies/schema.js";
import type {
  ExtractionFailure,
  ExtractionResult,
  FailureCategory,
  ProductRef,
} from "../strategies/types.js";
import {
  assertNavigationAllowed,
  DomainDeniedError,
  withRestrictedPage,
} from "./browser.js";
import {
  mapExtractionFields,
  mapJsonExtractionFields,
  type RawExtractionFields,
} from "./field-map.js";
import {
  fetchBounded,
  renderRequestTemplate,
  renderTemplateString,
  renderUrlTemplate,
  type ExtractionExecutionContext,
} from "./http.js";

const MAX_OPERATIONS = 100;
const MAX_TOTAL_RUNTIME_MS = 60_000;

type ScriptOperation = ScriptExtractionStrategy["operations"][number];
type DomExtractOperation = Extract<ScriptOperation, { op: "extract"; source: "dom" }>;

class OperationFailure extends Error {
  readonly failure: ExtractionFailure;

  constructor(failure: ExtractionFailure) {
    super(failure.message);
    this.name = "OperationFailure";
    this.failure = failure;
  }
}

function failure(
  category: FailureCategory,
  message: string,
  responded: boolean,
  statusCode?: number,
): ExtractionResult {
  return {
    ok: false,
    failure: statusCode === undefined
      ? { category, message, responded }
      : { category, message, responded, statusCode },
  };
}

function asFailure(error: unknown): ExtractionResult {
  if (error instanceof OperationFailure) return { ok: false, failure: error.failure };
  if (error instanceof DomainDeniedError) {
    return failure("domain-denied", error.message, false);
  }
  if (error instanceof Error && error.name === "TimeoutError") {
    return failure("timeout", error.message, false);
  }
  return failure(
    "unknown",
    error instanceof Error ? error.message : "Restricted script operation failed",
    false,
  );
}

async function withDeadline<T>(
  operation: () => Promise<T>,
  timeoutMs: number,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      const error = new Error(`Operation exceeded ${timeoutMs} ms`);
      error.name = "TimeoutError";
      reject(error);
    }, timeoutMs);
  });
  try {
    return await Promise.race([Promise.resolve().then(operation), timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function readFirst(
  page: Page,
  selectors: DomExtractOperation["selectors"][keyof DomExtractOperation["selectors"]],
  timeoutMs: number,
): Promise<string | null> {
  for (const candidate of selectors) {
    try {
      const locator = page.locator(candidate.selector).first();
      if (await locator.count() === 0) continue;
      const value = candidate.attribute === undefined
        ? await locator.textContent({ timeout: timeoutMs })
        : await locator.getAttribute(candidate.attribute, { timeout: timeoutMs });
      if (value !== null && value.trim().length > 0) return value.trim();
    } catch {
      // Continue through the declared fallback order.
    }
  }
  return null;
}

async function extractDom(
  page: Page,
  selectors: DomExtractOperation["selectors"],
  timeoutMs: number,
): Promise<RawExtractionFields> {
  const [title, brand, price, promoPrice, unit, availability] = await Promise.all([
    readFirst(page, selectors.title, timeoutMs),
    readFirst(page, selectors.brand, timeoutMs),
    readFirst(page, selectors.price, timeoutMs),
    readFirst(page, selectors.promoPrice, timeoutMs),
    readFirst(page, selectors.unit, timeoutMs),
    readFirst(page, selectors.availability, timeoutMs),
  ]);
  return { title, brand, price, promoPrice, unit, availability };
}

async function executePageOperation(
  operation: Exclude<ScriptOperation, { op: "http" } | { op: "extract" }>,
  page: Page,
  strategy: ScriptExtractionStrategy,
  ref: ProductRef,
  executionContext: ExtractionExecutionContext,
): Promise<void> {
  const timeout = operation.timeoutMs ?? executionContext.timeoutMs ?? 10_000;
  switch (operation.op) {
    case "goto": {
      const rendered = renderUrlTemplate(operation.url, ref);
      const target = assertNavigationAllowed(rendered, ref.canonicalUrl, strategy.allowedDomains);
      const response = await page.goto(target, { waitUntil: "domcontentloaded", timeout });
      assertNavigationAllowed(page.url(), target, strategy.allowedDomains);
      if (response === null) {
        throw new OperationFailure({
          category: "network",
          message: "Navigation produced no response",
          responded: false,
        });
      }
      if (response.status() === 403 || response.status() === 429) {
        throw new OperationFailure({
          category: response.status() === 403 ? "http-403" : "http-429",
          message: `HTTP ${response.status()}`,
          responded: true,
          statusCode: response.status(),
        });
      }
      if (!response.ok()) {
        throw new OperationFailure({
          category: "network",
          message: `HTTP ${response.status()}`,
          responded: true,
          statusCode: response.status(),
        });
      }
      return;
    }
    case "click":
      await page.locator(operation.selector).first().click({ timeout });
      return;
    case "fill":
      await page.locator(operation.selector).first().fill(
        renderTemplateString(operation.value, ref),
        { timeout },
      );
      return;
    case "select":
      await page.locator(operation.selector).first().selectOption(
        renderTemplateString(operation.value, ref),
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

export async function executeRestrictedScript(
  strategy: ScriptExtractionStrategy,
  ref: ProductRef,
  executionContext: ExtractionExecutionContext = {},
): Promise<ExtractionResult> {
  if (strategy.operations.length > MAX_OPERATIONS) {
    return failure("parse", `Operation limit exceeds ${MAX_OPERATIONS}`, false);
  }

  try {
    return await withRestrictedPage(
      strategy.allowedDomains,
      executionContext,
      async (session) => withDeadline(async () => {
        const savedJson = new Map<string, unknown>();
        let result: ExtractionResult | null = null;

        try {
          for (const operation of strategy.operations) {
            if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);

            if (operation.op === "http") {
              const request = renderRequestTemplate(
                operation.request as ExtractionRequestTemplate,
                ref,
              );
              const httpContext = operation.timeoutMs === undefined
                ? executionContext
                : { ...executionContext, timeoutMs: operation.timeoutMs };
              const fetched = await fetchBounded(
                request,
                strategy.allowedDomains,
                httpContext,
              );
              if (!fetched.ok) throw new OperationFailure(fetched.failure);
              try {
                savedJson.set(operation.saveAs, JSON.parse(fetched.response.body));
              } catch {
                throw new OperationFailure({
                  category: "parse",
                  message: `HTTP operation ${operation.saveAs} did not return valid JSON`,
                  responded: true,
                  statusCode: fetched.response.status,
                });
              }
              if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
              continue;
            }

            if (operation.op === "extract") {
              const timeout = operation.timeoutMs ?? executionContext.timeoutMs ?? 10_000;
              if (operation.source === "dom") {
                result = await withDeadline(
                  async () => mapExtractionFields(
                    await extractDom(session.page, operation.selectors, timeout),
                  ),
                  timeout,
                );
              } else {
                if (!savedJson.has(operation.from)) {
                  throw new OperationFailure({
                    category: "parse",
                    message: `Unknown saved HTTP result: ${operation.from}`,
                    responded: false,
                  });
                }
                result = await withDeadline(
                  async () => mapJsonExtractionFields(
                    savedJson.get(operation.from),
                    operation.fields,
                  ),
                  timeout,
                );
              }
              if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
              continue;
            }

            await withDeadline(
              async () => executePageOperation(
                operation,
                session.page,
                strategy,
                ref,
                executionContext,
              ),
              operation.timeoutMs ?? executionContext.timeoutMs ?? 10_000,
            );
            if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
          }
          if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
          return result ?? failure("missing-fields", "Script did not extract product fields", false);
        } catch (error) {
          if (session.deniedUrl !== null) {
            return failure("domain-denied", `URL domain is not allowed: ${session.deniedUrl}`, false);
          }
          return asFailure(error);
        }
      }, MAX_TOTAL_RUNTIME_MS),
    );
  } catch (error) {
    return asFailure(error);
  }
}
