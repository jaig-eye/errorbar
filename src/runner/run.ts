import path from 'node:path';
import { resolveFrom } from '../config/load';
import { requiredSecrets, targetProvider } from '../config/resolve';
import type { Config, LoadedConfig, SuiteConfig } from '../config/types';
import { type DatasetRow, loadDataset, rowHash, rowInput } from '../dataset';
import { BudgetExceededError, ConfigError, MissingSecretError } from '../errors';
import { buildMetrics } from '../metrics';
import type { Metric } from '../metrics/types';
import { createProvider, type ProviderDeps } from '../providers';
import { CallBudget } from '../providers/budget';
import type { HttpDeps } from '../providers/http';
import { importFile } from '../results/import';
import { createCommandTarget } from '../targets/command';
import { createPromptTarget } from '../targets/prompt';
import type { Target, TargetResponse } from '../targets/types';
import {
  addUsage,
  type CaseResult,
  DEFAULT_GATE,
  emptyUsage,
  type GateSettings,
  RESULTS_SCHEMA_VERSION,
  type ResultsFile,
  type SuiteResult,
  type TrialResult,
} from '../types';
import { mapPool } from '../util/pool';
import { compilePatterns, errorMessage, redact, truncate } from '../util/text';
import { VERSION } from '../version';

const MAX_STORED_OUTPUT = 4000;
const MAX_STORED_ERROR = 300;

export interface RunOptions {
  loaded: LoadedConfig;
  env?: NodeJS.ProcessEnv;
  /** Run only the suite with this name. */
  suite?: string;
  /** Overrides the number of trials per case. */
  trials?: number;
  log?: (message: string) => void;
  http?: Partial<HttpDeps>;
  git?: ResultsFile['git'];
  now?: () => Date;
}

interface SuiteContext {
  loaded: LoadedConfig;
  config: Config;
  gate: GateSettings;
  providerDeps: ProviderDeps;
  redactors: RegExp[];
  trialsOverride?: number;
  log: (message: string) => void;
}

function buildTarget(suite: SuiteConfig, rows: DatasetRow[], ctx: SuiteContext): Target {
  const target = suite.target;
  if (target?.type === 'command') {
    return createCommandTarget({
      config: target,
      cwd: resolveFrom(ctx.loaded, target.cwd ?? '.'),
    });
  }
  if (target?.type === 'prompt') {
    const provider = targetProvider(suite, ctx.config);
    if (!provider) throw new ConfigError(`suite "${suite.name}" has no provider`);
    return createPromptTarget({
      config: target,
      provider,
      promptPath: resolveFrom(ctx.loaded, target.prompt),
      systemPath: target.system ? resolveFrom(ctx.loaded, target.system) : undefined,
      rows,
      client: createProvider(provider, ctx.providerDeps),
    });
  }
  throw new ConfigError(`suite "${suite.name}" has no target`);
}

function scoreOf(value: number | null): number | null {
  if (value === null || !Number.isFinite(value)) return null;
  return Math.min(1, Math.max(0, value));
}

async function runTrial(
  row: DatasetRow,
  trial: number,
  target: Target,
  metrics: Metric[],
  ctx: SuiteContext,
  respond: (response: TargetResponse) => void,
): Promise<TrialResult> {
  const result: TrialResult = { scores: {} };
  let response: TargetResponse;
  try {
    response = await target.run({ row, trial });
  } catch (error) {
    for (const metric of metrics) result.scores[metric.name] = null;
    result.error = redact(truncate(errorMessage(error), MAX_STORED_ERROR), ctx.redactors);
    return result;
  }
  respond(response);

  result.output = redact(truncate(response.output, MAX_STORED_OUTPUT), ctx.redactors);
  result.latency_ms = Math.round(response.latency_ms);
  if (response.contexts) result.context_ids = response.contexts.map((c) => c.id);

  for (const metric of metrics) {
    try {
      result.scores[metric.name] = scoreOf(
        await metric.score({ row, output: response.output, trial, contexts: response.contexts }),
      );
    } catch (error) {
      result.scores[metric.name] = null;
      result.metric_errors ??= {};
      result.metric_errors[metric.name] = redact(
        truncate(errorMessage(error), MAX_STORED_ERROR),
        ctx.redactors,
      );
    }
  }
  return result;
}

