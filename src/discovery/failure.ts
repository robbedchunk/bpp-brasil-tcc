import type { ExtractionFailure } from "../strategies/types.js";

export class DiscoveryFailureError extends Error {
  readonly failure: ExtractionFailure;

  constructor(failure: ExtractionFailure, options?: ErrorOptions) {
    super(failure.message, options);
    this.name = "DiscoveryFailureError";
    this.failure = { ...failure };
  }
}

export function discoveryFailureFromUnknown(error: unknown): ExtractionFailure {
  if (error instanceof DiscoveryFailureError) return error.failure;
  return {
    category: "unknown",
    message: error instanceof Error && error.message.trim().length > 0
      ? error.message
      : String(error) || "Unknown discovery failure",
    responded: false,
  };
}
