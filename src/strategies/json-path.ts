import { JSONPath } from "jsonpath-plus";

const UNSAFE_JSON_PATH = /(?:[?()`]|__proto__|prototype|constructor)/iu;

export function isSafeJsonPath(path: string): boolean {
  return path.startsWith("$") && !UNSAFE_JSON_PATH.test(path);
}

function assertSafeJsonPath(path: string): void {
  if (!isSafeJsonPath(path)) {
    throw new Error(`Unsafe JSONPath expression: ${path}`);
  }
}

export function safeJsonPathValues(document: unknown, path: string): unknown[] {
  assertSafeJsonPath(path);
  return JSONPath<unknown[]>({
    path,
    json: document as null | boolean | number | string | object | unknown[],
    resultType: "value",
    wrap: true,
    eval: false,
  });
}

export function safeJsonPathValue(document: unknown, path: string): unknown {
  return safeJsonPathValues(document, path)[0];
}
