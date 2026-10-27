import { describe, expect, it } from 'vitest';
import { evaluateFamily, type TestInput } from '../src/compare/verdict';
import { mulberry32 } from '../src/stats/rng';
import { DEFAULT_GATE, type GateSettings } from '../src/types';

const gate: GateSettings = { ...DEFAULT_GATE, bootstrap: 2000, seed: 'verdict-test' };

function input(key: string, base: number[], head: number[], max_drop = 0.03): TestInput {
  return { key, base, head, max_drop };
}

/** n cases around `center`, with a little deterministic jitter. */
function around(n: number, center: number, jitter: number, seed: number): number[] {
  const rng = mulberry32(seed);
  return Array.from({ length: n }, () => center + (rng() - 0.5) * jitter);
}

describe('evaluateFamily', () => {
  it('flags a clear drop as a regression', () => {
    const base = around(60, 0.8, 0.2, 1);
    const head = base.map((v) => v - 0.12);
    const [out] = evaluateFamily([input('m', base, head)], gate);
    expect(out?.verdict).toBe('regression');
    expect(out?.stat.mean).toBeCloseTo(-0.12, 5);
    expect(out?.stat.hi).toBeLessThan(0);
  });

  it('passes when nothing changed, with zero-width interval', () => {
    const base = around(40, 0.7, 0.3, 2);
    const [out] = evaluateFamily([input('m', base, [...base])], gate);
    expect(out?.verdict).toBe('pass');
    expect(out?.stat).toMatchObject({ mean: 0, lo: 0, hi: 0 });
  });

  it('reports a clear gain as improved', () => {
    const base = around(60, 0.6, 0.2, 3);
    const head = base.map((v) => v + 0.1);
    const [out] = evaluateFamily([input('m', base, head)], gate);
    expect(out?.verdict).toBe('improved');
  });

  it('does not fail a statistically real drop that is smaller than max_drop', () => {
    const base = around(200, 0.8, 0.1, 4);
    const head = base.map((v) => v - 0.01);
    const [out] = evaluateFamily([input('m', base, head, 0.05)], gate);
    expect(out?.stat.hi).toBeLessThan(0); // real
    expect(out?.verdict).toBe('pass'); // but within the allowed 0.05
  });

  it('says inconclusive when the suite is too noisy to rule out a big drop', () => {
    const rng = mulberry32(5);
    const base = Array.from({ length: 15 }, () => rng());
    const head = Array.from({ length: 15 }, () => rng()); // unrelated noise
    const [out] = evaluateFamily([input('m', base, head)], gate);
    expect(out?.verdict).toBe('inconclusive');
    expect(out?.mde).toBeGreaterThan(0.1);
    expect(out?.cases_needed).toBeGreaterThan(15);
  });

  it('never gives a verdict below min_cases', () => {
    const base = [0.9, 0.9, 0.9, 0.9, 0.9];
    const head = [0.1, 0.1, 0.1, 0.1, 0.1];
    const [out] = evaluateFamily([input('m', base, head)], gate);
    expect(out?.verdict).toBe('inconclusive');
  });

  it('is repeatable', () => {
    const base = around(40, 0.7, 0.4, 6);
    const head = around(40, 0.65, 0.4, 7);
    const a = evaluateFamily([input('m', base, head)], gate);
    const b = evaluateFamily([input('m', base, head)], gate);
    expect(a).toEqual(b);
  });

  it('uses max_drop 0 as "any real drop"', () => {
    const base = around(100, 0.8, 0.2, 8);
    const head = base.map((v) => v - 0.02);
    const [out] = evaluateFamily([input('m', base, head, 0)], gate);
    expect(out?.verdict).toBe('regression');
    expect(out?.cases_needed).toBeNull();
  });

  it('raises the bar when several metrics are tested together', () => {
    const base = around(80, 0.8, 0.5, 9);
    const rng = mulberry32(10);
    const jitter = () => base.map((v) => v + (rng() - 0.5) * 0.4);
    const drop = jitter().map((v) => v - 0.06);

    const alone = evaluateFamily([input('target', base, drop, 0)], gate)[0];
    const unrelated = Array.from({ length: 7 }, (_, k) => input(`other${k}`, base, jitter(), 0));
    const family = evaluateFamily([input('target', base, drop, 0), ...unrelated], gate)[0];

    // Same data, same raw p-value; the adjusted one is what pays for the seven extra looks.
    expect(family?.stat.pDrop).toBe(alone?.stat.pDrop);
    expect(family?.adj_p).toBeGreaterThan(alone?.adj_p ?? 1);
  });
});
