import { createHash } from "node:crypto";
import { appendFile, chmod, mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { redact } from "./logger.js";

export interface AlertEvent {
  severity: "info" | "warning" | "error";
  title: string;
  message: string;
  details?: unknown;
}

export interface AlertSink {
  send(event: AlertEvent): Promise<void>;
}

export interface AlertSinkOptions {
  ntfyTopic?: string;
  fallbackPath?: string;
  fetch?: typeof globalThis.fetch;
  now?: () => Date;
}

export interface AlertDeliveryReceipt {
  channel: "ntfy" | "local" | "local-after-ntfy-failure";
  accepted: boolean;
  httpStatus: number | null;
  fallbackFileMode: "0600" | null;
  appendedLineSha256: string | null;
}

function ntfyUrl(topic: string | undefined): string | null {
  const candidate = topic?.trim();
  if (candidate === undefined || candidate.length === 0) return null;
  if (/^[A-Za-z0-9_-]{3,64}$/u.test(candidate)) {
    return `https://ntfy.sh/${candidate}`;
  }
  try {
    const url = new URL(candidate);
    if (
      url.protocol === "https:" &&
      url.hostname === "ntfy.sh" &&
      url.username === "" &&
      url.password === "" &&
      url.search === "" &&
      url.hash === "" &&
      /^\/[A-Za-z0-9_-]{3,64}$/u.test(url.pathname)
    ) {
      return url.toString();
    }
  } catch {
    // Invalid values deliberately fall back to local evidence.
  }
  return null;
}

async function appendFallback(
  path: string,
  event: AlertEvent,
  now: Date,
): Promise<{ fileMode: "0600"; lineSha256: string }> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sanitized = redact(event) as Record<string, unknown>;
  const line = `${JSON.stringify({ timestamp: now.toISOString(), ...sanitized })}\n`;
  await appendFile(
    path,
    line,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(path, 0o600);
  return {
    fileMode: "0600",
    lineSha256: createHash("sha256").update(line).digest("hex"),
  };
}

export async function sendAlertWithReceipt(
  options: AlertSinkOptions,
  event: AlertEvent,
): Promise<AlertDeliveryReceipt> {
  const url = ntfyUrl(options.ntfyTopic);
  const fallbackPath = resolve(options.fallbackPath ?? "var/log/alerts.jsonl");
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());
  const sanitized = redact(event) as AlertEvent;
  let attemptedNtfy = false;
  let httpStatus: number | null = null;

  if (url !== null) {
    attemptedNtfy = true;
    try {
      const response = await fetch(url, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "title": sanitized.title,
          "priority": sanitized.severity === "error" ? "high" : "default",
        },
        body: JSON.stringify({
          message: sanitized.message,
          severity: sanitized.severity,
          details: sanitized.details ?? {},
        }),
      });
      httpStatus = response.status;
      if (response.ok) {
        return {
          channel: "ntfy",
          accepted: true,
          httpStatus,
          fallbackFileMode: null,
          appendedLineSha256: null,
        };
      }
    } catch {
      // The delivery receipt records a local fallback without exposing transport details.
    }
  }

  const fallback = await appendFallback(fallbackPath, sanitized, now());
  return {
    channel: attemptedNtfy ? "local-after-ntfy-failure" : "local",
    accepted: true,
    httpStatus,
    fallbackFileMode: fallback.fileMode,
    appendedLineSha256: fallback.lineSha256,
  };
}

export function createAlertSink(options: AlertSinkOptions = {}): AlertSink {

  return {
    async send(event): Promise<void> {
      await sendAlertWithReceipt(options, event);
    },
  };
}
