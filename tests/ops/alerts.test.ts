import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { createAlertSink } from "../../src/ops/alerts.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

describe("alert sink", () => {
  it("uses a private redacted local fallback when NTFY_TOPIC is absent", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-alert-"));
    directories.push(directory);
    const path = join(directory, "alerts.jsonl");
    const sink = createAlertSink({ fallbackPath: path });

    await sink.send({
      severity: "error",
      title: "Collection blocked",
      message: "request failed",
      details: { OPENAI_API_KEY: "never-log-this", category: "http-403" },
    });

    const text = await readFile(path, "utf8");
    expect(text).not.toContain("never-log-this");
    expect(JSON.parse(text)).toMatchObject({ details: { OPENAI_API_KEY: "[REDACTED]" } });
  });

  it("posts only to a validated ntfy topic", async () => {
    const requests: Array<{ url: string; init?: RequestInit }> = [];
    const sink = createAlertSink({
      ntfyTopic: "precos_ops_2026",
      fetch: async (input, init) => {
        requests.push({ url: String(input), ...(init === undefined ? {} : { init }) });
        return new Response("ok", { status: 200 });
      },
    });

    await sink.send({ severity: "warning", title: "Drift", message: "score low" });

    expect(requests).toHaveLength(1);
    expect(requests[0]?.url).toBe("https://ntfy.sh/precos_ops_2026");
    expect(requests[0]?.init?.method).toBe("POST");
  });
});
