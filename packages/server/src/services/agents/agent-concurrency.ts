// ──────────────────────────────────────────────
// Agents: bounded worker-pool helpers
// ──────────────────────────────────────────────

export async function settleAgentJobsWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const normalizedLimit = Number.isFinite(limit) ? Math.trunc(limit) : 1;
  const concurrent = Math.max(1, Math.min(items.length, normalizedLimit));
  const results = new Array<PromiseSettledResult<R>>(items.length);
  let nextIndex = 0;

  await Promise.all(
    Array.from({ length: concurrent }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex++;
        try {
          results[index] = { status: "fulfilled", value: await worker(items[index]!, index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    }),
  );

  return results;
}

export function createAgentConcurrencyLimiter(limit: number) {
  const normalizedLimit = Number.isFinite(limit) ? Math.max(1, Math.trunc(limit)) : 1;
  let activeJobs = 0;
  const waiting: Array<() => void> = [];

  const acquire = () =>
    new Promise<void>((resolve) => {
      if (activeJobs < normalizedLimit) {
        activeJobs += 1;
        resolve();
        return;
      }
      waiting.push(() => {
        activeJobs += 1;
        resolve();
      });
    });

  return async function runWithAgentConcurrencyLimit<R>(job: () => Promise<R>): Promise<R> {
    await acquire();
    try {
      return await job();
    } finally {
      activeJobs -= 1;
      waiting.shift()?.();
    }
  };
}
