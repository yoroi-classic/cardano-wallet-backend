/**
 * Run `worker` over `items` with at most `limit` calls in flight at once, returning the results in
 * input order.
 *
 * Blockfrost has no batch form of the used-address check, so a wallet restore can ask this driver
 * about hundreds of addresses in one call. Firing every lookup at once would open that many
 * authenticated upstream connections simultaneously and earn a 429 for the whole batch. A fixed
 * pool of workers pulling from one shared iterator keeps the fan-out bounded while still
 * overlapping the round trips, and writing each result at its own index preserves the caller's
 * order regardless of which worker finishes first.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length)
  // One shared iterator, drained by every worker: each `.next()` is atomic on the single JS
  // thread, so no entry is handed out twice and none is skipped.
  const entries = items.entries()
  const workerCount = Math.max(1, Math.min(limit, items.length))

  async function run(): Promise<void> {
    for (const [index, item] of entries) {
      results[index] = await worker(item, index)
    }
  }

  await Promise.all(Array.from({ length: workerCount }, run))
  return results
}
