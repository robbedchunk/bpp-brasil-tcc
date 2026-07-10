import { mkdtemp, rm, stat, writeFile } from "node:fs/promises";
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
    }, { pid: process.pid, now: () => new Date("2026-07-10T12:00:00.000Z") });
    await didEnter;

    await expect(withProcessLock(path, async () => "second", { pid: 456 }))
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
    })).resolves.toBe("recovered");
    await expect(stat(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
