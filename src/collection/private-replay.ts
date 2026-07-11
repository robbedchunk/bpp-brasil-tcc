import type {
  ExtractionResult,
  ReplayPayload,
} from "../strategies/types.js";

/**
 * Makes raw replay material available to the trusted collection pipeline
 * without allowing routine object serialization or structured logging to emit
 * it accidentally.
 */
export function attachPrivateReplay(
  result: ExtractionResult,
  replay: ReplayPayload,
): ExtractionResult {
  if (result.html !== undefined) {
    Object.defineProperty(result, "html", {
      value: result.html,
      enumerable: false,
      configurable: false,
      writable: false,
    });
  }
  Object.defineProperty(result, "replay", {
    value: replay,
    enumerable: false,
    configurable: false,
    writable: false,
  });
  return result;
}
