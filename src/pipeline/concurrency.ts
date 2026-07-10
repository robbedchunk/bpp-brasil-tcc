const MAX_PAGE_CONCURRENCY = 5;

export function boundedConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 4;
  return Math.max(1, Math.min(MAX_PAGE_CONCURRENCY, Math.trunc(requested)));
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  requestedConcurrency: number | undefined,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  const concurrency = Math.min(boundedConcurrency(requestedConcurrency), values.length);
  let nextIndex = 0;

  const consume = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      results[index] = await worker(value, index);
    }
  };

  await Promise.all(Array.from({ length: concurrency }, consume));
  return results;
}
