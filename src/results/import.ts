import { readFileSync } from 'node:fs';
import { ConfigError } from '../errors';
import type { CaseResult, SuiteResult, TrialResult } from '../types';
import { emptyUsage } from '../types';
import { shortHash } from '../util/hash';
import { errorMessage, truncate } from '../util/text';

interface Line {
  case_id: string;
  trial: number;
  metric: string;
  score: number;
  input_hash?: string;
  input?: string;
  output?: string;
}

function parseLine(text: string, where: string): Line {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${where}: not valid JSON (${errorMessage(error)})`);
  }
  const obj = raw as Record<string, unknown> | null;
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new ConfigError(`${where}: each line must be a JSON object`);
  }
  if (typeof obj.case_id !== 'string' || obj.case_id.length === 0) {
    throw new ConfigError(`${where}: \`case_id\` must be a non-empty string`);
  }
  if (typeof obj.metric !== 'string' || obj.metric.length === 0) {
    throw new ConfigError(`${where}: \`metric\` must be a non-empty string`);
  }
  if (
    typeof obj.score !== 'number' ||
    !Number.isFinite(obj.score) ||
    obj.score < 0 ||
    obj.score > 1
  ) {
    throw new ConfigError(`${where}: \`score\` must be a number from 0 to 1 (rescale it first)`);
  }
  const trial = obj.trial === undefined ? 0 : obj.trial;
  if (typeof trial !== 'number' || !Number.isInteger(trial) || trial < 0) {
    throw new ConfigError(`${where}: \`trial\` must be a non-negative integer`);
  }
  for (const key of ['input_hash', 'input', 'output'] as const) {
    if (obj[key] !== undefined && typeof obj[key] !== 'string') {
      throw new ConfigError(`${where}: \`${key}\` must be a string`);
    }
  }
  return {
    case_id: obj.case_id,
    trial,
    metric: obj.metric,
    score: obj.score,
    input_hash: obj.input_hash as string | undefined,
    input: obj.input as string | undefined,
    output: obj.output as string | undefined,
  };
}

/**
 * Turns scores produced by another tool into a suite errorbar can compare and gate.
 * One JSON object per line: {"case_id", "metric", "score" (0-1), "trial"?, "input_hash"?, "input"?, "output"?}.
 * Give an `input_hash` that changes when the case's question or reference changes, and cases
 * edited between runs are left out of the comparison instead of being counted as a drop.
 */
export function importJsonl(text: string, options: { suite: string; source: string }): SuiteResult {
  const cases = new Map<
    string,
    { input_hash?: string; input?: string; trials: Map<number, TrialResult> }
  >();
  const metrics = new Set<string>();

  text.split(/\r?\n/).forEach((raw, index) => {
    if (raw.trim().length === 0) return;
    const line = parseLine(raw, `${options.source}:${index + 1}`);
    metrics.add(line.metric);
    const entry = cases.get(line.case_id) ?? { trials: new Map<number, TrialResult>() };
    entry.input_hash ??= line.input_hash;
    entry.input ??= line.input;
    const trial = entry.trials.get(line.trial) ?? { scores: {} };
    trial.scores[line.metric] = line.score;
    if (line.output !== undefined) trial.output = truncate(line.output, 4000);
    entry.trials.set(line.trial, trial);
    cases.set(line.case_id, entry);
  });

  if (cases.size === 0) throw new ConfigError(`${options.source}: no scores found`);

  const metricNames = [...metrics].sort();
  const caseResults: CaseResult[] = [...cases].map(([id, entry]) => ({
    id,
    input_hash: entry.input_hash ?? shortHash(id),
    input: entry.input ?? '',
    trials: [...entry.trials]
      .sort(([a], [b]) => a - b)
      .map(([, trial]) => {
        for (const name of metricNames) trial.scores[name] ??= null;
        return trial;
      }),
  }));

  return {
    name: options.suite,
    kind: 'import',
    trials: Math.max(...caseResults.map((c) => c.trials.length)),
    config_hash: shortHash({ kind: 'import' }),
    models: [],
    metrics: Object.fromEntries(
      metricNames.map((name) => [name, { kind: 'imported', config_hash: 'imported', gate: true }]),
    ),
    cases: caseResults,
    usage: emptyUsage(),
    duration_ms: 0,
    errors: { trials: caseResults.reduce((n, c) => n + c.trials.length, 0), errored: 0 },
  };
}

export function importFile(file: string, suite: string): SuiteResult {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  return importJsonl(text, { suite, source: file });
}
