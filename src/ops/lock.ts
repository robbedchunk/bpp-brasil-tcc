import { randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { dirname } from "node:path";

export interface ProcessLockOptions {
  pid?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
}

export class ProcessLockError extends Error {
  constructor(path: string) {
    super(`Process lock is already held: ${path}`);
    this.name = "ProcessLockError";
  }
}

interface LockRecord {
  pid: number;
  startedAt: string;
  token: string;
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

function parseLockRecord(text: string): LockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<LockRecord>;
    return Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt))
      && typeof value.token === "string" && value.token.length > 0
      ? value as LockRecord
      : null;
  } catch {
    return null;
  }
}

async function acquireLock(
  path: string,
  isProcessAlive: (pid: number) => boolean,
): ReturnType<typeof open> {
  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) {
      throw error;
    }
  }

  const observedText = await readFile(path, "utf8").catch(() => null);
  const observed = observedText === null ? null : parseLockRecord(observedText);
  if (observed === null || isProcessAlive(observed.pid)) {
    throw new ProcessLockError(path);
  }

  const stalePath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const movedText = await readFile(stalePath, "utf8").catch(() => null);
  if (movedText !== null && movedText !== observedText) {
    await rename(stalePath, path).catch(() => {});
    throw new ProcessLockError(path);
  }
  await unlink(stalePath).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
  });

  try {
    return await open(path, "wx", 0o600);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ProcessLockError(path);
    }
    throw error;
  }
}

export async function withProcessLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: ProcessLockOptions = {},
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const token = randomUUID();
  const handle = await acquireLock(
    path,
    options.isProcessAlive ?? processIsAlive,
  );
  try {
    await handle.writeFile(`${JSON.stringify({
      pid: options.pid ?? process.pid,
      startedAt: (options.now ?? (() => new Date()))().toISOString(),
      token,
    })}\n`, "utf8");
    await handle.sync();
    return await operation();
  } finally {
    await handle.close();
    const ownsLock = await readFile(path, "utf8")
      .then((text) => (JSON.parse(text) as { token?: string }).token === token)
      .catch(() => false);
    if (ownsLock) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
