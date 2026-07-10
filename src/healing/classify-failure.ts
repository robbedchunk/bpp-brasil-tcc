import type { FailureCategory } from "../strategies/types.js";

export type RunHealth = "healthy" | "drift" | "blocking" | "mixed";

export interface RunHealthInput {
  attempted: number;
  ok: number;
  failed: number;
  status: string;
}

export interface RunFailureEvidence {
  category: FailureCategory;
  responded: boolean;
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

export function classifyRunHealth(
  run: RunHealthInput,
  failures: readonly RunFailureEvidence[],
): RunHealth {
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
  if (run.attempted > 0 && run.ok / run.attempted >= 0.7) return "healthy";

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
  if (blocking > 0 && (drift > 0 || ambiguous > 0)) return "mixed";
  if (blocking > 0) return "blocking";
  // A single timeout/network failure remains ambiguous and follows the
  // no-model-spend path just like blocking evidence.
  if (transport > 0) return "mixed";
  if (drift > 0 && ambiguous === 0) return "drift";
  return "mixed";
}
