/**
 * Runs `fn` over `items` with at most `limit` in flight and returns results in input order.
 * Items not started because `shouldStop` turned true come back as undefined.
 */
export async function mapPool<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  shouldStop: () => boolean = () => false,
): Promise<Array<R | undefined>> {
  const results = new Array<R | undefined>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length && !shouldStop()) {
      const index = next++;
      results[index] = await fn(items[index] as T, index);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}
