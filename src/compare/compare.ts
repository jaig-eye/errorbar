import { mean, pairedBootstrap } from '../stats/bootstrap';
import {
  type CaseResult,
  DEFAULT_GATE,
  type GateSettings,
  type MetricMeta,
  type ResultsFile,
  type SuiteResult,
  type Usage,
} from '../types';
import { evaluateFamily, type TestInput, type Verdict } from './verdict';

export type RowVerdict = Verdict | 'not_gated' | 'not_comparable';

export interface MetricRow {
  suite: string;
  metric: string;
  gated: boolean;
  verdict: RowVerdict;
  /** Paired cases that went into this row. */
  n: number;
  base_mean: number;
  head_mean: number;
  delta: number;
  lo: number;
  hi: number;
  /** Smallest change these cases can detect at 80% power. */
  mde: number;
  /** Cases needed to detect a drop of `max_drop`. null when that cannot be computed. */
  cases_needed: number | null;
  adj_p: number | null;
  max_drop: number;
  note?: string;
}

export interface Mover {
  case_id: string;
  input: string;
  base_score: number;
  head_score: number;
  base_output?: string;
  head_output?: string;
}

export interface FlakyCase {
  case_id: string;
  metric: string;
  min: number;
  max: number;
}

export interface SuiteComparison {
  name: string;
  status: 'compared' | 'new' | 'removed';
  paired_cases: number;
  trials: { base: number; head: number };
  rows: MetricRow[];
  /** Worst per-case drops, by metric, for metrics that regressed or could not be ruled out. */
  movers: Record<string, Mover[]>;
  added: string[];
  removed: string[];
  edited: string[];
  flaky: FlakyCase[];
  flaky_cases: number;
  usage: Usage;
  duration_ms: number;
  error_rate: number;
  errored: boolean;
  notes: string[];
}

export type Overall = 'pass' | 'warn' | 'fail' | 'error' | 'no_baseline';

export interface Comparison {
  overall: Overall;
  summary: string;
  gate: GateSettings;
  baseline: { sha?: string; ref?: string; created_at: string } | null;
  head: { sha?: string; ref?: string; created_at: string };
  suites: SuiteComparison[];
}

const MOVERS_PER_METRIC = 3;

function caseScore(result: CaseResult, metric: string): number | undefined {
  const scores = result.trials
    .map((trial) => trial.scores[metric])
    .filter((score): score is number => typeof score === 'number');
  return scores.length > 0 ? mean(scores) : undefined;
}

/** Mean score of a metric over every case of a suite that has one. */
function meanScore(suite: SuiteResult, metric: string): number {
  const scores = suite.cases
    .map((result) => caseScore(result, metric))
    .filter((score): score is number => score !== undefined);
  return scores.length > 0 ? mean(scores) : 0;
}

function firstOutput(result: CaseResult): string | undefined {
  return result.trials.find((trial) => typeof trial.output === 'string')?.output;
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  return a.length === b.length && [...a].sort().join('\u0000') === [...b].sort().join('\u0000');
}

function describeModels(models: readonly string[]): string {
  return models.join(', ');
}

function targetDrift(base: SuiteResult, head: SuiteResult): string | null {
  if (!base.target_model || base.target_model !== head.target_model) return null;
  if (base.models.length === 0 || head.models.length === 0) return null;
  if (sameSet(base.models, head.models)) return null;
  return `the model behind \`${head.target_model}\` changed (${describeModels(base.models)} → ${describeModels(head.models)})`;
}

function judgeDrift(base: MetricMeta, head: MetricMeta): string | null {
  const baseModels = base.judge_models ?? [];
  const headModels = head.judge_models ?? [];
  if (!base.judge_model || base.judge_model !== head.judge_model) return null;
  if (baseModels.length === 0 || headModels.length === 0 || sameSet(baseModels, headModels)) {
    return null;
  }
  return `the judge model behind \`${head.judge_model}\` changed (${describeModels(baseModels)} → ${describeModels(headModels)})`;
}

function flakyCases(suite: SuiteResult, gate: GateSettings): FlakyCase[] {
  const found: FlakyCase[] = [];
  const gatedMetrics = Object.entries(suite.metrics).filter(([, meta]) => meta.gate);
  for (const result of suite.cases) {
    for (const [metric] of gatedMetrics) {
      const scores = result.trials
        .map((trial) => trial.scores[metric])
        .filter((score): score is number => typeof score === 'number');
      if (scores.length < 2) continue;
      const min = Math.min(...scores);
      const max = Math.max(...scores);
      if (max - min >= gate.flaky_threshold) found.push({ case_id: result.id, metric, min, max });
    }
  }
  return found;
}

