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
 *
 * The whole batch fails on the first worker rejection, with that rejection, exactly as
 * `Promise.all` would — but once one worker has failed, its peers stop claiming new items rather
 * than draining the queue against an upstream the caller has already given up on. In-flight calls
 * still run to completion (a promise can't be un-started), so the wasted work is bounded by the
 * pool size, not the length of the remaining queue.
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
  // Flipped by the first worker to reject, so its peers stop pulling new work after a failure.
  let aborted = false

  async function run(): Promise<void> {
    for (const [index, item] of entries) {
      if (aborted) return
      try {
        results[index] = await worker(item, index)
      } catch (err) {
        aborted = true
        throw err
      }
    }
  }

  await Promise.all(Array.from({ length: workerCount }, run))
  return results
}
