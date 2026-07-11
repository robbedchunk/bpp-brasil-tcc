import type { FailureCategory } from "../strategies/types.js";

export type RunHealth = "healthy" | "drift" | "blocking" | "mixed";

export interface RunHealthInput {
  attempted: number;
  ok: number;
  failed: number;
  status: string;
  stoppedForBlocking?: boolean;
}

export interface RunFailureEvidence {
  category: FailureCategory;
  responded: boolean;
}

export interface RunHealthAssessment {
  health: RunHealth;
  driftRatio: number;
  blockingRatio: number;
  ambiguousRatio: number;
}

const EXTRACTION_FAILURES = new Set<FailureCategory>([
  "parse",
  "missing-fields",
  "invalid-price",
]);

const HARD_BLOCKING_FAILURES = new Set<FailureCategory>([
  "http-403",
  "http-429",
  "captcha",
  "domain-denied",
]);

const TRANSPORT_FAILURES = new Set<FailureCategory>([
  "timeout",
  "network",
]);

export function assessRunHealth(
  run: RunHealthInput,
  failures: readonly RunFailureEvidence[],
): RunHealthAssessment {
  if (
    !Number.isSafeInteger(run.attempted)
    || !Number.isSafeInteger(run.ok)
    || !Number.isSafeInteger(run.failed)
    || run.attempted < 0
    || run.ok < 0
    || run.failed < 0
    || run.attempted !== run.ok + run.failed
  ) {
    throw new Error("Run counters must be non-negative and internally consistent");
  }
  if (
    run.stoppedForBlocking !== true
    && run.attempted > 0
    && run.ok / run.attempted >= 0.7
  ) {
    return { health: "healthy", driftRatio: 0, blockingRatio: 0, ambiguousRatio: 0 };
  }

  let drift = 0;
  let hardBlocking = 0;
  let transport = 0;
  let ambiguous = Math.max(0, run.failed - failures.length);
  for (const failure of failures) {
    if (HARD_BLOCKING_FAILURES.has(failure.category)) {
      hardBlocking += 1;
    } else if (TRANSPORT_FAILURES.has(failure.category)) {
      transport += 1;
    } else if (EXTRACTION_FAILURES.has(failure.category) && failure.responded) {
      drift += 1;
    } else {
      ambiguous += 1;
    }
  }

  const repeatedTransport = transport >= 2;
  const blocking = hardBlocking + (repeatedTransport ? transport : 0);
  if (!repeatedTransport) ambiguous += transport;
  const denominator = Math.max(1, run.failed);
  const driftRatio = drift / denominator;
  const blockingRatio = blocking / denominator;
  const ambiguousRatio = ambiguous / denominator;
  const health: RunHealth = run.stoppedForBlocking === true
    ? "blocking"
    : blockingRatio >= 0.2
      ? "blocking"
      : driftRatio >= 0.8
        ? "drift"
        : "mixed";
  return { health, driftRatio, blockingRatio, ambiguousRatio };
}

export function classifyRunHealth(
  run: RunHealthInput,
  failures: readonly RunFailureEvidence[],
): RunHealth {
  return assessRunHealth(run, failures).health;
}