interface Pending {
  suite: SuiteComparison;
  row: MetricRow;
  input: TestInput;
  drift: string | null;
  paired: Array<{ base: CaseResult; head: CaseResult; baseScore: number; headScore: number }>;
}

function blankRow(suite: string, metric: string, meta: MetricMeta, gate: GateSettings): MetricRow {
  return {
    suite,
    metric,
    gated: meta.gate,
    verdict: meta.gate ? 'inconclusive' : 'not_gated',
    n: 0,
    base_mean: 0,
    head_mean: 0,
    delta: 0,
    lo: 0,
    hi: 0,
    mde: 0,
    cases_needed: null,
    adj_p: null,
    max_drop: meta.max_drop ?? gate.max_drop,
  };
}

function baseSuiteComparison(head: SuiteResult, gate: GateSettings): SuiteComparison {
  const flaky = flakyCases(head, gate);
  return {
    name: head.name,
    status: 'new',
    paired_cases: 0,
    trials: { base: 0, head: head.trials },
    rows: [],
    movers: {},
    added: [],
    removed: [],
    edited: [],
    flaky,
    flaky_cases: new Set(flaky.map((f) => f.case_id)).size,
    usage: head.usage,
    duration_ms: head.duration_ms,
    error_rate: head.errors.trials > 0 ? head.errors.errored / head.errors.trials : 0,
    errored: false,
    notes: [],
  };
}

function headOnlyRows(head: SuiteResult, gate: GateSettings, note: string): MetricRow[] {
  return Object.entries(head.metrics).map(([metric, meta]) => ({
    ...blankRow(head.name, metric, meta, gate),
    verdict: 'not_comparable' as const,
    head_mean: meanScore(head, metric),
    note,
  }));
}

function pairSuite(
  base: SuiteResult,
  head: SuiteResult,
  gate: GateSettings,
  pending: Pending[],
): SuiteComparison {
  const suite = baseSuiteComparison(head, gate);
  suite.status = 'compared';
  suite.trials.base = base.trials;

  const baseCases = new Map(base.cases.map((result) => [result.id, result]));
  const headIds = new Set(head.cases.map((result) => result.id));
  const pairedCases: Array<{ base: CaseResult; head: CaseResult }> = [];
  for (const result of head.cases) {
    const before = baseCases.get(result.id);
    if (!before) suite.added.push(result.id);
    else if (before.input_hash !== result.input_hash) suite.edited.push(result.id);
    else pairedCases.push({ base: before, head: result });
  }
  suite.removed = base.cases.filter((result) => !headIds.has(result.id)).map((result) => result.id);
  suite.paired_cases = pairedCases.length;

  const drift = targetDrift(base, head);
  if (drift) suite.notes.push(`Regressions are not attributed to this change: ${drift}.`);
  if (head.trials < 2) {
    suite.notes.push(
      'trials is 1, so run-to-run noise cannot be measured. That is fine for a pipeline that never varies; use 3 or more for anything that samples a model.',
    );
  }

  for (const [metric, meta] of Object.entries(head.metrics)) {
    const baseMeta = base.metrics[metric];
    const row = blankRow(head.name, metric, meta, gate);
    suite.rows.push(row);

    if (!baseMeta) {
      row.verdict = 'not_comparable';
      row.head_mean = meanScore(head, metric);
      row.note = 'new metric, nothing to compare with';
      continue;
    }
    if (baseMeta.config_hash !== meta.config_hash) {
      row.verdict = 'not_comparable';
      row.head_mean = meanScore(head, metric);
      row.note = 'the metric definition changed, so scores are not comparable';
      continue;
    }

    const paired: Pending['paired'] = [];
    for (const { base: b, head: h } of pairedCases) {
      const baseScore = caseScore(b, metric);
      const headScore = caseScore(h, metric);
      if (baseScore !== undefined && headScore !== undefined) {
        paired.push({ base: b, head: h, baseScore, headScore });
      }
    }
    row.n = paired.length;
    if (paired.length === 0) {
      row.note = 'no paired cases with a score';
      continue;
    }

    const input: TestInput = {
      key: `${head.name}:${metric}`,
      base: paired.map((p) => p.baseScore),
      head: paired.map((p) => p.headScore),
      max_drop: row.max_drop,
    };
    row.base_mean = mean(input.base);
    row.head_mean = mean(input.head);
    row.delta = row.head_mean - row.base_mean;

    if (!meta.gate) {
      const stat = pairedBootstrap(
        input.head.map((value, i) => value - (input.base[i] as number)),
        {
          resamples: gate.bootstrap,
          confidence: gate.confidence,
          seed: `${gate.seed}:${input.key}`,
        },
      );
      row.lo = stat.lo;
      row.hi = stat.hi;
      continue;
    }

    pending.push({
      suite,
      row,
      input,
      paired,
      drift: judgeDrift(baseMeta, meta) ?? drift,
    });
  }
  return suite;
}

