import { mulberry32, seedFrom } from './rng';

export interface BootstrapOptions {
  /** Number of bootstrap resamples. */
  resamples: number;
  /** Two-sided confidence level, e.g. 0.95. */
  confidence: number;
  /** Anything that identifies this test, so the same data always gives the same answer. */
  seed: string;
}

export interface BootstrapResult {
  n: number;
  mean: number;
  sd: number;
  /** Lower and upper ends of the percentile confidence interval for the mean. */
  lo: number;
  hi: number;
  /** One-sided bootstrap p-value for "the true mean is below zero" (a drop). */
  pDrop: number;
}

export function mean(values: readonly number[]): number {
  if (values.length === 0) return Number.NaN;
  let sum = 0;
  for (const v of values) sum += v;
  return sum / values.length;
}

/** Sample standard deviation (n - 1 in the denominator). 0 for fewer than two values. */
export function sd(values: readonly number[]): number {
  const n = values.length;
  if (n < 2) return 0;
  const m = mean(values);
  let sum = 0;
  for (const v of values) sum += (v - m) ** 2;
  return Math.sqrt(sum / (n - 1));
}

/** Linear-interpolated quantile of an already sorted array. */
export function quantileSorted(sorted: ArrayLike<number>, q: number): number {
  const n = sorted.length;
  if (n === 0) return Number.NaN;
  const pos = (n - 1) * q;
  const lower = Math.floor(pos);
  const upper = Math.ceil(pos);
  const a = sorted[lower] as number;
  const b = sorted[upper] as number;
  return a + (b - a) * (pos - lower);
}

/**
 * Percentile bootstrap for the mean of per-case deltas.
 *
 * Each element of `deltas` is ONE case (its trials already averaged). Resampling cases, not
 * trials, is what keeps the interval honest: trials of one case move together, so treating
 * them as independent draws would make the interval too narrow.
 */
export function pairedBootstrap(
  deltas: readonly number[],
  options: BootstrapOptions,
): BootstrapResult {
  const n = deltas.length;
  const observed = mean(deltas);
  if (n === 0) {
    return { n, mean: Number.NaN, sd: 0, lo: Number.NaN, hi: Number.NaN, pDrop: 1 };
  }

  // A plain bootstrap of the mean is a little too narrow for small n: its variance is
  // (n - 1) / n times the real one. Widening the resampled deviations by sqrt(n / (n - 1))
  // (Hesterberg's "bootstrap expansion") puts the false-alarm rate back on target.
  const expansion = n > 1 ? Math.sqrt(n / (n - 1)) : 1;
  const rng = mulberry32(seedFrom(options.seed));
  const resampled = new Float64Array(options.resamples);
  for (let b = 0; b < options.resamples; b++) {
    let sum = 0;
    for (let i = 0; i < n; i++) sum += deltas[Math.floor(rng() * n)] as number;
    resampled[b] = observed + (sum / n - observed) * expansion;
  }
  resampled.sort();

  const alpha = 1 - options.confidence;
  let atOrAboveZero = 0;
  for (let b = options.resamples - 1; b >= 0 && (resampled[b] as number) >= 0; b--) atOrAboveZero++;

  return {
    n,
    mean: observed,
    sd: sd(deltas),
    lo: quantileSorted(resampled, alpha / 2),
    hi: quantileSorted(resampled, 1 - alpha / 2),
    pDrop: (atOrAboveZero + 1) / (options.resamples + 1),
  };
}
