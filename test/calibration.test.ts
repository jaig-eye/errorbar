// Simulations that check the gate against known truth. These are the tests that matter most:
// if the false-alarm rate or the power drifts from what the docs promise, errorbar is wrong.
import { describe, expect, it } from 'vitest';
import { evaluateFamily } from '../src/compare/verdict';
import { mean, sd } from '../src/stats/bootstrap';
import { minDetectableEffect } from '../src/stats/power';
import { mulberry32, type Rng } from '../src/stats/rng';
import { DEFAULT_GATE, type GateSettings } from '../src/types';

// ERRORBAR_SIMS=20000 for a slower, tighter check.
const SIMS = Number(process.env.ERRORBAR_SIMS ?? 2000);
const gate: GateSettings = { ...DEFAULT_GATE, bootstrap: 1000, seed: 'calibration' };

/** Standard normal draw (Box-Muller). */
function normal(rng: Rng): number {
  return Math.sqrt(-2 * Math.log(1 - rng())) * Math.cos(2 * Math.PI * rng());
}

interface World {
  n: number;
  trials: number;
  /** Spread of true case quality. */
  caseSd: number;
  /** Trial-to-trial noise inside one case. */
  noiseSd: number;
  /** Spread of how much each case's true quality changes. */
  effectSd: number;
  /** Average true change. */
  effect: number;
}

interface Draw {
  /** Per-case means of base and head, which is what the gate sees. */
  base: number[];
  head: number[];
  /** Raw per-trial values, for the naive trial-level test. */
  baseTrials: number[][];
  headTrials: number[][];
}

function draw(world: World, rng: Rng): Draw {
  const out: Draw = { base: [], head: [], baseTrials: [], headTrials: [] };
  for (let i = 0; i < world.n; i++) {
    const quality = 0.6 + world.caseSd * normal(rng);
    const shift = world.effect + world.effectSd * normal(rng);
    const b = Array.from({ length: world.trials }, () => quality + world.noiseSd * normal(rng));
    const h = Array.from(
      { length: world.trials },
      () => quality + shift + world.noiseSd * normal(rng),
    );
    out.baseTrials.push(b);
    out.headTrials.push(h);
    out.base.push(mean(b));
    out.head.push(mean(h));
  }
  return out;
}

function regressionRate(world: World, maxDrop: number, seed: number, sims = SIMS): number {
  const rng = mulberry32(seed);
  let flagged = 0;
  for (let s = 0; s < sims; s++) {
    const d = draw(world, rng);
    const [out] = evaluateFamily(
      [{ key: `sim${s}`, base: d.base, head: d.head, max_drop: maxDrop }],
      gate,
    );
    if (out?.verdict === 'regression') flagged++;
  }
  return flagged / sims;
}

/** What you get by pooling every trial as if it were an independent observation. */
function naiveTrialLevelRate(world: World, seed: number): number {
  const rng = mulberry32(seed);
  let flagged = 0;
  for (let s = 0; s < SIMS; s++) {
    const d = draw(world, rng);
    const deltas = d.headTrials.flatMap((h, i) => h.map((v, j) => v - (d.baseTrials[i]?.[j] ?? 0)));
    const z = mean(deltas) / (sd(deltas) / Math.sqrt(deltas.length));
    if (z < -1.96) flagged++;
  }
  return flagged / SIMS;
}

describe('calibration', () => {
  const quiet: World = { n: 60, trials: 3, caseSd: 0.2, noiseSd: 0.25, effectSd: 0, effect: 0 };

  it('false-alarm rate with no real change stays near the nominal 2.5%', () => {
    // max_drop 0 is the strictest reading: any significant drop at all counts. The nominal level
    // is alpha / 2 = 0.025 (one-sided). Measured at 8,000 runs: 3.3% at 20 cases, 2.7% at 60, 2.5% at 120.
    const rate = regressionRate(quiet, 0, 101);
    expect(rate).toBeGreaterThan(0.01);
    expect(rate).toBeLessThan(0.04);
  });

  it('max_drop never makes the gate stricter than the significance test alone', () => {
    expect(regressionRate(quiet, 0.03, 102)).toBeLessThanOrEqual(regressionRate(quiet, 0, 102));
  });

  it('a real but small drop in a large suite does not fail when it is within max_drop', () => {
    const large: World = { ...quiet, n: 400, effect: -0.01 };
    expect(regressionRate(large, 0.05, 106, 400)).toBeLessThan(0.005);
  });

  it('catches a drop of the predicted minimum detectable size about 80% of the time', () => {
    const deltaSd = quiet.noiseSd * Math.sqrt(2 / quiet.trials);
    const mde = minDetectableEffect(deltaSd, quiet.n, gate.confidence, 0.8);
    const power = regressionRate({ ...quiet, effect: -mde }, 0, 103);
    expect(power).toBeGreaterThan(0.72);
    expect(power).toBeLessThan(0.9);
  });

  it('catches a large drop essentially every time', () => {
    expect(regressionRate({ ...quiet, effect: -0.2 }, 0.03, 104)).toBeGreaterThan(0.99);
  });

  describe('when a change helps some cases and hurts others (trials of a case move together)', () => {
    const mixed: World = { n: 50, trials: 5, caseSd: 0.2, noiseSd: 0.25, effectSd: 0.3, effect: 0 };

    it('resampling cases keeps the false-alarm rate near nominal', () => {
      expect(regressionRate(mixed, 0, 105)).toBeLessThan(0.05);
    });

    it('treating every trial as independent is overconfident, which is why errorbar does not', () => {
      expect(naiveTrialLevelRate(mixed, 105)).toBeGreaterThan(0.08);
    });
  });
});

describe('calibration on pass/fail scores', () => {
  // Most real eval scores are 0 or 1, with a few hard cases and mostly easy ones. That is where
  // a bootstrap can misbehave, because a change is decided by only a handful of flipped cases.
  function passFailFalseAlarmRate(n: number, trials: number, seed: number): number {
    const rng = mulberry32(seed);
    let flagged = 0;
    for (let s = 0; s < SIMS; s++) {
      const base: number[] = [];
      const head: number[] = [];
      for (let i = 0; i < n; i++) {
        const p = rng() < 0.1 ? 0.3 : 0.97;
        const run = () => mean(Array.from({ length: trials }, () => (rng() < p ? 1 : 0)));
        base.push(run());
        head.push(run());
      }
      const [out] = evaluateFamily([{ key: `pf${s}`, base, head, max_drop: 0 }], {
        ...gate,
        min_cases: 5,
      });
      if (out?.verdict === 'regression') flagged++;
    }
    return flagged / SIMS;
  }

  it('does not over-fire when only a few cases can flip (24 cases, 1 trial)', () => {
    // Measured at 6,000 runs: 0.7%. Few flipped cases make the test conservative, never liberal.
    expect(passFailFalseAlarmRate(24, 1, 201)).toBeLessThan(0.04);
  });

  it('stays at the nominal level with 60 cases and 3 trials', () => {
    // Measured at 6,000 runs: 2.2%.
    expect(passFailFalseAlarmRate(60, 3, 202)).toBeLessThan(0.04);
  });
});
