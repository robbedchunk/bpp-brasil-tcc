import { mkdtemp, readFile, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { JsonlLogger, redact } from "../../src/ops/logger.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

describe("operations logger", () => {
  it("recursively redacts secret-shaped keys", () => {
    expect(redact({
      OPENAI_API_KEY: "secret",
      NTFY_TOPIC: "private-topic",
      url: "ok",
      nested: { authorization: "Bearer value", list: [{ password: "pw" }] },
    })).toEqual({
      OPENAI_API_KEY: "[REDACTED]",
      NTFY_TOPIC: "[REDACTED]",
      url: "ok",
      nested: { authorization: "[REDACTED]", list: [{ password: "[REDACTED]" }] },
    });
  });

  it("sanitizes secrets embedded in arbitrary strings and errors", () => {
    const originalApiKey = process.env.OPENAI_API_KEY;
    process.env.OPENAI_API_KEY = "env-secret-value-123";
    try {
      const serialized = JSON.stringify(redact({
        note: "Authorization: Bearer bearer-secret-456",
        endpoint: "https://user:password@example.test/path?api_key=query-secret-789",
        arbitrary: "prefix env-secret-value-123 suffix",
        error: new Error("token=error-secret-012"),
        structured: '{"session_token":"json-secret-345","cookie":"sid=json-cookie-678"}',
        html: '<meta name="csrf-token" content="html-secret-901"><div data-session-token="attribute-secret-234">',
      }));

      for (const secret of [
        "bearer-secret-456",
        "password",
        "query-secret-789",
        "env-secret-value-123",
        "error-secret-012",
        "json-secret-345",
        "json-cookie-678",
        "html-secret-901",
        "attribute-secret-234",
      ]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain("[REDACTED]");
    } finally {
      if (originalApiKey === undefined) delete process.env.OPENAI_API_KEY;
      else process.env.OPENAI_API_KEY = originalApiKey;
    }
  });

  it("writes private JSONL records without secret values", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-log-"));
    directories.push(directory);
    const logger = new JsonlLogger({
      directory,
      basename: "ops",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      maxBytes: 10_000,
    });

    await logger.info("started", { token: "do-not-write", retailer: "pa" });

    const path = join(directory, "ops-2026-07-10.jsonl");
    const text = await readFile(path, "utf8");
    expect(JSON.parse(text)).toMatchObject({
      level: "info",
      event: "started",
      fields: { token: "[REDACTED]", retailer: "pa" },
    });
    expect(text).not.toContain("do-not-write");
    expect((await stat(path)).mode & 0o777).toBe(0o600);
  });

  it("sanitizes a secret embedded in the event string", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-log-event-"));
    directories.push(directory);
    const logger = new JsonlLogger({
      directory,
      basename: "ops",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
    });

    await logger.warning("Authorization: Bearer event-secret-123");

    const text = await readFile(join(directory, "ops-2026-07-10.jsonl"), "utf8");
    expect(text).not.toContain("event-secret-123");
    expect(text).toContain("[REDACTED]");
  });

  it("rotates filenames on the São Paulo calendar day", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-log-day-"));
    directories.push(directory);
    const logger = new JsonlLogger({
      directory,
      basename: "ops",
      now: () => new Date("2026-07-10T02:00:00.000Z"),
    });

    await logger.info("before-midnight-local");

    await expect(readFile(join(directory, "ops-2026-07-09.jsonl"), "utf8"))
      .resolves.toContain("before-midnight-local");
  });

  it("rotates bounded private JSONL files by size", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-log-size-"));
    directories.push(directory);
    const logger = new JsonlLogger({
      directory,
      basename: "run-immutable",
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      maxBytes: 150,
    });

    await logger.info("attempt", { value: "a".repeat(80) });
    await logger.info("attempt", { value: "b".repeat(80) });
    await logger.info("attempt", { value: "c".repeat(80) });

    const files = (await readdir(directory)).sort();
    expect(files).toEqual([
      "run-immutable-2026-07-10.1.jsonl",
      "run-immutable-2026-07-10.2.jsonl",
      "run-immutable-2026-07-10.jsonl",
    ]);
    for (const file of files) {
      expect((await stat(join(directory, file))).mode & 0o777).toBe(0o600);
    }
  });

  it("rejects path-like basenames", () => {
    expect(() => new JsonlLogger({ directory: "/tmp", basename: "../escape" }))
      .toThrow(/path-safe/iu);
  });
});