async function runSuite(suite: SuiteConfig, ctx: SuiteContext): Promise<SuiteResult> {
  const started = performance.now();
  const rows = loadDataset(resolveFrom(ctx.loaded, suite.dataset as string));
  const trials = ctx.trialsOverride ?? suite.trials ?? ctx.config.defaults?.trials ?? 3;
  const concurrency = suite.concurrency ?? ctx.config.defaults?.concurrency ?? 4;

  const judgeUsage = emptyUsage();
  const judgeModels = new Map<string, Set<string>>();
  const metrics = buildMetrics(suite, ctx.config, {
    createJudge: (cfg) => createProvider(cfg, ctx.providerDeps),
    onJudgeUse: (name, completion) => {
      addUsage(judgeUsage, {
        calls: 1,
        input_tokens: completion.usage.input_tokens,
        output_tokens: completion.usage.output_tokens,
        latency_ms: completion.latency_ms,
      });
      const seen = judgeModels.get(name) ?? new Set<string>();
      seen.add(completion.model);
      judgeModels.set(name, seen);
    },
  });
  const target = buildTarget(suite, rows, ctx);

  const targetUsage = emptyUsage();
  const models = new Set<string>();
  const tasks = rows.flatMap((row) =>
    Array.from({ length: trials }, (_, trial) => ({ row, trial })),
  );
  ctx.log(`${suite.name}: ${rows.length} cases × ${trials} trials`);

  let done = 0;
  let nextReport = 0.25;
  let outcomes: Array<TrialResult | undefined>;
  try {
    outcomes = await mapPool(
      tasks,
      concurrency,
      async ({ row, trial }) => {
        const result = await runTrial(row, trial, target, metrics, ctx, (response) => {
          addUsage(targetUsage, response.usage);
          if (response.model) models.add(response.model);
        });
        done++;
        if (done / tasks.length >= nextReport && done < tasks.length) {
          ctx.log(`${suite.name}: ${done}/${tasks.length} trials`);
          nextReport += 0.25;
        }
        return result;
      },
      () => ctx.providerDeps.budget.exceeded,
    );
  } finally {
    await target.close();
  }
  if (ctx.providerDeps.budget.exceeded) {
    throw new BudgetExceededError(ctx.providerDeps.budget.max as number);
  }

  const cases: CaseResult[] = rows.map((row, i) => ({
    id: row.id,
    input_hash: rowHash(row),
    input: redact(rowInput(row), ctx.redactors),
    trials: outcomes.slice(i * trials, (i + 1) * trials) as TrialResult[],
  }));
  const allTrials = cases.flatMap((c) => c.trials);
  const errored = allTrials.filter((t) => t.error || t.metric_errors).length;

  const usage = emptyUsage();
  addUsage(usage, targetUsage);
  addUsage(usage, judgeUsage);

  return {
    name: suite.name,
    kind: target.kind,
    trials,
    config_hash: target.configHash,
    target_model: target.targetModel,
    models: [...models].sort(),
    metrics: Object.fromEntries(
      metrics.map((metric) => [
        metric.name,
        {
          ...metric.meta,
          judge_models: judgeModels.has(metric.name)
            ? [...(judgeModels.get(metric.name) as Set<string>)].sort()
            : undefined,
        },
      ]),
    ),
    cases,
    usage,
    duration_ms: Math.round(performance.now() - started),
    errors: { trials: allTrials.length, errored },
  };
}

/** Runs every suite in a config and returns the results file. */
export async function runConfig(options: RunOptions): Promise<ResultsFile> {
  const { loaded } = options;
  const { config } = loaded;
  const env = options.env ?? process.env;
  const log = options.log ?? (() => {});
  const gate: GateSettings = { ...DEFAULT_GATE, ...config.gate };

  const suites = config.suites.filter((s) => !options.suite || s.name === options.suite);
  if (suites.length === 0) {
    throw new ConfigError(
      `No suite named "${options.suite}". Suites in ${path.basename(loaded.path)}: ${config.suites.map((s) => s.name).join(', ')}`,
    );
  }

  const missing = requiredSecrets({ ...config, suites }, env);
  if (missing.length > 0) throw new MissingSecretError(missing);

  const ctx: SuiteContext = {
    loaded,
    config,
    gate,
    providerDeps: {
      env,
      budget: new CallBudget(config.max_calls),
      seed: gate.seed,
      http: options.http,
    },
    redactors: compilePatterns(config.redact ?? [], 'redact'),
    trialsOverride: options.trials,
    log,
  };

  const results: SuiteResult[] = [];
  for (const suite of suites) {
    if (suite.results !== undefined) {
      log(`${suite.name}: importing ${suite.results}`);
      results.push(importFile(resolveFrom(loaded, suite.results), suite.name));
    } else {
      results.push(await runSuite(suite, ctx));
    }
  }

  return {
    schema: RESULTS_SCHEMA_VERSION,
    tool: { name: 'errorbar', version: VERSION },
    created_at: (options.now?.() ?? new Date()).toISOString(),
    git: options.git ?? {},
    gate,
    suites: results,
  };
}
