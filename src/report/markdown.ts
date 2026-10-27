import type {
  Comparison,
  FlakyCase,
  MetricRow,
  Mover,
  Overall,
  SuiteComparison,
} from '../compare/compare';
import { fenced, truncate } from '../util/text';

/** Hidden marker that lets the Action find and update its own pull request comment. */
export const REPORT_MARKER = '<!-- errorbar:report -->';

/** Marker for a comment with its own tag, so two jobs in one repository keep separate comments. */
export function reportMarker(tag?: string): string {
  return tag ? `<!-- errorbar:report:${tag} -->` : REPORT_MARKER;
}

/** GitHub rejects comments over 65,536 characters; stay well under. */
const MAX_CHARS = 60_000;

const ICON: Record<Overall, string> = {
  pass: '✅',
  warn: '⚠️',
  fail: '❌',
  error: '🛑',
  no_baseline: 'ℹ️',
};

export function formatScore(value: number): string {
  return value.toFixed(3);
}

export function formatDelta(value: number): string {
  const text = value.toFixed(3);
  if (/^-0\.0+$/.test(text) || /^0\.0+$/.test(text)) return '0.000';
  return value > 0 ? `+${text}` : text;
}

export function formatTokens(count: number): string {
  if (count < 1000) return `${count}`;
  return `${(count / 1000).toFixed(count >= 100_000 ? 0 : 1)}k`;
}

export function formatDuration(ms: number): string {
  const seconds = ms / 1000;
  if (seconds < 10) return `${seconds.toFixed(1)}s`;
  if (seconds < 60) return `${Math.round(seconds)}s`;
  return `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`;
}

function verdictCell(row: MetricRow): string {
  switch (row.verdict) {
    case 'regression':
      return '❌ regression';
    case 'improved':
      return '🟢 improved';
    case 'pass':
      return row.lo === 0 && row.hi === 0 ? '✓ no change' : '✓ within noise';
    case 'inconclusive':
      return '⚠️ inconclusive';
    case 'not_gated':
      return 'not gated';
    case 'not_comparable':
      return 'n/a';
  }
}

function metricName(name: string): string {
  return `\`${name.replace(/`/g, "'")}\``;
}

function comparedTable(rows: MetricRow[], confidence: number): string {
  const level = `${Math.round(confidence * 100)}%`;
  const lines = [
    `| metric | base | head | Δ (${level} CI) | verdict |`,
    '|---|---:|---:|---:|---|',
  ];
  for (const row of rows) {
    if (row.n === 0) {
      const head =
        row.head_mean > 0 || row.verdict === 'not_comparable' ? formatScore(row.head_mean) : '–';
      lines.push(`| ${metricName(row.metric)} | – | ${head} | – | ${verdictCell(row)} |`);
      continue;
    }
    const interval = `${formatDelta(row.delta)} [${formatDelta(row.lo)}, ${formatDelta(row.hi)}]`;
    lines.push(
      `| ${metricName(row.metric)} | ${formatScore(row.base_mean)} | ${formatScore(row.head_mean)} | ${interval} | ${verdictCell(row)} |`,
    );
  }
  return lines.join('\n');
}

function rowNotes(rows: MetricRow[]): string[] {
  const notes: string[] = [];
  for (const row of rows) {
    if (row.verdict === 'inconclusive' && row.gated && row.n > 0 && !row.note) {
      const needed =
        row.cases_needed === null ? '' : ` About ${row.cases_needed} cases would settle it.`;
      notes.push(
        `${metricName(row.metric)}: ${row.n} cases cannot rule out a drop of ${row.max_drop.toFixed(2)}.${needed}`,
      );
    } else if (row.note) {
      notes.push(`${metricName(row.metric)}: ${row.note}.`);
    }
  }
  return notes;
}

