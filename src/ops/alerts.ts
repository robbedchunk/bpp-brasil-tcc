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
): Promise<void> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const sanitized = redact(event) as Record<string, unknown>;
  await appendFile(
    path,
    `${JSON.stringify({ timestamp: now.toISOString(), ...sanitized })}\n`,
    { encoding: "utf8", mode: 0o600 },
  );
  await chmod(path, 0o600);
}

export function createAlertSink(options: AlertSinkOptions = {}): AlertSink {
  const url = ntfyUrl(options.ntfyTopic);
  const fallbackPath = resolve(options.fallbackPath ?? "var/log/alerts.jsonl");
  const fetch = options.fetch ?? globalThis.fetch;
  const now = options.now ?? (() => new Date());

  return {
    async send(event): Promise<void> {
      const sanitized = redact(event) as AlertEvent;
      if (url !== null) {
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
          if (response.ok) return;
        } catch {
          // Network alert failures are retained by the private local fallback.
        }
      }
      await appendFallback(fallbackPath, sanitized, now());
    },
  };
}
