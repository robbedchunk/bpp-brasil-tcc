import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { gzip } from "node:zlib";
import { promisify } from "node:util";

const gzipAsync = promisify(gzip);

export interface ReplayArtifact {
  path: string;
  sha256: string;
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