function fillMovers(item: Pending): void {
  if (item.row.verdict !== 'regression' && item.row.verdict !== 'inconclusive') return;
  const worst = item.paired
    .map((p) => ({ ...p, delta: p.headScore - p.baseScore }))
    .filter((p) => p.delta < 0)
    .sort((a, b) => a.delta - b.delta)
    .slice(0, MOVERS_PER_METRIC);
  if (worst.length === 0) return;
  item.suite.movers[item.row.metric] = worst.map((p) => ({
    case_id: p.head.id,
    input: p.head.input,
    base_score: p.baseScore,
    head_score: p.headScore,
    base_output: firstOutput(p.base),
    head_output: firstOutput(p.head),
  }));
}

function summarise(overall: Overall, suites: SuiteComparison[]): string {
  const rows = suites.flatMap((s) => s.rows);
  const label = (r: MetricRow) => `${r.suite} › ${r.metric}`;
  const regressions = rows.filter((r) => r.verdict === 'regression').map(label);
  const inconclusive = rows.filter((r) => r.verdict === 'inconclusive' && r.gated).map(label);
  const broken = suites.filter((s) => s.errored).map((s) => s.name);
  switch (overall) {
    case 'error':
      return `too many errored trials in ${broken.join(', ')}; this is a broken run, not a quality verdict`;
    case 'fail':
      return regressions.length > 0
        ? `regression in ${regressions.join(', ')}`
        : `inconclusive in ${inconclusive.join(', ')}`;
    case 'warn':
      return `no regression found, but ${inconclusive.join(', ')} could not be ruled out`;
    case 'no_baseline':
      return 'no baseline to compare with yet';
    default:
      return 'no regression';
  }
}

/** Compares a run against a baseline and decides what it means for the build. */
export function compare(
  base: ResultsFile | null,
  head: ResultsFile,
  overrides: Partial<GateSettings> = {},
): Comparison {
  const gate: GateSettings = { ...DEFAULT_GATE, ...head.gate, ...overrides };
  const pending: Pending[] = [];
  const suites: SuiteComparison[] = [];

  for (const headSuite of head.suites) {
    const baseSuite = base?.suites.find((s) => s.name === headSuite.name);
    if (baseSuite) {
      suites.push(pairSuite(baseSuite, headSuite, gate, pending));
    } else {
      const suite = baseSuiteComparison(headSuite, gate);
      suite.rows = headOnlyRows(
        headSuite,
        gate,
        base ? 'new suite, nothing to compare with' : 'no baseline yet',
      );
      suites.push(suite);
    }
  }
  for (const baseSuite of base?.suites ?? []) {
    if (!head.suites.some((s) => s.name === baseSuite.name)) {
      const removed = baseSuiteComparison(baseSuite, gate);
      removed.status = 'removed';
      removed.trials = { base: baseSuite.trials, head: 0 };
      removed.flaky = [];
      removed.flaky_cases = 0;
      suites.push(removed);
    }
  }

  const results = evaluateFamily(
    pending.map((p) => p.input),
    gate,
  );
  pending.forEach((item, i) => {
    const out = results[i];
    if (!out) return;
    item.row.lo = out.stat.lo;
    item.row.hi = out.stat.hi;
    item.row.mde = out.mde;
    item.row.cases_needed = out.cases_needed;
    item.row.adj_p = out.adj_p;
    item.row.verdict = out.verdict;
    if (out.verdict === 'regression' && item.drift) {
      item.row.verdict = 'inconclusive';
      item.row.note = `looks like a regression, but ${item.drift}`;
    } else if (out.stat.n < gate.min_cases) {
      item.row.note = `only ${out.stat.n} paired cases; at least ${gate.min_cases} are needed for a verdict`;
    }
    fillMovers(item);
  });

  for (const suite of suites) {
    suite.errored = suite.status !== 'removed' && suite.error_rate > gate.max_error_rate;
  }

  const rows = suites.flatMap((s) => s.rows);
  const hasRegression = rows.some((r) => r.verdict === 'regression');
  const hasInconclusive = rows.some((r) => r.gated && r.verdict === 'inconclusive');
  let overall: Overall;
  if (suites.some((s) => s.errored)) overall = 'error';
  else if (hasRegression) overall = 'fail';
  else if (!base) overall = 'no_baseline';
  else if (hasInconclusive && gate.on_inconclusive === 'fail') overall = 'fail';
  else if (hasInconclusive && gate.on_inconclusive === 'warn') overall = 'warn';
  else overall = 'pass';

  return {
    overall,
    summary: summarise(overall, suites),
    gate,
    baseline: base ? { ...base.git, created_at: base.created_at } : null,
    head: { ...head.git, created_at: head.created_at },
    suites,
  };
}
