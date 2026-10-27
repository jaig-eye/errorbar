import { normInv } from './normal';

/**
 * Smallest true change a paired comparison of `n` cases can reliably (80% power by default)
 * detect, given the standard deviation of the per-case deltas.
 */
export function minDetectableEffect(
  deltaSd: number,
  n: number,
  confidence = 0.95,
  power = 0.8,
): number {
  if (n < 1) return Number.POSITIVE_INFINITY;
  const zAlpha = normInv(1 - (1 - confidence) / 2);
  const zPower = normInv(power);
  return ((zAlpha + zPower) * deltaSd) / Math.sqrt(n);
}

/** Cases needed for a paired comparison to detect a change of `effect` at the given power. */
export function casesNeeded(
  deltaSd: number,
  effect: number,
  confidence = 0.95,
  power = 0.8,
): number {
  if (effect <= 0) return Number.POSITIVE_INFINITY;
  const zAlpha = normInv(1 - (1 - confidence) / 2);
  const zPower = normInv(power);
  return Math.ceil((((zAlpha + zPower) * deltaSd) / effect) ** 2);
}
