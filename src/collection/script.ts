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
  type RestrictedPageSession,
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

interface DeadlineCancellation {
  controller: AbortController;
  cancel: () => Promise<void>;
}

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
  executionContext: ExtractionExecutionContext,
  session: RestrictedPageSession,
): Promise<T> {
  const parentSignal = executionContext.signal;
  const controller = new AbortController();
  executionContext.signal = parentSignal === undefined
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
      delete executionContext.signal;
    } else {
      executionContext.signal = parentSignal;
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
  let timeoutError: Error | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => {
      timeoutError = new Error(`Script exceeded ${timeoutMs} ms`);
      timeoutError.name = "TimeoutError";
      controller.abort(timeoutError);
      cancellation = cancel().catch(() => undefined);
      reject(timeoutError);
    }, timeoutMs);
  });
  const work = Promise.resolve().then(operation);

  try {
    return await Promise.race([work, timeout]);
  } catch (error) {
    if (timeoutError !== undefined) {
      await cancellation;
      await work.catch(() => undefined);
      throw timeoutError;
    }
    throw error;
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

async function runRestrictedProgram(
  strategy: ScriptExtractionStrategy,
  ref: ProductRef,
  executionContext: ExtractionExecutionContext,
  session: RestrictedPageSession,
): Promise<ExtractionResult> {
  const savedJson = new Map<string, unknown>();
  let result: ExtractionResult | null = null;

  try {
    for (const operation of strategy.operations) {
      if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
      if (session.bodyLimitExceeded) {
        return failure("parse", "Browser response exceeded maxBodyBytes", true);
      }
      if (session.redirectLimitExceeded) {
        return failure("network", "Browser redirect limit exceeded", true);
      }
      if (session.policyDenied) {
        return failure("domain-denied", "Navigation denied by policy", false);
      }

      if (operation.op === "http") {
        const request = renderRequestTemplate(
          operation.request as ExtractionRequestTemplate,
          ref,
        );
        const httpContext = operation.timeoutMs === undefined
          ? executionContext
          : { ...executionContext, timeoutMs: operation.timeoutMs };
        const fetched = await fetchBounded(request, strategy.allowedDomains, httpContext);
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
        continue;
      }

      await withPageOperationDeadline(
        async () => executePageOperation(
          operation,
          session.page,
          strategy,
          ref,
          executionContext,
        ),
        operation.timeoutMs ?? executionContext.timeoutMs ?? 10_000,
        executionContext,
        session,
      );
    }
    if (session.deniedUrl !== null) throw new DomainDeniedError(session.deniedUrl);
    if (session.bodyLimitExceeded) {
      return failure("parse", "Browser response exceeded maxBodyBytes", true);
    }
    if (session.redirectLimitExceeded) {
      return failure("network", "Browser redirect limit exceeded", true);
    }
    return result ?? failure("missing-fields", "Script did not extract product fields", false);
  } catch (error) {
    if (session.deniedUrl !== null) {
      return failure("domain-denied", `URL domain is not allowed: ${session.deniedUrl}`, false);
    }
    if (session.bodyLimitExceeded) {
      return failure("parse", "Browser response exceeded maxBodyBytes", true);
    }
    if (session.redirectLimitExceeded) {
      return failure("network", "Browser redirect limit exceeded", true);
    }
    if (session.policyDenied) {
      return failure("domain-denied", "Navigation denied by policy", false);
    }
    return asFailure(error);
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

  const totalController = new AbortController();
  const totalSignal = executionContext.signal === undefined
    ? totalController.signal
    : AbortSignal.any([totalController.signal, executionContext.signal]);
  const programContext: ExtractionExecutionContext = {
    ...executionContext,
    signal: totalSignal,
  };

  try {
    return await withRestrictedPage(
      strategy.allowedDomains,
      programContext,
      async (session) => {
        totalSignal.throwIfAborted();
        return withTotalDeadline(
          async () => runRestrictedProgram(strategy, ref, programContext, session),
          executionContext.totalTimeoutMs ?? MAX_TOTAL_RUNTIME_MS,
          totalController,
          async () => {
            await session.page.close().catch(() => undefined);
            await session.waitForInFlightRequests();
          },
        );
      },
    );
  } catch (error) {
    return asFailure(error);
  }
}
