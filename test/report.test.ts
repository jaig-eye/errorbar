import { describe, expect, it } from 'vitest';
import { compare } from '../src/compare/compare';
import {
  formatDelta,
  formatDuration,
  formatTokens,
  REPORT_MARKER,
  renderReport,
} from '../src/report/markdown';
import { mulberry32 } from '../src/stats/rng';
import { type CaseSpec, flatCases, makeResults, makeSuite, must } from './helpers';

/** A realistic mixed run: one metric regresses, one is unchanged, one is noisy, plus case changes. */
function scenario() {
  const rng = mulberry32(42);
  const n = 60;
  const mk = (drop: number): CaseSpec[] => {
    const r = mulberry32(1);
    return Array.from({ length: n }, (_, i) => {
      const quality = 0.55 + r() * 0.4;
      const helpful = (t: number) =>
        Math.min(1, Math.max(0, quality - drop + (rng() - 0.5) * 0.1 + t * 0));
      return {
        id: `case-${String(i + 1).padStart(2, '0')}`,
        output: `Answer text for case ${i + 1}, version ${drop > 0 ? 'new' : 'old'}.`,
        scores: {
          helpfulness: [helpful(0), helpful(1), helpful(2)],
          has_citation: [1, 1, i % 9 === 0 ? 0 : 1],
          'recall@5': [i % 4 === 0 ? 0.5 : 1, i % 4 === 0 ? 0.5 : 1, i % 4 === 0 ? 0.5 : 1],
        },
      };
    });
  };
  const base = makeSuite({ name: 'support-bot', cases: mk(0), duration_ms: 61_000 });
  const headCases = mk(0.1);
  headCases[3] = { ...must(headCases[3]), rev: '2' }; // an edited case
  headCases.push({
    id: 'case-61',
    scores: { helpfulness: [1, 1, 1], has_citation: [1, 1, 1], 'recall@5': [1, 1, 1] },
  });
  const head = makeSuite({ name: 'support-bot', cases: headCases, duration_ms: 72_000 });
  return compare(
    makeResults([base], {}, { sha: 'abcdef0123456789', ref: 'refs/heads/main' }),
    makeResults([head], {}, { sha: 'fedcba9876543210', ref: 'refs/pull/7/merge' }),
  );
}

describe('renderReport', () => {
  it('matches the reviewed golden report', async () => {
    await expect(renderReport(scenario(), { marker: true })).toMatchFileSnapshot(
      './__snapshots__/regression.md',
    );
  });

  it('carries the marker the comment is found by, only when asked', () => {
    expect(renderReport(scenario(), { marker: true })).toContain(REPORT_MARKER);
    expect(renderReport(scenario())).not.toContain(REPORT_MARKER);
  });

  it('puts the verdict in the heading and one row per metric in the table', () => {
    const text = renderReport(scenario());
    expect(text).toContain('## errorbar ❌ regression in support-bot › helpfulness');
    expect(text).toMatch(
      /\| `helpfulness` \| 0\.\d{3} \| 0\.\d{3} \| -0\.\d{3} \[-0\.\d{3}, -0\.\d{3}\] \| ❌ regression \|/,
    );
    expect(text).toContain('| `has_citation` |');
    expect(text).toContain('✓ no change');
  });

  it('explains what was left out and what the suite can detect', () => {
    const text = renderReport(scenario());
    expect(text).toContain('Dataset changes: support-bot');
    expect(text).toMatch(/detects drops ≥ \d\.\d\d at 80% power/);
    expect(text).toContain('baseline main@abcdef0');
  });

  it('shows plain scores when there is no baseline', () => {
    const head = makeResults([makeSuite({ cases: flatCases(20, 'm', () => [0.5, 0.5, 0.5]) })]);
    const text = renderReport(compare(null, head), { banner: 'First run.' });
    expect(text).toContain('## errorbar ℹ️ no baseline to compare with yet');
    expect(text).toContain('First run.');
    expect(text).toContain('| `m` | 0.500 |');
  });

  it('lets a recorded run say so instead of claiming there is no baseline', () => {
    const head = makeResults([makeSuite({ cases: flatCases(20, 'm', () => [0.5, 0.5, 0.5]) })]);
    const text = renderReport(compare(null, head), { headline: '📌 results recorded' });
    expect(text).toContain('## errorbar 📌 results recorded');
    expect(text).not.toContain('no baseline to compare with yet');
  });

  it('flags a broken run instead of showing numbers as a verdict', () => {
    const suite = makeSuite({ cases: flatCases(20, 'm', () => [0.5, 0.5, 0.5]), errored: 40 });
    const text = renderReport(compare(makeResults([suite]), makeResults([suite])));
    expect(text).toContain('🛑');
    expect(text).toContain('not a verdict');
  });

  it('stays under the comment size limit by dropping detail sections first', () => {
    const metrics = Array.from({ length: 40 }, (_, k) => `metric_${k}`);
    const mk = (drop: number) =>
      makeSuite({
        cases: Array.from({ length: 30 }, (_, i) => ({
          id: `c${i}`,
          output: 'x'.repeat(2000),
          scores: Object.fromEntries(
            metrics.map((m) => [
              m,
              [0.8 - drop + (i % 5) / 50, 0.8 - drop + (i % 5) / 50, 0.8 - drop + (i % 5) / 50],
            ]),
          ),
        })),
      });
    const text = renderReport(compare(makeResults([mk(0)]), makeResults([mk(0.3)])), {
      marker: true,
    });
    expect(text.length).toBeLessThanOrEqual(61_000);
    expect(text).toContain('| `metric_0` |');
    expect(text).toContain('left out to fit');
  });

  it('cannot be broken out of a code block by the model output', () => {
    const base = makeSuite({ cases: flatCases(30, 'm', () => [1, 1, 1]) });
    const head = makeSuite({
      cases: flatCases(30, 'm', () => [0, 0, 0]).map((c) => ({
        ...c,
        output: 'bad ``` ```` <script>alert(1)</script>',
      })),
    });
    const text = renderReport(compare(makeResults([base]), makeResults([head])));
    // The output is wrapped in a fence longer than any backtick run inside it.
    expect(text).toContain('`````text\nbad ``` ```` <script>');
  });
});

describe('formatting', () => {
  it('formats deltas with a sign and no negative zero', () => {
    expect(formatDelta(0.0123)).toBe('+0.012');
    expect(formatDelta(-0.08)).toBe('-0.080');
    expect(formatDelta(-0.0001)).toBe('0.000');
    expect(formatDelta(0)).toBe('0.000');
  });

  it('formats tokens and durations', () => {
    expect(formatTokens(950)).toBe('950');
    expect(formatTokens(1500)).toBe('1.5k');
    expect(formatTokens(182_400)).toBe('182k');
    expect(formatDuration(4200)).toBe('4.2s');
    expect(formatDuration(42_000)).toBe('42s');
    expect(formatDuration(72_000)).toBe('1m 12s');
  });
});
