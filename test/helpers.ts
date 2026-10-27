import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  DEFAULT_GATE,
  emptyUsage,
  type GateSettings,
  RESULTS_SCHEMA_VERSION,
  type ResultsFile,
  type SuiteResult,
} from '../src/types';

export interface CaseSpec {
  id: string;
  /** Trial scores per metric, e.g. { exact: [1, 1, 0] }. */
  scores: Record<string, Array<number | null>>;
  output?: string;
  /** Changing this makes the case look edited. */
  rev?: string;
}

export interface SuiteSpec {
  name?: string;
  cases: CaseSpec[];
  metricHash?: Record<string, string>;
  ungated?: string[];
  models?: string[];
  targetModel?: string;
  errored?: number;
  duration_ms?: number;
}

export function makeSuite(spec: SuiteSpec): SuiteResult {
  const metricNames = [...new Set(spec.cases.flatMap((c) => Object.keys(c.scores)))];
  const trials = Math.max(
    ...spec.cases.map((c) => Math.max(...Object.values(c.scores).map((s) => s.length))),
  );
  const total = spec.cases.length * trials;
  return {
    name: spec.name ?? 'suite',
    kind: 'prompt',
    trials,
    config_hash: 'target-hash',
    target_model: spec.targetModel,
    models: spec.models ?? [],
    metrics: Object.fromEntries(
      metricNames.map((name) => [
        name,
        {
          kind: 'test',
          config_hash: spec.metricHash?.[name] ?? `metric-${name}`,
          gate: !(spec.ungated ?? []).includes(name),
        },
      ]),
    ),
    cases: spec.cases.map((c) => ({
      id: c.id,
      input_hash: `hash-${c.id}-${c.rev ?? '1'}`,
      input: JSON.stringify({ q: c.id }),
      trials: Array.from({ length: trials }, (_, t) => ({
        output: c.output ?? `output ${c.id} ${t}`,
        scores: Object.fromEntries(metricNames.map((m) => [m, c.scores[m]?.[t] ?? null])),
      })),
    })),
    usage: { ...emptyUsage(), calls: total, input_tokens: 1200, output_tokens: 300 },
    duration_ms: spec.duration_ms ?? 4200,
    errors: { trials: total, errored: spec.errored ?? 0 },
  };
}

export function makeResults(
  suites: SuiteResult[],
  gate: Partial<GateSettings> = {},
  git: ResultsFile['git'] = { sha: '0123456789abcdef', ref: 'refs/heads/main' },
): ResultsFile {
  return {
    schema: RESULTS_SCHEMA_VERSION,
    tool: { name: 'errorbar', version: 'test' },
    created_at: '2026-10-26T12:00:00.000Z',
    git,
    gate: { ...DEFAULT_GATE, bootstrap: 2000, ...gate },
    suites,
  };
}

/** n cases whose single-metric trials all score `value`, for building simple scenarios. */
export function flatCases(
  n: number,
  metric: string,
  value: (i: number) => number[],
  prefix = 'c',
): CaseSpec[] {
  return Array.from({ length: n }, (_, i) => ({
    id: `${prefix}${i + 1}`,
    scores: { [metric]: value(i) },
  }));
}

export function tempDir(prefix = 'errorbar-'): string {
  return mkdtempSync(path.join(os.tmpdir(), prefix));
}

export function writeFiles(dir: string, files: Record<string, string>): void {
  for (const [name, content] of Object.entries(files)) {
    const target = path.join(dir, name);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
}

/** Narrows a possibly-missing value, failing the test with a clear message instead of a TypeError. */
export function must<T>(value: T | undefined | null, what = 'value'): T {
  if (value === undefined || value === null) throw new Error(`expected ${what} to exist`);
  return value;
}
