import { describe, expect, it } from 'vitest';
import { mean, pairedBootstrap, quantileSorted, sd } from '../src/stats/bootstrap';
import { holmAdjust } from '../src/stats/holm';
import { normInv } from '../src/stats/normal';
import { casesNeeded, minDetectableEffect } from '../src/stats/power';
import { mulberry32, rngFor, seedFrom } from '../src/stats/rng';

describe('rng', () => {
  it('replays the same sequence for the same seed', () => {
    const a = mulberry32(seedFrom('x'));
    const b = mulberry32(seedFrom('x'));
    expect(Array.from({ length: 5 }, a)).toEqual(Array.from({ length: 5 }, b));
  });

  it('differs for different seeds and stays in [0, 1)', () => {
    const a = mulberry32(seedFrom('x'));
    const b = mulberry32(seedFrom('y'));
    expect(a()).not.toBe(b());
    const draws = Array.from({ length: 10_000 }, mulberry32(1));
    expect(Math.min(...draws)).toBeGreaterThanOrEqual(0);
    expect(Math.max(...draws)).toBeLessThan(1);
    expect(mean(draws)).toBeCloseTo(0.5, 1);
  });

  it('rngFor depends only on its parts', () => {
    expect(rngFor('a', 1, 'b')()).toBe(rngFor('a', 1, 'b')());
    expect(rngFor('a', 1, 'b')()).not.toBe(rngFor('a', 2, 'b')());
  });
});

describe('normInv', () => {
  it.each([
    [0.5, 0],
    [0.975, 1.959964],
    [0.8, 0.841621],
    [0.995, 2.575829],
    [0.025, -1.959964],
    [0.001, -3.090232],
  ])('normInv(%d) is %d', (p, z) => {
    expect(normInv(p)).toBeCloseTo(z, 4);
  });

  it('rejects values outside (0, 1)', () => {
    expect(() => normInv(0)).toThrow(RangeError);
    expect(() => normInv(1)).toThrow(RangeError);
  });
});

describe('summary statistics', () => {
  it('computes mean and sample standard deviation', () => {
    expect(mean([1, 2, 3, 4])).toBe(2.5);
    expect(sd([2, 4, 4, 4, 5, 5, 7, 9])).toBeCloseTo(2.138, 3);
    expect(sd([5])).toBe(0);
  });

  it('interpolates quantiles', () => {
    expect(quantileSorted([1, 2, 3, 4, 5], 0.5)).toBe(3);
    expect(quantileSorted([0, 10], 0.25)).toBe(2.5);
  });
});

describe('pairedBootstrap', () => {
  const options = { resamples: 4000, confidence: 0.95, seed: 'unit' };

  it('is repeatable', () => {
    const deltas = [0.1, -0.2, 0.05, 0.3, -0.1, 0];
    expect(pairedBootstrap(deltas, options)).toEqual(pairedBootstrap(deltas, options));
  });

  it('brackets the mean and narrows with more cases', () => {
    const rng = mulberry32(7);
    const small = Array.from({ length: 20 }, () => rng() - 0.5);
    const large = Array.from({ length: 400 }, () => rng() - 0.5);
    const a = pairedBootstrap(small, options);
    const b = pairedBootstrap(large, options);
    expect(a.lo).toBeLessThan(a.mean);
    expect(a.hi).toBeGreaterThan(a.mean);
    expect(b.hi - b.lo).toBeLessThan(a.hi - a.lo);
  });

  it('gives a tiny p-value for a clear drop and a large one for a clear gain', () => {
    const drop = Array.from({ length: 50 }, (_, i) => -0.2 + (i % 5) * 0.01);
    const gain = drop.map((d) => -d);
    expect(pairedBootstrap(drop, options).pDrop).toBeLessThan(0.001);
    expect(pairedBootstrap(gain, options).pDrop).toBeGreaterThan(0.99);
  });

  it('has a zero-width interval when nothing changed', () => {
    const result = pairedBootstrap(new Array<number>(30).fill(0), options);
    expect(result).toMatchObject({ mean: 0, lo: 0, hi: 0, sd: 0 });
    expect(result.pDrop).toBeGreaterThan(0.99);
  });

  it('copes with an empty input', () => {
    expect(pairedBootstrap([], options).n).toBe(0);
  });
});

describe('holmAdjust', () => {
  it('matches a worked example', () => {
    // sorted p: 0.01, 0.02, 0.04 -> x3, x2, x1 -> 0.03, 0.04, 0.04 (monotone)
    const adjusted = holmAdjust([0.04, 0.01, 0.02]);
    expect(adjusted[0]).toBeCloseTo(0.04);
    expect(adjusted[1]).toBeCloseTo(0.03);
    expect(adjusted[2]).toBeCloseTo(0.04);
  });

  it('caps at 1 and handles one test', () => {
    expect(holmAdjust([0.6, 0.7])).toEqual([1, 1]);
    expect(holmAdjust([0.03])).toEqual([0.03]);
    expect(holmAdjust([])).toEqual([]);
  });
});

describe('power', () => {
  it('matches the textbook formula', () => {
    // (1.96 + 0.8416) * sd / sqrt(n)
    expect(minDetectableEffect(0.2, 100)).toBeCloseTo(0.056, 3);
  });

  it('shrinks with more cases and grows with noise', () => {
    expect(minDetectableEffect(0.2, 400)).toBeLessThan(minDetectableEffect(0.2, 100));
    expect(minDetectableEffect(0.4, 100)).toBeGreaterThan(minDetectableEffect(0.2, 100));
  });

  it('inverts into cases needed', () => {
    const n = casesNeeded(0.2, 0.05);
    expect(minDetectableEffect(0.2, n)).toBeLessThanOrEqual(0.05);
    expect(minDetectableEffect(0.2, n - 1)).toBeGreaterThan(0.05);
    expect(casesNeeded(0.2, 0)).toBe(Number.POSITIVE_INFINITY);
  });
});
