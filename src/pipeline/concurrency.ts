const MAX_PAGE_CONCURRENCY = 5;
const MIN_PRODUCTION_PAGE_CONCURRENCY = 3;

export function boundedConcurrency(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return 4;
  return Math.max(1, Math.min(MAX_PAGE_CONCURRENCY, Math.trunc(requested)));
}

export function productionConcurrency(requested: number | undefined): number {
  return Math.max(MIN_PRODUCTION_PAGE_CONCURRENCY, boundedConcurrency(requested));
}

export async function mapConcurrent<T, R>(
  values: readonly T[],
  requestedConcurrency: number | undefined,
  worker: (value: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(values.length);
  const concurrency = Math.min(boundedConcurrency(requestedConcurrency), values.length);
  let nextIndex = 0;
  let stopped = false;
  let failed = false;
  let firstError: unknown;

  const consume = async (): Promise<void> => {
    while (!stopped) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= values.length) return;
      const value = values[index];
      if (value === undefined) return;
      try {
        results[index] = await worker(value, index);
      } catch (error) {
        if (!failed) firstError = error;
        failed = true;
        stopped = true;
        return;
      }
    }
  };

  await Promise.all(Array.from({ length: concurrency }, consume));
  if (failed) throw firstError;
  return results;
}
