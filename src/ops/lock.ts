import { randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

type ProcessIdentityReader = (pid: number) => Promise<string | null> | string | null;

export interface ProcessLockOptions {
  pid?: number;
  now?: () => Date;
  isProcessAlive?: (pid: number) => boolean;
  getProcessIdentity?: ProcessIdentityReader;
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

class LockConflict extends Error {
  constructor(readonly observedText: string) {
    super("Lock path already exists");
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
): Promise<boolean> {
  if (record.version === 2) {
    return await getProcessIdentity(record.pid) === record.processIdentity;
  }
  return isProcessAlive(record.pid);
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
        && await recordIsActive(observed, getProcessIdentity, isProcessAlive)) {
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
  const commonRecord = {
    pid,
    startedAt: (options.now ?? (() => new Date()))().toISOString(),
    token,
  };
  const record: LockRecord = processIdentity === null
    ? commonRecord
    : { version: 2, processIdentity, ...commonRecord };
  await acquireLock(
    path,
    `${JSON.stringify(record)}\n`,
    getProcessIdentity,
    options.isProcessAlive ?? processIsAlive,
  );
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
