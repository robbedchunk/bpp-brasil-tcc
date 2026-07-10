import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, openSync } from "node:fs";
import { link, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

import Database from "better-sqlite3";

type ProcessIdentityReader = (pid: number) => Promise<string | null> | string | null;

export interface ProcessLockOptions {
  pid?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: ProcessIdentityReader;
  staleAfterMs?: number;
}

export class ProcessLockError extends Error {
  constructor(path: string) {
    super(`Process lock is already held: ${path}`);
    this.name = "ProcessLockError";
  }
}

interface LegacyLockRecord {
  pid: number;
  startedAt: string;
  token: string;
  version?: undefined;
}

interface LockRecordV2 {
  version: 2;
  pid: number;
  processIdentity: string;
  startedAt: string;
  token: string;
}

type LockRecord = LegacyLockRecord | LockRecordV2;

const DEFAULT_LEGACY_STALE_AFTER_MS = 24 * 60 * 60 * 1_000;

class LockConflict extends Error {
  constructor(readonly observedText: string) {
    super("Lock path already exists");
  }
}

function isSqliteContention(error: unknown): boolean {
  return error instanceof Error
    && "code" in error
    && (error.code === "SQLITE_BUSY" || error.code === "SQLITE_LOCKED");
}

async function withAcquisitionLease<T>(
  lockPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const leasePath = `${lockPath}.acquire-lease.sqlite`;
  const descriptor = openSync(leasePath, "a", 0o600);
  closeSync(descriptor);
  chmodSync(leasePath, 0o600);

  const lease = new Database(leasePath, { timeout: 0 });
  let acquired = false;
  try {
    lease.pragma("busy_timeout = 0");
    try {
      // SQLite's write lease is atomic across processes and is released by the
      // kernel if this process exits, so stale-lock recovery has one contender.
      lease.exec("BEGIN IMMEDIATE");
      acquired = true;
    } catch (error) {
      if (isSqliteContention(error)) throw new ProcessLockError(lockPath);
      throw error;
    }

    try {
      return await operation();
    } finally {
      lease.exec("ROLLBACK");
      acquired = false;
    }
  } finally {
    if (acquired) {
      try {
        lease.exec("ROLLBACK");
      } catch {
        // Closing the connection below is the final lease release guarantee.
      }
    }
    lease.close();
  }
}

function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return !(error instanceof Error && "code" in error && error.code === "ESRCH");
  }
}

