const FORBIDDEN_KEYS = new Set([
  "base_url",
  "canonical_url",
  "domains_json",
  "error_message",
  "message",
  "response_path",
  "response_sha256",
  "receipt_path",
  "strategy_json",
  "input_json",
  "output_json",
  "provider_errors_json",
  "details_json",
  "artifact_json",
  "executor_json",
  "processIdentity",
  "pid",
  "token",
  "apiKey",
]);

function assertSafeString(value: string): void {
  if (/https?:\/\//iu.test(value)) {
    throw new Error("API payload contains a URL");
  }
  if (/(?:^|\s)\/(?:home|root|tmp|var|etc)\//u.test(value) || /[A-Za-z]:\\/u.test(value)) {
    throw new Error("API payload contains a private absolute path");
  }
}

export function assertSafeApiPayload(value: unknown, path = "response"): void {
  if (typeof value === "string") {
    assertSafeString(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    value.forEach((item, index) => assertSafeApiPayload(item, `${path}[${index}]`));
    return;
  }
  for (const [key, child] of Object.entries(value)) {
    if (FORBIDDEN_KEYS.has(key)) {
      throw new Error(`API payload contains forbidden field ${path}.${key}`);
    }
    assertSafeApiPayload(child, `${path}.${key}`);
  }
}
