import { mkdtemp, readFile, rm, stat, utimes, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { withProcessLock } from "../../src/ops/lock.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((path) =>
  rm(path, { recursive: true, force: true }))));

describe("process lock", () => {
  it("excludes a second owner and removes only its own lock", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });

    const first = withProcessLock(path, async () => {
      entered();
      await blocked;
      return "done";
    }, {
      pid: process.pid,
      now: () => new Date("2026-07-10T12:00:00.000Z"),
      getProcessIdentity: async () => "boot-a:10",
    });
    await didEnter;

    await expect(withProcessLock(path, async () => "second", {
      pid: 456,
      getProcessIdentity: async (pid) => pid === process.pid ? "boot-a:10" : "boot-a:20",
    }))
      .rejects.toThrow(/already held/i);
    expect((await stat(path)).isFile()).toBe(true);
    release();
    await expect(first).resolves.toBe("done");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("atomically recovers a lock whose recorded process no longer exists", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-stale-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    await writeFile(path, JSON.stringify({
      pid: 999_999,
      startedAt: "2026-07-09T12:00:00.000Z",
      token: "dead-owner",
    }));

    await expect(withProcessLock(path, async () => "recovered", {
      pid: 123,
      isProcessAlive: () => false,
      getProcessIdentity: async () => "boot-a:50",
    })).resolves.toBe("recovered");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("publishes a complete identity and recovers a reused PID", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-reused-pid-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    let entered!: () => void;
    const didEnter = new Promise<void>((resolve) => { entered = resolve; });

    const first = withProcessLock(path, async () => {
      entered();
      await blocked;
    }, {
      pid: 4_321,
      getProcessIdentity: async () => "boot-a:100",
    });
    await didEnter;

    expect(JSON.parse(await readFile(path, "utf8"))).toMatchObject({
      version: 2,
      pid: 4_321,
      processIdentity: "boot-a:100",
    });
    await expect(withProcessLock(path, async () => "new-owner", {
      pid: 7_654,
      getProcessIdentity: async (pid) => pid === 4_321 ? "boot-a:200" : "boot-a:300",
    })).resolves.toBe("new-owner");

    release();
    await first;
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers an incomplete legacy lock record", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-malformed-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    await writeFile(path, '{"pid":', { mode: 0o600 });
    await utimes(
      path,
      new Date("2026-07-08T00:00:00.000Z"),
      new Date("2026-07-08T00:00:00.000Z"),
    );

    await expect(withProcessLock(path, async () => "recovered", {
      pid: 123,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      getProcessIdentity: async () => "boot-a:400",
    })).resolves.toBe("recovered");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses age as a safe fallback for a legacy lock whose PID was reused", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-aged-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    await writeFile(path, JSON.stringify({
      pid: 321,
      startedAt: "2026-07-08T00:00:00.000Z",
      token: "legacy-owner-without-start-identity",
    }));

    await expect(withProcessLock(path, async () => "recovered", {
      pid: 654,
      now: () => new Date("2026-07-10T00:00:00.000Z"),
      isProcessAlive: () => true,
      getProcessIdentity: async () => "boot-a:500",
    })).resolves.toBe("recovered");
  });

  it("does not recover a fresh malformed legacy lock during its write window", async () => {
    const directory = await mkdtemp(join(tmpdir(), "precos-fresh-malformed-lock-"));
    directories.push(directory);
    const path = join(directory, "daily.lock");
    await writeFile(path, "", { mode: 0o600 });

    await expect(withProcessLock(path, async () => "unsafe", {
      pid: 654,
      getProcessIdentity: async () => "boot-a:600",
    })).rejects.toThrow(/already held/i);
  });
});
