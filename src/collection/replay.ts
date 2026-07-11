import { createHash, randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, mkdir, open, readFile, readdir, realpath, rename, unlink, writeFile } from "node:fs/promises";
import { dirname, join, resolve, sep } from "node:path";
import { gunzipSync, gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export interface ReplayArtifact {
  path: string;
  sha256: string;
}

export interface ReplayPayload {
  body: string;
  mediaType: "application/json" | "text/html" | "text/plain";
}

export interface VerifiedReplayPayload extends ReplayPayload {
  path: string;
  sha256: string;
}

export interface ReplayEvidenceRef {
  kind: "observation" | "failure";
  id: string;
}

interface StoredReplaySlot {
  file: string;
  sha256: string;
  evidence: ReplayEvidenceRef;
}

interface ReplayReservoirState {
  version: 2;
  collectionDay: string;
  population: number;
  slots: StoredReplaySlot[];
  finalizedAt?: string;
}

interface ReplayTransaction {
  version: 1;
  oldState: ReplayReservoirState;
  nextState: ReplayReservoirState;
  newFile: string;
  newPreexisted: boolean;
  evicted?: { file: string; gzipBase64: string };
}

export interface ReplayReservoirOptions {
  size?: number;
  random?: () => number;
  beforeStatePublish?: (state: ReplayReservoirState) => void | Promise<void>;
  cleanupFile?: (path: string) => Promise<void>;
  afterManifestPublish?: (path: string) => void | Promise<void>;
}

export interface DailyReplayReservoir {
  consider(html: string, evidence: ReplayEvidenceRef): Promise<void>;
}

const REPLAY_FILE = /^([a-f0-9]{64})\.html\.gz$/u;
const DAY_DIRECTORY = /^\d{4}-\d{2}-\d{2}$/u;
const STATE_FILE = ".reservoir.json";
const FINAL_MANIFEST = "replay-samples.json";
const TRANSACTION_FILE = ".reservoir-transaction.json";
const PRIVATE_REPLAY_PATH = new RegExp(
  String.raw`^(\d{4}-\d{2}-\d{2})\/([a-z0-9]+(?:-[a-z0-9]+)*)\/([a-f0-9]{64})\.(html|json|txt)\.gz$`,
  "u",
);
const MAX_REPLAY_BODY_BYTES = 2_000_000;

function validateEvidence(value: unknown): value is ReplayEvidenceRef {
  if (value === null || typeof value !== "object") return false;
  const candidate = value as Partial<ReplayEvidenceRef>;
  return (candidate.kind === "observation" || candidate.kind === "failure")
    && typeof candidate.id === "string"
    && candidate.id.length > 0;
}

function validateState(
  value: unknown,
  collectionDay: string,
  size: number,
): ReplayReservoirState {
  if (value === null || typeof value !== "object") {
    throw new Error("Replay reservoir state is not an object");
  }
  const candidate = value as Partial<ReplayReservoirState>;
  if (
    candidate.version !== 2
    || candidate.collectionDay !== collectionDay
    || !Number.isSafeInteger(candidate.population)
    || (candidate.population ?? -1) < 0
    || !Array.isArray(candidate.slots)
    || candidate.slots.length > size
    || candidate.slots.length > (candidate.population ?? -1)
    || (candidate.finalizedAt !== undefined
      && !Number.isFinite(Date.parse(candidate.finalizedAt)))
  ) {
    throw new Error("Replay reservoir state is invalid");
  }
  for (const slot of candidate.slots) {
    if (
      slot === null
      || typeof slot !== "object"
      || typeof slot.file !== "string"
      || typeof slot.sha256 !== "string"
      || slot.file !== `${slot.sha256}.html.gz`
      || !REPLAY_FILE.test(slot.file)
      || !validateEvidence(slot.evidence)
    ) {
      throw new Error("Replay reservoir slot is invalid");
    }
  }
  return candidate as ReplayReservoirState;
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await readFile(path);
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function publishJson(
  path: string,
  value: unknown,
  beforePublish?: () => void | Promise<void>,
): Promise<void> {
  const directory = dirname(path);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.replay-publish-${process.pid}-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await beforePublish?.();
    await rename(temporary, path);
    await chmod(path, 0o600);
  } catch (error) {
    try {
      await unlink(temporary);
    } catch {
      await writeFile(temporary, "", { mode: 0o600, flag: "w" });
    }
    throw error;
  }
}

async function retireSensitiveFile(
  path: string,
  cleanupFile: (path: string) => Promise<void>,
): Promise<void> {
  const retired = join(dirname(path), ".replay-discarded");
  try {
    await rename(path, retired);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  try {
    await cleanupFile(retired);
  } catch {
    await writeFile(retired, "", { mode: 0o600, flag: "w" });
    await chmod(retired, 0o600);
  }
}

async function loadState(
  directory: string,
  collectionDay: string,
  size: number,
): Promise<ReplayReservoirState> {
  try {
    return validateState(
      JSON.parse(await readFile(join(directory, STATE_FILE), "utf8")),
      collectionDay,
      size,
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  return { version: 2, collectionDay, population: 0, slots: [] };
}

async function saveState(
  directory: string,
  state: ReplayReservoirState,
  beforeStatePublish?: ReplayReservoirOptions["beforeStatePublish"],
): Promise<void> {
  await publishJson(
    join(directory, STATE_FILE),
    state,
    beforeStatePublish === undefined ? undefined : () => beforeStatePublish(state),
  );
}

async function restoreTransaction(
  directory: string,
  transaction: ReplayTransaction,
  cleanupFile: (path: string) => Promise<void>,
): Promise<void> {
  const newPath = join(directory, transaction.newFile);
  if (transaction.evicted === undefined) {
    if (!transaction.newPreexisted) await retireSensitiveFile(newPath, cleanupFile);
  } else {
    const oldPath = join(directory, transaction.evicted.file);
    if (!transaction.newPreexisted && transaction.newFile !== transaction.evicted.file) {
      try {
        await rename(newPath, oldPath);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      }
    }
    const restoration = join(directory, `.replay-restore-${randomUUID()}.tmp`);
    await writeFile(restoration, Buffer.from(transaction.evicted.gzipBase64, "base64"), {
      mode: 0o600,
      flag: "wx",
    });
    await rename(restoration, oldPath);
    await chmod(oldPath, 0o600);
  }
  await saveState(directory, transaction.oldState);
}

async function recoverTransaction(
  directory: string,
  collectionDay: string,
  size: number,
  cleanupFile: (path: string) => Promise<void>,
): Promise<void> {
  const path = join(directory, TRANSACTION_FILE);
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  let transaction: ReplayTransaction;
  try {
    transaction = JSON.parse(raw) as ReplayTransaction;
    if (transaction.version !== 1) throw new Error("Unsupported replay transaction");
    validateState(transaction.oldState, collectionDay, size);
    validateState(transaction.nextState, collectionDay, size);
  } catch {
    await retireSensitiveFile(path, cleanupFile);
    return;
  }
  const current = await loadState(directory, collectionDay, size);
  if (JSON.stringify(current) !== JSON.stringify(transaction.nextState)) {
    await restoreTransaction(directory, transaction, cleanupFile);
  }
  await retireSensitiveFile(path, cleanupFile);
}

async function finalizeEarlierDays(
  root: string,
  currentDay: string,
  retailerId: string,
  size: number,
  cleanupFile: (path: string) => Promise<void>,
  afterManifestPublish?: ReplayReservoirOptions["afterManifestPublish"],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !DAY_DIRECTORY.test(entry.name) || entry.name >= currentDay) {
      continue;
    }
    const directory = join(root, entry.name, retailerId);
    const source = join(directory, STATE_FILE);
    if (!(await fileExists(source))) continue;
    await recoverTransaction(directory, entry.name, size, cleanupFile);
    const state = await loadState(directory, entry.name, size);
    const destination = join(directory, FINAL_MANIFEST);
    if (await fileExists(destination)) {
      const published = validateState(
        JSON.parse(await readFile(destination, "utf8")),
        entry.name,
        size,
      );
      const comparable = ({ finalizedAt: _ignored, ...value }: ReplayReservoirState) => value;
      if (
        published.finalizedAt === undefined
        || JSON.stringify(comparable(published)) !== JSON.stringify(comparable(state))
      ) {
        throw new Error(`Final replay manifest already differs for ${entry.name}/${retailerId}`);
      }
      await unlink(source);
      continue;
    }

    const finalized: ReplayReservoirState = state.finalizedAt === undefined
      ? { ...state, finalizedAt: `${currentDay}T00:00:00.000-03:00` }
      : state;
    if (state.finalizedAt === undefined) await saveState(directory, finalized);
    try {
      await link(source, destination);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      const published = validateState(
        JSON.parse(await readFile(destination, "utf8")),
        entry.name,
        size,
      );
      if (JSON.stringify(published) !== JSON.stringify(finalized)) {
        throw new Error(`Final replay manifest already differs for ${entry.name}/${retailerId}`);
      }
    }
    await afterManifestPublish?.(destination);
    await unlink(source);
  }
}

export async function openDailyReplayReservoir(
  root: string,
  collectionDay: string,
  retailerId: string,
  options: ReplayReservoirOptions = {},
): Promise<DailyReplayReservoir> {
  const size = options.size ?? 20;
  const random = options.random ?? Math.random;
  const cleanupFile = options.cleanupFile ?? unlink;
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("Reservoir size must be a non-negative safe integer");
  }
  await finalizeEarlierDays(
    root,
    collectionDay,
    retailerId,
    size,
    cleanupFile,
    options.afterManifestPublish,
  );
  const directory = join(root, collectionDay, retailerId);
  await recoverTransaction(directory, collectionDay, size, cleanupFile);
  let state = await loadState(directory, collectionDay, size);
  if (state.finalizedAt !== undefined) {
    throw new Error(`Replay reservoir for ${collectionDay} is already finalized`);
  }
  let queue = Promise.resolve();

  return {
    consider(html: string, evidence: ReplayEvidenceRef): Promise<void> {
      if (!validateEvidence(evidence)) {
        return Promise.reject(new Error("Replay evidence reference is invalid"));
      }
      const operation = queue.then(async () => {
        const population = state.population + 1;
        const slotIndex = state.slots.length < size
          ? state.slots.length
          : Math.floor(random() * population);
        if (slotIndex >= size) {
          const nextState = { ...state, population };
          await saveState(directory, nextState, options.beforeStatePublish);
          state = nextState;
          return;
        }

        const gzipBytes = await gzipAsync(Buffer.from(html));
        const sha256 = createHash("sha256").update(html).digest("hex");
        const newFile = `${sha256}.html.gz`;
        const nextSlots = [...state.slots];
        const evicted = nextSlots[slotIndex];
        nextSlots[slotIndex] = { file: newFile, sha256, evidence: { ...evidence } };
        const nextState: ReplayReservoirState = {
          version: 2,
          collectionDay,
          population,
          slots: nextSlots,
        };
        const newPath = join(directory, newFile);
        const newPreexisted = await fileExists(newPath);
        const evictedDisappears = evicted !== undefined
          && evicted.file !== newFile
          && !nextSlots.some((slot) => slot.file === evicted.file);
        const transaction: ReplayTransaction = {
          version: 1,
          oldState: state,
          nextState,
          newFile,
          newPreexisted,
          ...(evictedDisappears
            ? {
                evicted: {
                  file: evicted.file,
                  gzipBase64: (await readFile(join(directory, evicted.file))).toString("base64"),
                },
              }
            : {}),
        };
        await mkdir(directory, { recursive: true, mode: 0o700 });
        await publishJson(join(directory, TRANSACTION_FILE), transaction);
        const temporary = join(directory, `.replay-content-${randomUUID()}.tmp`);
        try {
          if (!newPreexisted || evictedDisappears) {
            await writeFile(temporary, gzipBytes, { mode: 0o600, flag: "wx" });
            await chmod(temporary, 0o600);
            if (evictedDisappears && evicted !== undefined) {
              const oldPath = join(directory, evicted.file);
              await rename(temporary, oldPath);
              await rename(oldPath, newPath);
            } else {
              await rename(temporary, newPath);
            }
            await chmod(newPath, 0o600);
          }
          await saveState(directory, nextState, options.beforeStatePublish);
          state = nextState;
          await retireSensitiveFile(join(directory, TRANSACTION_FILE), cleanupFile);
        } catch (error) {
          await retireSensitiveFile(temporary, cleanupFile);
          await restoreTransaction(directory, transaction, cleanupFile);
          state = transaction.oldState;
          await retireSensitiveFile(join(directory, TRANSACTION_FILE), cleanupFile);
          throw error;
        }
      });
      queue = operation.then(() => undefined, () => undefined);
      return operation;
    },
  };
}

export function reservoirSample<T>(
  values: Iterable<T>,
  size: number,
  random: () => number = Math.random,
): T[] {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("Reservoir size must be a non-negative safe integer");
  }
  const reservoir: T[] = [];
  let seen = 0;
  for (const value of values) {
    seen += 1;
    if (reservoir.length < size) {
      reservoir.push(value);
      continue;
    }
    const replacement = Math.floor(random() * seen);
    if (replacement < size) reservoir[replacement] = value;
  }
  return reservoir;
}

