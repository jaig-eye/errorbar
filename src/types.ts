// The shapes errorbar reads and writes. `ResultsFile` is the one thing that crosses runs:
// the base branch uploads it, a pull request downloads it and compares against it.

export const RESULTS_SCHEMA_VERSION = 1;

export interface GateSettings {
  /** Two-sided confidence level for the interval around each metric's change. */
  confidence: number;
  /** Largest drop (on the 0-1 score scale) that is acceptable. */
  max_drop: number;
  /** What an inconclusive metric does to the build. */
  on_inconclusive: 'warn' | 'fail' | 'pass';
  /** Bootstrap resamples. */
  bootstrap: number;
  /** Seed text, so the same inputs always give the same verdict. */
  seed: string;
  /** Fewer paired cases than this is never a verdict. */
  min_cases: number;
  /** Share of trials that may error before the run is reported as broken, not as a verdict. */
  max_error_rate: number;
  /** A case is flaky when its own trials differ by at least this much on a metric. */
  flaky_threshold: number;
}

export const DEFAULT_GATE: GateSettings = {
  confidence: 0.95,
  max_drop: 0.03,
  on_inconclusive: 'warn',
  bootstrap: 10_000,
  seed: 'errorbar',
  min_cases: 10,
  max_error_rate: 0.1,
  flaky_threshold: 0.5,
};

export interface Usage {
  calls: number;
  input_tokens: number;
  output_tokens: number;
  latency_ms: number;
}

export function emptyUsage(): Usage {
  return { calls: 0, input_tokens: 0, output_tokens: 0, latency_ms: 0 };
}

export function addUsage(into: Usage, more: Partial<Usage> | undefined): void {
  if (!more) return;
  into.calls += more.calls ?? 0;
  into.input_tokens += more.input_tokens ?? 0;
  into.output_tokens += more.output_tokens ?? 0;
  into.latency_ms += more.latency_ms ?? 0;
}

export interface MetricMeta {
  kind: string;
  /** Fingerprint of everything that decides what a score means (pattern, rubric, judge...). */
  config_hash: string;
  gate: boolean;
  max_drop?: number;
  judge_model?: string;
  judge_models?: string[];
}

export interface TrialResult {
  output?: string;
  /** One score in [0, 1] per metric. null means the metric did not apply or could not be graded. */
  scores: Record<string, number | null>;
  error?: string;
  metric_errors?: Record<string, string>;
  latency_ms?: number;
  /** Ids of retrieved contexts, in rank order. */
  context_ids?: string[];
}

export interface CaseResult {
  id: string;
  /** Fingerprint of the dataset row. A different value means the case was edited. */
  input_hash: string;
  /** Short human-readable version of the inputs, for reports. */
  input: string;
  trials: TrialResult[];
}

export interface SuiteResult {
  name: string;
  kind: 'prompt' | 'command' | 'import';
  /** Trials per case. */
  trials: number;
  /** Fingerprint of the target (prompt text, model, parameters, command). */
  config_hash: string;
  /** Model id as configured, when the target is a prompt. */
  target_model?: string;
  /** Model ids the provider reported back. Differs from `target_model` when aliases move. */
  models: string[];
  metrics: Record<string, MetricMeta>;
  cases: CaseResult[];
  usage: Usage;
  duration_ms: number;
  errors: { trials: number; errored: number };
}

export interface ResultsFile {
  schema: typeof RESULTS_SCHEMA_VERSION;
  tool: { name: 'errorbar'; version: string };
  created_at: string;
  git: { sha?: string; ref?: string };
  gate: GateSettings;
  suites: SuiteResult[];
}
