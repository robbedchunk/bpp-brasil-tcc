import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, readdir, rename, unlink, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export interface ReplayArtifact {
  path: string;
  sha256: string;
}

interface StoredReplaySlot {
  file: string;
  sha256: string;
}

interface ReplayReservoirState {
  version: 1;
  population: number;
  slots: StoredReplaySlot[];
}

export interface DailyReplayReservoir {
  consider(html: string): Promise<ReplayArtifact | undefined>;
}

const REPLAY_FILE = /^([a-f0-9]{64})\.html\.gz$/u;
const STATE_FILE = ".reservoir.json";

function validateState(value: unknown, size: number): ReplayReservoirState {
  if (value === null || typeof value !== "object") {
    throw new Error("Replay reservoir state is not an object");
  }
  const candidate = value as Partial<ReplayReservoirState>;
  if (
    candidate.version !== 1
    || !Number.isSafeInteger(candidate.population)
    || (candidate.population ?? -1) < 0
    || !Array.isArray(candidate.slots)
    || candidate.slots.length > size
    || candidate.slots.length > (candidate.population ?? -1)
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
    ) {
      throw new Error("Replay reservoir slot is invalid");
    }
  }
  return candidate as ReplayReservoirState;
}

async function existingReplayFiles(directory: string): Promise<StoredReplaySlot[]> {
  let names: string[];
  try {
    names = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  return names.flatMap((file) => {
    const match = REPLAY_FILE.exec(file);
    const sha256 = match?.[1];
    return sha256 === undefined ? [] : [{ file, sha256 }];
  }).sort((left, right) => left.file.localeCompare(right.file));
}

async function loadState(directory: string, size: number): Promise<ReplayReservoirState> {
  try {
    return validateState(JSON.parse(await readFile(join(directory, STATE_FILE), "utf8")), size);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const slots = await existingReplayFiles(directory);
  if (slots.length > size) {
    throw new Error(`Legacy replay directory contains more than ${size} samples`);
  }
  return { version: 1, population: slots.length, slots };
}

async function saveState(directory: string, state: ReplayReservoirState): Promise<void> {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const temporary = join(directory, `.reservoir.${process.pid}.${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
    await chmod(temporary, 0o600);
    await rename(temporary, join(directory, STATE_FILE));
    await chmod(join(directory, STATE_FILE), 0o600);
  } catch (error) {
    await unlink(temporary).catch(() => undefined);
    throw error;
  }
}

export async function openDailyReplayReservoir(
  root: string,
  collectionDay: string,
  retailerId: string,
  size = 20,
  random: () => number = Math.random,
): Promise<DailyReplayReservoir> {
  if (!Number.isSafeInteger(size) || size < 0) {
    throw new RangeError("Reservoir size must be a non-negative safe integer");
  }
  const directory = join(root, collectionDay, retailerId);
  let state = await loadState(directory, size);
  let queue = Promise.resolve();

  return {
    consider(html: string): Promise<ReplayArtifact | undefined> {
      const operation = queue.then(async () => {
        const population = state.population + 1;
        const slotIndex = state.slots.length < size
          ? state.slots.length
          : Math.floor(random() * population);
        if (slotIndex >= size) {
          state = { ...state, population };
          await saveState(directory, state);
          return undefined;
        }

        const artifact = await writeReplayHtml(html, root, collectionDay, retailerId);
        const nextSlot = {
          file: `${artifact.sha256}.html.gz`,
          sha256: artifact.sha256,
        };
        const previousSlots = state.slots;
        const evicted = previousSlots[slotIndex];
        const slots = [...previousSlots];
        slots[slotIndex] = nextSlot;
        const nextState: ReplayReservoirState = { version: 1, population, slots };
        try {
          await saveState(directory, nextState);
        } catch (error) {
          const wasAlreadyReferenced = previousSlots.some(
            ({ sha256 }) => sha256 === artifact.sha256,
          );
          if (!wasAlreadyReferenced) {
            await unlink(artifact.path).catch(() => undefined);
          }
          throw error;
        }
        state = nextState;

        if (
          evicted !== undefined
          && !slots.some(({ sha256 }) => sha256 === evicted.sha256)
        ) {
          await unlink(join(directory, evicted.file)).catch((error: NodeJS.ErrnoException) => {
            if (error.code !== "ENOENT") throw error;
          });
        }
        return artifact;
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
