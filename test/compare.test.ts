import { describe, expect, it } from 'vitest';
import { compare } from '../src/compare/compare';
import { flatCases, makeResults, makeSuite, must } from './helpers';

/** 40 cases whose base score varies a little from case to case. */
const N = 40;
const baseScore = (i: number) => 0.7 + ((i * 7) % 10) / 50; // 0.70 .. 0.88
const three = (v: number) => [v, v, v];

function pair(headDelta: (i: number) => number, options: { metric?: string } = {}) {
  const metric = options.metric ?? 'm';
  const base = makeSuite({ cases: flatCases(N, metric, (i) => three(baseScore(i))) });
  const head = makeSuite({
    cases: flatCases(N, metric, (i) => three(baseScore(i) + headDelta(i))),
  });
  return { base: makeResults([base]), head: makeResults([head]) };
}

const row = (c: ReturnType<typeof compare>, metric = 'm') => {
  const found = c.suites[0]?.rows.find((r) => r.metric === metric);
  if (!found) throw new Error(`no row for ${metric}`);
  return found;
};

describe('compare', () => {
  it('fails a clear regression and says which metric', () => {
    const { base, head } = pair(() => -0.15);
    const result = compare(base, head);
    expect(row(result).verdict).toBe('regression');
    expect(result.overall).toBe('fail');
    expect(result.summary).toBe('regression in suite › m');
    expect(row(result).delta).toBeCloseTo(-0.15, 5);
  });

  it('passes an unchanged run and calls it "no change"', () => {
    const { base, head } = pair(() => 0);
    const result = compare(base, head);
    expect(result.overall).toBe('pass');
    expect(row(result)).toMatchObject({ verdict: 'pass', delta: 0, lo: 0, hi: 0, n: N });
  });

  it('reports a clear gain', () => {
    const { base, head } = pair(() => 0.1);
    expect(row(compare(base, head)).verdict).toBe('improved');
  });

  it('shows the worst per-case drops with the outputs from each side', () => {
    const base = makeSuite({ cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
    const head = makeSuite({
      cases: flatCases(N, 'm', (i) => three(baseScore(i) - 0.15 - (i === 4 ? 0.3 : 0))).map(
        (c) => ({
          ...c,
          output: `new answer for ${c.id}`,
        }),
      ),
    });
    const result = compare(makeResults([base]), makeResults([head]));
    const movers = result.suites[0]?.movers.m ?? [];
    expect(movers).toHaveLength(3);
    expect(movers[0]?.case_id).toBe('c5'); // the biggest drop first
    expect(movers[0]?.head_output).toBe('new answer for c5');
    expect(movers[0]?.base_output).toMatch(/^output c5/);
    expect(movers[0]?.head_score).toBeLessThan(movers[0]?.base_score ?? 0);
  });

  it('calls a noisy small suite inconclusive and warns by default', () => {
    const noisy = (flip: boolean) =>
      makeSuite({ cases: flatCases(20, 'm', (i) => three((i + (flip ? 1 : 0)) % 2)) });
    const result = compare(makeResults([noisy(false)]), makeResults([noisy(true)]));
    expect(row(result).verdict).toBe('inconclusive');
    expect(row(result).mde).toBeGreaterThan(0.1);
    expect(result.overall).toBe('warn');
  });

  it.each([
    ['fail', 'fail'],
    ['warn', 'warn'],
    ['pass', 'pass'],
  ] as const)('on_inconclusive %s makes the build %s', (setting, overall) => {
    const noisy = (flip: boolean) =>
      makeSuite({ cases: flatCases(20, 'm', (i) => three((i + (flip ? 1 : 0)) % 2)) });
    const result = compare(makeResults([noisy(false)]), makeResults([noisy(true)]), {
      on_inconclusive: setting,
    });
    expect(result.overall).toBe(overall);
  });

  it('refuses a verdict below min_cases and says why', () => {
    const base = makeSuite({ cases: flatCases(5, 'm', () => three(0.9)) });
    const head = makeSuite({ cases: flatCases(5, 'm', () => three(0.1)) });
    const result = compare(makeResults([base]), makeResults([head]));
    expect(row(result).verdict).toBe('inconclusive');
    expect(row(result).note).toContain('only 5 paired cases');
  });

  describe('which cases and metrics are compared', () => {
    it('leaves out added, removed and edited cases', () => {
      const base = makeSuite({ cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const headCases = flatCases(N, 'm', (i) => three(baseScore(i)));
      headCases[0] = { ...headCases[0], id: 'c1', rev: '2', scores: { m: three(0) } }; // edited
      headCases.pop(); // c40 removed
      headCases.push({ id: 'new1', scores: { m: three(0.5) } }); // added
      const result = compare(makeResults([base]), makeResults([makeSuite({ cases: headCases })]));
      const suite = result.suites[0];
      expect(suite?.edited).toEqual(['c1']);
      expect(suite?.removed).toEqual(['c40']);
      expect(suite?.added).toEqual(['new1']);
      expect(suite?.paired_cases).toBe(N - 2);
      // The edited case scored 0 but must not count as a regression.
      expect(row(result).verdict).toBe('pass');
    });

    it('does not compare a metric whose definition changed', () => {
      const base = makeSuite({
        cases: flatCases(N, 'm', () => three(0.9)),
        metricHash: { m: 'v1' },
      });
      const head = makeSuite({
        cases: flatCases(N, 'm', () => three(0.1)),
        metricHash: { m: 'v2' },
      });
      const result = compare(makeResults([base]), makeResults([head]));
      expect(row(result).verdict).toBe('not_comparable');
      expect(row(result).head_mean).toBeCloseTo(0.1, 10);
      expect(row(result).note).toContain('definition changed');
      expect(result.overall).toBe('pass');
    });

    it('reports a new metric without comparing it', () => {
      const base = makeSuite({ cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const head = makeSuite({
        cases: flatCases(N, 'm', (i) => three(baseScore(i))).map((c) => ({
          ...c,
          scores: { ...c.scores, extra: three(0.5) },
        })),
      });
      const result = compare(makeResults([base]), makeResults([head]));
      expect(row(result, 'extra')).toMatchObject({
        verdict: 'not_comparable',
        note: 'new metric, nothing to compare with',
      });
    });

    it('shows an ungated metric but never fails on it', () => {
      const base = makeSuite({
        cases: flatCases(N, 'm', (i) => three(baseScore(i))),
        ungated: ['m'],
      });
      const head = makeSuite({
        cases: flatCases(N, 'm', (i) => three(baseScore(i) - 0.3)),
        ungated: ['m'],
      });
      const result = compare(makeResults([base]), makeResults([head]));
      expect(row(result)).toMatchObject({ verdict: 'not_gated' });
      expect(row(result).delta).toBeCloseTo(-0.3, 5);
      expect(row(result).hi).toBeLessThan(0);
      expect(result.overall).toBe('pass');
    });

    it('lists suites that are new or gone', () => {
      const a = makeSuite({ name: 'a', cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const b = makeSuite({ name: 'b', cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const c = makeSuite({ name: 'c', cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const result = compare(makeResults([a, b]), makeResults([a, c]));
      expect(result.suites.map((s) => [s.name, s.status])).toEqual([
        ['a', 'compared'],
        ['c', 'new'],
        ['b', 'removed'],
      ]);
    });

    it('uses a per-metric max_drop', () => {
      const base = makeSuite({ cases: flatCases(200, 'm', (i) => three(0.8 + (i % 5) / 100)) });
      const head = makeSuite({
        cases: flatCases(200, 'm', (i) => three(0.8 + (i % 5) / 100 - 0.02)),
      });
      head.metrics.m = { ...must(head.metrics.m), max_drop: 0.1 };
      const lenient = compare(makeResults([base]), makeResults([head]));
      expect(row(lenient).verdict).toBe('pass');
      delete must(head.metrics.m).max_drop;
      expect(
        row(compare(makeResults([base]), makeResults([head]), { max_drop: 0.01 })).verdict,
      ).toBe('regression');
    });
  });

  describe('when the model underneath moved', () => {
    const regress = (baseModels: string[], headModels: string[]) => {
      const base = makeSuite({
        targetModel: 'claude-x',
        models: baseModels,
        cases: flatCases(N, 'm', (i) => three(baseScore(i))),
      });
      const head = makeSuite({
        targetModel: 'claude-x',
        models: headModels,
        cases: flatCases(N, 'm', (i) => three(baseScore(i) - 0.2)),
      });
      return compare(makeResults([base]), makeResults([head]));
    };

    it('does not blame the change when the model snapshot differs', () => {
      const result = regress(['claude-x-20260101'], ['claude-x-20260901']);
      expect(row(result).verdict).toBe('inconclusive');
      expect(row(result).note).toContain('changed');
      expect(row(result).note).toContain('claude-x-20260901');
      expect(result.overall).toBe('warn');
    });

    it('still fails when the snapshot is the same', () => {
      expect(row(regress(['claude-x-20260101'], ['claude-x-20260101'])).verdict).toBe('regression');
    });

    it('notices a judge that moved', () => {
      const make = (judgeModels: string[], drop: number) => {
        const suite = makeSuite({
          cases: flatCases(N, 'quality', (i) => three(baseScore(i) - drop)),
        });
        suite.metrics.quality = {
          ...must(suite.metrics.quality),
          judge_model: 'judge-x',
          judge_models: judgeModels,
        };
        return makeResults([suite]);
      };
      const result = compare(make(['judge-x-1'], 0), make(['judge-x-2'], 0.2));
      expect(row(result, 'quality').verdict).toBe('inconclusive');
      expect(row(result, 'quality').note).toContain('judge model');
    });
  });

  describe('flaky cases', () => {
    it('lists cases whose own trials disagree', () => {
      const cases = flatCases(N, 'm', () => three(1));
      cases[2] = { id: 'c3', scores: { m: [1, 0, 1] } };
      cases[9] = { id: 'c10', scores: { m: [0.9, 0.7, 0.8] } }; // varied but not flaky
      const suite = makeSuite({ cases });
      const result = compare(makeResults([suite]), makeResults([suite]));
      expect(result.suites[0]?.flaky).toEqual([{ case_id: 'c3', metric: 'm', min: 0, max: 1 }]);
      expect(result.suites[0]?.flaky_cases).toBe(1);
    });

    it('warns that one trial cannot measure noise', () => {
      const suite = makeSuite({ cases: flatCases(N, 'm', (i) => [baseScore(i)]) });
      const result = compare(makeResults([suite]), makeResults([suite]));
      expect(result.suites[0]?.notes.join(' ')).toContain('trials is 1');
    });
  });

  describe('a run that is broken, not worse', () => {
    it('reports an error rather than a verdict when too many trials errored', () => {
      const base = makeSuite({ cases: flatCases(N, 'm', (i) => three(baseScore(i))) });
      const head = makeSuite({
        cases: flatCases(N, 'm', (i) => three(baseScore(i) - 0.3)),
        errored: 30,
      });
      const result = compare(makeResults([base]), makeResults([head]));
      expect(result.overall).toBe('error');
      expect(result.suites[0]?.errored).toBe(true);
      expect(result.summary).toContain('broken run');
    });

    it('tolerates a few errors', () => {
      const { base, head } = pair(() => 0);
      must(head.suites[0]).errors = { trials: 120, errored: 6 };
      expect(compare(base, head).overall).toBe('pass');
    });
  });

  describe('without a baseline', () => {
    it('shows the scores and does not gate', () => {
      const head = makeResults([
        makeSuite({ cases: flatCases(N, 'm', (i) => three(baseScore(i))) }),
      ]);
      const result = compare(null, head);
      expect(result.overall).toBe('no_baseline');
      expect(result.baseline).toBeNull();
      expect(result.suites[0]).toMatchObject({ status: 'new' });
      expect(row(result)).toMatchObject({ verdict: 'not_comparable', note: 'no baseline yet' });
    });
  });

  it('is repeatable', () => {
    const { base, head } = pair((i) => -0.05 + ((i * 3) % 7) / 100);
    expect(compare(base, head)).toEqual(compare(base, head));
  });
});
