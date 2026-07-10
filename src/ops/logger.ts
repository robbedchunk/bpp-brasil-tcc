import { appendFile, chmod, mkdir, stat } from "node:fs/promises";
import { join } from "node:path";

const SECRET_KEY =
  /(?:api[_-]?key|authorization|cookie|credential|ntfy[_-]?topic|password|private[_-]?key|secret|session[_-]?id|token)/iu;

const SECRET_LABEL =
  String.raw`[\p{L}\p{N}_-]*(?:api[_-]?key|authorization|cookie|credential|ntfy[_-]?topic|password|private[_-]?key|secret|session[_-]?id|token)[\p{L}\p{N}_-]*`;
const SECRET_ASSIGNMENT = new RegExp(
  `(${SECRET_LABEL}\\s*(?:=|:)\\s*)(?:"[^"\\r\\n]*"|'[^'\\r\\n]*'|[^\\s,;&}\\]]+)`,
  "giu",
);
const SECRET_HEADER =
  /\b(authorization|proxy-authorization|cookie|set-cookie)\s*:\s*[^\r\n]*/giu;
const AUTHORIZATION_SCHEME = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/giu;
const URL_CREDENTIALS = /([a-z][a-z0-9+.-]*:\/\/)([^:/\s]+):([^@/\s]+)@/giu;
const OPENAI_TOKEN = /\bsk-(?:proj-)?[A-Za-z0-9_-]{8,}\b/gu;
const JWT = /\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu;
const PRIVATE_KEY =
  /-----BEGIN [^-\r\n]*PRIVATE KEY-----[\s\S]*?-----END [^-\r\n]*PRIVATE KEY-----/gu;

function redactString(value: string): string {
  let sanitized = value;
  for (const [key, secret] of Object.entries(process.env)) {
    if (SECRET_KEY.test(key) && secret !== undefined && secret.length > 0) {
      sanitized = sanitized.replaceAll(secret, "[REDACTED]");
    }
  }
  return sanitized
    .replace(PRIVATE_KEY, "[REDACTED]")
    .replace(SECRET_HEADER, "$1: [REDACTED]")
    .replace(AUTHORIZATION_SCHEME, "$1 [REDACTED]")
    .replace(URL_CREDENTIALS, "$1[REDACTED]@")
    .replace(SECRET_ASSIGNMENT, "$1[REDACTED]")
    .replace(OPENAI_TOKEN, "[REDACTED]")
    .replace(JWT, "[REDACTED]");
}

function redactValue(value: unknown, seen: WeakSet<object>): unknown {
  if (value === null || typeof value === "number" || typeof value === "boolean") {
    return value;
  }
  if (typeof value === "string") return redactString(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (value instanceof Date) return value.toISOString();
  if (value instanceof Error) {
    return {
      name: redactString(value.name),
      message: redactString(value.message),
      stack: value.stack === undefined ? null : redactString(value.stack),
    };
  }
  if (typeof value !== "object") return redactString(String(value));
  if (seen.has(value)) return "[CIRCULAR]";
  seen.add(value);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, seen));
  }
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [
    key,
    SECRET_KEY.test(key) ? "[REDACTED]" : redactValue(item, seen),
  ]));
}

export function redact<T>(value: T): unknown {
  return redactValue(value, new WeakSet());
}

export interface JsonlLoggerOptions {
  directory: string;
  basename: string;
  maxBytes?: number;
  now?: () => Date;
  timeZone?: string;
}

export class JsonlLogger {
  readonly #directory: string;
  readonly #basename: string;
  readonly #maxBytes: number;
  readonly #now: () => Date;
  readonly #timeZone: string;
  #queue: Promise<void> = Promise.resolve();

  constructor(options: JsonlLoggerOptions) {
    this.#directory = options.directory;
    this.#basename = options.basename;
    this.#maxBytes = options.maxBytes ?? 10 * 1024 * 1024;
    this.#now = options.now ?? (() => new Date());
    this.#timeZone = options.timeZone ?? "America/Sao_Paulo";
    if (!Number.isSafeInteger(this.#maxBytes) || this.#maxBytes <= 0) {
      throw new RangeError("maxBytes must be a positive safe integer");
    }
  }

  info(event: string, fields: unknown = {}): Promise<void> {
    return this.log("info", event, fields);
  }

  warning(event: string, fields: unknown = {}): Promise<void> {
    return this.log("warning", event, fields);
  }

  error(event: string, fields: unknown = {}): Promise<void> {
    return this.log("error", event, fields);
  }

  log(level: "info" | "warning" | "error", event: string, fields: unknown): Promise<void> {
    const write = this.#queue.then(async () => {
      const timestamp = this.#now();
      const parts = new Intl.DateTimeFormat("en-CA", {
        timeZone: this.#timeZone,
        year: "numeric",
        month: "2-digit",
        day: "2-digit",
      }).formatToParts(timestamp);
      const part = (type: Intl.DateTimeFormatPartTypes): string =>
        parts.find((candidate) => candidate.type === type)?.value ?? "00";
      const day = `${part("year")}-${part("month")}-${part("day")}`;
      const line = `${JSON.stringify({
        timestamp: timestamp.toISOString(),
        level,
        event: redactString(event),
        fields: redact(fields),
      })}\n`;
      await mkdir(this.#directory, { recursive: true, mode: 0o700 });
      let index = 0;
      let path: string;
      while (true) {
        path = join(
          this.#directory,
          `${this.#basename}-${day}${index === 0 ? "" : `.${index}`}.jsonl`,
        );
        const size = await stat(path).then((value) => value.size).catch(
          (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? 0 : Promise.reject(error),
        );
        if (size === 0 || size + Buffer.byteLength(line) <= this.#maxBytes) break;
        index += 1;
      }
      await appendFile(path, line, { encoding: "utf8", mode: 0o600 });
      await chmod(path, 0o600);
    });
    this.#queue = write.catch(() => {});
    return write;
  }
}