async function readLinuxProcessIdentity(pid: number): Promise<string | null> {
  try {
    const [bootId, stat] = await Promise.all([
      readFile("/proc/sys/kernel/random/boot_id", "utf8"),
      readFile(`/proc/${pid}/stat`, "utf8"),
    ]);
    const commandEnd = stat.lastIndexOf(")");
    if (commandEnd < 0) throw new Error(`Malformed /proc/${pid}/stat`);
    const fieldsAfterCommand = stat.slice(commandEnd + 1).trim().split(/\s+/u);
    const startTicks = fieldsAfterCommand[19];
    if (startTicks === undefined || !/^\d+$/u.test(startTicks)) {
      throw new Error(`Missing process start time in /proc/${pid}/stat`);
    }
    return `${bootId.trim()}:${startTicks}`;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function parseLockRecord(text: string): LockRecord | null {
  try {
    const value = JSON.parse(text) as Partial<LockRecordV2>;
    const commonFieldsAreValid = Number.isSafeInteger(value.pid) && Number(value.pid) > 0
      && typeof value.startedAt === "string" && Number.isFinite(Date.parse(value.startedAt))
      && typeof value.token === "string" && value.token.length > 0;
    if (!commonFieldsAreValid) return null;
    if (value.version === undefined) return value as unknown as LegacyLockRecord;
    return value.version === 2
      && typeof value.processIdentity === "string" && value.processIdentity.length > 0
      ? value as LockRecordV2
      : null;
  } catch {
    return null;
  }
}

async function recordIsActive(
  record: LockRecord,
  getProcessIdentity: ProcessIdentityReader,
  isProcessAlive: (pid: number) => boolean,
  nowMs: number,
  staleAfterMs: number,
): Promise<boolean> {
  if (record.version === 2) {
    const identity = await getProcessIdentity(record.pid);
    if (identity !== null) return identity === record.processIdentity;
  }
  const age = Math.max(0, nowMs - Date.parse(record.startedAt));
  return isProcessAlive(record.pid) && age < staleAfterMs;
}

async function malformedLockIsFresh(
  path: string,
  nowMs: number,
  staleAfterMs: number,
): Promise<boolean> {
  try {
    const metadata = await stat(path);
    return Math.max(0, nowMs - metadata.mtimeMs) < staleAfterMs;
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
    throw error;
  }
}

async function moveObservedStaleLock(path: string, observedText: string): Promise<void> {
  const stalePath = `${path}.stale-${randomUUID()}`;
  try {
    await rename(path, stalePath);
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
    throw error;
  }

  const movedText = await readFile(stalePath, "utf8").catch(() => null);
  if (movedText !== observedText) {
    try {
      await link(stalePath, path);
    } catch (error) {
      if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
    }
    await unlink(stalePath).catch(() => {});
    throw new ProcessLockError(path);
  }
  await unlink(stalePath);
}

async function publishLock(path: string, serializedRecord: string): Promise<void> {
  const candidatePath = join(dirname(path), `.${basename(path)}.candidate-${randomUUID()}`);
  const handle = await open(candidatePath, "wx", 0o600);
  try {
    try {
      await handle.writeFile(serializedRecord, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
    while (true) {
      try {
        await link(candidatePath, path);
        return;
      } catch (error) {
        if (!(error instanceof Error && "code" in error && error.code === "EEXIST")) throw error;
      }

      const observedText = await readFile(path, "utf8").catch(
        (error: NodeJS.ErrnoException) => error.code === "ENOENT" ? null : Promise.reject(error),
      );
      if (observedText === null) continue;
      throw new LockConflict(observedText);
    }
  } finally {
    await unlink(candidatePath).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "ENOENT") throw error;
    });
  }
}

async function acquireLock(
  path: string,
  serializedRecord: string,
  getProcessIdentity: ProcessIdentityReader,
  isProcessAlive: (pid: number) => boolean,
  nowMs: number,
  staleAfterMs: number,
): Promise<void> {
  while (true) {
    try {
      await publishLock(path, serializedRecord);
      return;
    } catch (error) {
      if (!(error instanceof LockConflict)) throw error;
      const observedText = error.observedText;
      const observed = parseLockRecord(observedText);
      if (observed !== null
        && await recordIsActive(
          observed,
          getProcessIdentity,
          isProcessAlive,
          nowMs,
          staleAfterMs,
        )) {
        throw new ProcessLockError(path);
      }
      if (observed === null && await malformedLockIsFresh(path, nowMs, staleAfterMs)) {
        throw new ProcessLockError(path);
      }
      await moveObservedStaleLock(path, observedText);
    }
  }
}

export async function withProcessLock<T>(
  path: string,
  operation: () => Promise<T>,
  options: ProcessLockOptions = {},
): Promise<T> {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const pid = options.pid ?? process.pid;
  const getProcessIdentity = options.getProcessIdentity ?? readLinuxProcessIdentity;
  const processIdentity = await getProcessIdentity(pid);
  if (processIdentity === null && options.pid === undefined) {
    throw new Error(`Cannot determine process identity for PID ${pid}`);
  }
  const token = randomUUID();
  const acquiredAt = (options.now ?? (() => new Date()))();
  const staleAfterMs = options.staleAfterMs ?? DEFAULT_LEGACY_STALE_AFTER_MS;
  if (!Number.isSafeInteger(staleAfterMs) || staleAfterMs <= 0) {
    throw new RangeError("staleAfterMs must be a positive safe integer");
  }
  const commonRecord = {
    pid,
    startedAt: acquiredAt.toISOString(),
    token,
  };
  const record: LockRecord = processIdentity === null
    ? commonRecord
    : { version: 2, processIdentity, ...commonRecord };
  await withAcquisitionLease(path, async () => acquireLock(
    path,
    `${JSON.stringify(record)}\n`,
    getProcessIdentity,
    options.isProcessAlive ?? processIsAlive,
    acquiredAt.getTime(),
    staleAfterMs,
  ));
  try {
    return await operation();
  } finally {
    const ownsLock = await readFile(path, "utf8")
      .then((text) => parseLockRecord(text)?.token === token)
      .catch(() => false);
    if (ownsLock) {
      await unlink(path).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
      });
    }
  }
}