function replayExtension(mediaType: ReplayPayload["mediaType"]): "html" | "json" | "txt" {
  if (mediaType === "text/html") return "html";
  if (mediaType === "application/json") return "json";
  return "txt";
}

function mediaTypeForExtension(extension: string): ReplayPayload["mediaType"] {
  if (extension === "html") return "text/html";
  if (extension === "json") return "application/json";
  return "text/plain";
}

export async function writeReplayPayload(
  payload: ReplayPayload,
  root: string,
  collectionDay: string,
  retailerId: string,
): Promise<VerifiedReplayPayload> {
  if (!DAY_DIRECTORY.test(collectionDay) || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/u.test(retailerId)) {
    throw new Error("Replay day or retailer identifier is invalid");
  }
  const bodyBytes = Buffer.from(payload.body, "utf8");
  if (bodyBytes.byteLength > MAX_REPLAY_BODY_BYTES) {
    throw new Error(`Replay body exceeds ${MAX_REPLAY_BODY_BYTES} bytes`);
  }
  const sha256 = createHash("sha256").update(bodyBytes).digest("hex");
  const file = `${sha256}.${replayExtension(payload.mediaType)}.gz`;
  const directory = join(root, collectionDay, retailerId);
  const path = join(directory, file);
  const logicalPath = `${collectionDay}/${retailerId}/${file}`;
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await chmod(directory, 0o700);
  const compressed = await gzipAsync(bodyBytes);
  const temporary = join(directory, `.replay-content-${sha256}-${randomUUID()}.tmp`);
  let temporaryHandle: Awaited<ReturnType<typeof open>> | undefined;
  try {
    temporaryHandle = await open(
      temporary,
      constants.O_CREAT | constants.O_EXCL | constants.O_WRONLY | constants.O_NOFOLLOW,
      0o600,
    );
    try {
      await temporaryHandle.writeFile(compressed);
      await temporaryHandle.chmod(0o600);
      await temporaryHandle.sync();
    } finally {
      await temporaryHandle.close();
      temporaryHandle = undefined;
    }

    let published = false;
    try {
      await link(temporary, path);
      published = true;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    if (!published) {
      try {
        await readReplayPayload(root, { path: logicalPath, sha256 });
      } catch {
        // Repair a legacy/crash-truncated winner without ever streaming into
        // the final name. Concurrent repairers publish identical hash-bound
        // content, so moving either winner aside remains safe.
        const quarantine = join(
          directory,
          `.replay-corrupt-${sha256}-${randomUUID()}.tmp`,
        );
        try {
          await rename(path, quarantine);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        try {
          await link(temporary, path);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
        } finally {
          await unlink(quarantine).catch(() => undefined);
        }
      }
    }
    await readReplayPayload(root, { path: logicalPath, sha256 });
    const existing = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      await existing.chmod(0o600);
    } finally {
      await existing.close();
    }
    const directoryHandle = await open(directory, constants.O_RDONLY);
    try {
      await directoryHandle.sync();
    } finally {
      await directoryHandle.close();
    }
  } finally {
    if (temporaryHandle !== undefined) await temporaryHandle.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
  return { ...payload, path: logicalPath, sha256 };
}

export async function readReplayPayload(
  root: string,
  reference: ReplayArtifact,
  maxBodyBytes = MAX_REPLAY_BODY_BYTES,
): Promise<VerifiedReplayPayload> {
  if (!Number.isSafeInteger(maxBodyBytes) || maxBodyBytes <= 0) {
    throw new RangeError("Replay read limit must be a positive safe integer");
  }
  const match = PRIVATE_REPLAY_PATH.exec(reference.path);
  if (match === null || match[3] !== reference.sha256) {
    throw new Error("Replay reference is not a valid content-addressed private path");
  }
  const absoluteRoot = resolve(root);
  const absolutePath = resolve(absoluteRoot, reference.path);
  if (!absolutePath.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error("Replay reference escapes its private root");
  }
  const [realRoot, realParent] = await Promise.all([
    realpath(absoluteRoot),
    realpath(dirname(absolutePath)),
  ]);
  if (realParent !== realRoot && !realParent.startsWith(`${realRoot}${sep}`)) {
    throw new Error("Replay reference escapes its private root through a symlink");
  }
  const handle = await open(absolutePath, constants.O_RDONLY | constants.O_NOFOLLOW);
  let compressed: Buffer;
  try {
    const metadata = await handle.stat();
    const maxCompressedBytes = maxBodyBytes + Math.ceil(maxBodyBytes / 1_000) + 65_536;
    if (!metadata.isFile() || metadata.size > maxCompressedBytes) {
      throw new Error("Replay artifact is not a bounded regular file");
    }
    compressed = await handle.readFile();
  } finally {
    await handle.close();
  }
  const bytes = gunzipSync(compressed, { maxOutputLength: maxBodyBytes });
  const actual = createHash("sha256").update(bytes).digest("hex");
  if (actual !== reference.sha256) {
    throw new Error("Replay artifact SHA-256 verification failed");
  }
  return {
    body: bytes.toString("utf8"),
    mediaType: mediaTypeForExtension(match[4] ?? "txt"),
    path: reference.path,
    sha256: reference.sha256,
  };
}

export async function writeReplayHtml(
  html: string,
  root: string,
  collectionDay: string,
  retailerId: string,
): Promise<ReplayArtifact> {
  const sha256 = createHash("sha256").update(html).digest("hex");
  const directory = join(root, collectionDay, retailerId);
  const path = join(directory, `${sha256}.html.gz`);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await writeFile(path, await gzipAsync(Buffer.from(html)), { mode: 0o600, flag: "wx" })
    .catch((error: NodeJS.ErrnoException) => {
      if (error.code !== "EEXIST") throw error;
    });
  await chmod(path, 0o600);
  return { path, sha256 };
}
