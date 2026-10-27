import { type BootstrapResult, pairedBootstrap } from '../stats/bootstrap';
import { holmAdjust } from '../stats/holm';
import { casesNeeded, minDetectableEffect } from '../stats/power';
import type { GateSettings } from '../types';

export type Verdict = 'regression' | 'improved' | 'pass' | 'inconclusive';

export interface TestInput {
  /** Identifies the test; also seeds its bootstrap. */
  key: string;
  /** One value per paired case: the mean of that case's trials. Same order on both sides. */
  base: readonly number[];
  head: readonly number[];
  max_drop: number;
}

export interface TestOutput {
  key: string;
  stat: BootstrapResult;
  /** Holm-adjusted one-sided p-value for "quality dropped". */
  adj_p: number;
  /** Smallest change this many cases can detect at 80% power. */
  mde: number;
  /** Cases needed to detect a change of `max_drop` at 80% power. null when max_drop is 0. */
  cases_needed: number | null;
  verdict: Verdict;
}

/**
 * The decision rule, in one place.
 *
 *  - regression:   a drop that is statistically real (Holm-adjusted) AND at least `max_drop`.
 *  - improved:     the whole interval is above zero.
 *  - pass:         the interval rules out any drop bigger than `max_drop`.
 *  - inconclusive: none of the above. The suite is too small or too noisy to say.
 */
export function decideVerdict(
  stat: BootstrapResult,
  adjP: number,
  maxDrop: number,
  gate: GateSettings,
): Verdict {
  if (stat.n < gate.min_cases) return 'inconclusive';
  const alphaOneSided = (1 - gate.confidence) / 2;
  if (adjP < alphaOneSided && stat.mean <= -maxDrop) return 'regression';
  if (stat.lo > 0) return 'improved';
  if (stat.lo >= -maxDrop) return 'pass';
  return 'inconclusive';
}

/**
 * Runs every test, then corrects the regression p-values together (Holm) so that gating
 * five metrics does not make a false alarm five times as likely.
 */
export function evaluateFamily(inputs: readonly TestInput[], gate: GateSettings): TestOutput[] {
  const stats = inputs.map((input) => {
    const deltas = input.head.map((value, i) => value - (input.base[i] as number));
    return pairedBootstrap(deltas, {
      resamples: gate.bootstrap,
      confidence: gate.confidence,
      seed: `${gate.seed}:${input.key}`,
    });
  });

  // Tests that cannot reach a verdict because they are too small stay out of the family:
  // they cannot be regressions, so counting them would only make the correction harsher.
  const inFamily = stats.map((stat) => stat.n >= gate.min_cases);
  const familyIndexes = stats.flatMap((_, i) => (inFamily[i] ? [i] : []));
  const adjusted = holmAdjust(familyIndexes.map((i) => (stats[i] as BootstrapResult).pDrop));
  const adjustedByIndex = new Map(familyIndexes.map((index, k) => [index, adjusted[k] as number]));

  return inputs.map((input, i) => {
    const stat = stats[i] as BootstrapResult;
    const adjP = adjustedByIndex.get(i) ?? 1;
    return {
      key: input.key,
      stat,
      adj_p: adjP,
      mde: minDetectableEffect(stat.sd, stat.n, gate.confidence),
      cases_needed:
        input.max_drop > 0 ? casesNeeded(stat.sd, input.max_drop, gate.confidence) : null,
      verdict: decideVerdict(stat, adjP, input.max_drop, gate),
    };
  });
}