function footer(suite: SuiteComparison, comparison: Comparison): string {
  const parts: string[] = [];
  const trialsLabel =
    suite.status === 'compared'
      ? `${suite.paired_cases} paired cases × ${suite.trials.head} trial${suite.trials.head === 1 ? '' : 's'}`
      : `${suite.trials.head} trial${suite.trials.head === 1 ? '' : 's'} per case`;
  parts.push(trialsLabel);
  const gatedRows = suite.rows.filter((r) => r.gated && r.n > 0);
  if (gatedRows.length > 0) {
    const worst = Math.max(...gatedRows.map((r) => r.mde));
    if (Number.isFinite(worst)) {
      // An MDE that rounds to 0.00 means the cases never differed, not that any drop is detectable.
      parts.push(
        worst < 0.005
          ? 'no variation between runs to size the noise'
          : `detects drops ≥ ${worst.toFixed(2)} at 80% power`,
      );
    }
  }
  if (suite.flaky_cases > 0) {
    parts.push(`${suite.flaky_cases} flaky case${suite.flaky_cases === 1 ? '' : 's'}`);
  }
  const tokens = suite.usage.input_tokens + suite.usage.output_tokens;
  if (tokens > 0) parts.push(`${formatTokens(tokens)} tokens`);
  parts.push(formatDuration(suite.duration_ms));
  const baseline = comparison.baseline;
  if (suite.status === 'compared' && baseline?.sha) {
    parts.push(
      `baseline ${baseline.ref ? `${baseline.ref.replace(/^refs\/heads\//, '')}@` : ''}${baseline.sha.slice(0, 7)}`,
    );
  }
  return `<sub>${parts.join(' · ')}</sub>`;
}

function moversSection(suite: SuiteComparison): string[] {
  return Object.entries(suite.movers).map(([metric, movers]) => {
    const body = movers.map(renderMover).join('\n\n');
    return `<details><summary>Biggest drops: ${suite.name} › ${metric}</summary>\n\n${body}\n\n</details>`;
  });
}

function renderMover(mover: Mover): string {
  const input = truncate(mover.input.replace(/`/g, "'"), 200);
  const lines = [
    `**${mover.case_id}**: ${formatScore(mover.base_score)} → ${formatScore(mover.head_score)}`,
    '',
    `Input: \`${input}\``,
  ];
  if (mover.base_output !== undefined) {
    lines.push('', 'Before:', fenced(truncate(mover.base_output, 500)));
  }
  if (mover.head_output !== undefined) {
    lines.push('', 'After:', fenced(truncate(mover.head_output, 500)));
  }
  return lines.join('\n');
}

function listIds(label: string, ids: string[], limit = 20): string {
  const shown = ids
    .slice(0, limit)
    .map((id) => `\`${id}\``)
    .join(', ');
  const more = ids.length > limit ? `, and ${ids.length - limit} more` : '';
  return `- ${label} (${ids.length}): ${shown}${more}`;
}

function flakySection(suite: SuiteComparison): string[] {
  if (suite.flaky.length === 0) return [];
  const lines = suite.flaky
    .slice(0, 15)
    .map(
      (f: FlakyCase) =>
        `- \`${f.case_id}\` › ${metricName(f.metric)}: ${formatScore(f.min)} to ${formatScore(f.max)} across trials`,
    );
  const more = suite.flaky.length > 15 ? [`- …and ${suite.flaky.length - 15} more`] : [];
  return [
    `<details><summary>Flaky cases: ${suite.name} (${suite.flaky_cases})</summary>\n\nThese cases scored very differently from one trial to the next. Tightening their expected answers or rubric makes the gate more sensitive.\n\n${[...lines, ...more].join('\n')}\n\n</details>`,
  ];
}

function changesSection(suite: SuiteComparison): string[] {
  const items: string[] = [];
  if (suite.added.length > 0) items.push(listIds('Added', suite.added));
  if (suite.removed.length > 0) items.push(listIds('Removed', suite.removed));
  if (suite.edited.length > 0) items.push(listIds('Edited', suite.edited));
  if (items.length === 0) return [];
  return [
    `<details><summary>Dataset changes: ${suite.name}</summary>\n\nAdded, removed and edited cases are not compared, because they are not the same question on both sides.\n\n${items.join('\n')}\n\n</details>`,
  ];
}

function renderSuite(
  suite: SuiteComparison,
  comparison: Comparison,
): { main: string[]; details: string[] } {
  const main: string[] = [];
  main.push(`### ${suite.name}`);

  if (suite.errored) {
    main.push(
      `🛑 ${(suite.error_rate * 100).toFixed(0)}% of trials errored, over the allowed ${(comparison.gate.max_error_rate * 100).toFixed(0)}%. The scores below are not a verdict.`,
    );
  }
  if (suite.status === 'removed') {
    main.push('This suite is in the baseline but not in this run.');
    return { main, details: [] };
  }
  if (suite.status === 'new') {
    main.push(
      comparison.baseline
        ? 'New suite, nothing to compare with yet.'
        : "No baseline yet. These are this run's scores only.",
    );
  }

  if (suite.status === 'compared') {
    main.push(comparedTable(suite.rows, comparison.gate.confidence));
  } else {
    const lines = ['| metric | score |', '|---|---:|'];
    for (const row of suite.rows)
      lines.push(`| ${metricName(row.metric)} | ${formatScore(row.head_mean)} |`);
    main.push(lines.join('\n'));
  }

  const notes = [...rowNotes(suite.status === 'compared' ? suite.rows : []), ...suite.notes];
  if (notes.length > 0) main.push(notes.map((n) => `- ${n}`).join('\n'));
  main.push(footer(suite, comparison));

  return {
    main,
    details: [...moversSection(suite), ...flakySection(suite), ...changesSection(suite)],
  };
}

export interface RenderOptions {
  /** Include the hidden marker used to find the pull request comment again. */
  marker?: boolean;
  /** Distinguishes this report's comment from another job's. */
  tag?: string;
  /** Replaces the verdict text in the heading, for runs that are recorded rather than judged. */
  headline?: string;
  /** Extra Markdown placed under the heading, e.g. why there is no baseline yet. */
  banner?: string;
}

/** Turns a comparison into the Markdown shown in the pull request comment and job summary. */
export function renderReport(comparison: Comparison, options: RenderOptions = {}): string {
  const heading = `## errorbar ${options.headline ?? `${ICON[comparison.overall]} ${comparison.summary}`}`;
  const head: string[] = [];
  if (options.marker) head.push(reportMarker(options.tag));
  head.push(heading);
  if (options.banner) head.push(options.banner);

  const main: string[] = [];
  const details: string[] = [];
  for (const suite of comparison.suites) {
    const rendered = renderSuite(suite, comparison);
    main.push(...rendered.main);
    details.push(...rendered.details);
  }

  const join = (d: string[]) => [...head, ...main, ...d].join('\n\n');
  let kept = [...details];
  let text = join(kept);
  while (text.length > MAX_CHARS && kept.length > 0) {
    kept = kept.slice(0, -1);
    text = join(kept);
  }
  if (kept.length < details.length) {
    text = `${join(kept)}\n\n<sub>Some detail sections were left out to fit GitHub's comment size limit. The full report is in the job summary and the results artifact.</sub>`;
  }
  return `${text}\n`;
}
