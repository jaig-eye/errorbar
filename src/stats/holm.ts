/**
 * Holm-Bonferroni step-down adjustment. Returns adjusted p-values in the original order.
 * Controls the chance of at least one false alarm across all the tests in the family.
 */
export function holmAdjust(pValues: readonly number[]): number[] {
  const m = pValues.length;
  const order = pValues.map((p, index) => ({ p, index })).sort((a, b) => a.p - b.p);
  const adjusted = new Array<number>(m);
  let running = 0;
  order.forEach(({ p, index }, rank) => {
    running = Math.max(running, Math.min(1, (m - rank) * p));
    adjusted[index] = running;
  });
  return adjusted;
}
