import { metricName } from '../config/load';
import { isJudgeMetric, judgeProvider } from '../config/resolve';
import type { Config, MetricConfig, ProviderConfig, SuiteConfig } from '../config/types';
import type { Provider } from '../providers/types';
import { shortHash } from '../util/hash';
import { deterministicScorer } from './deterministic';
import {
  buildJudgePrompt,
  JudgeParseError,
  normaliseScore,
  PRESET_RUBRICS,
  parseJudgeReply,
} from './judge';
import { retrievalScorer } from './retrieval';
import type { JudgeUse, Metric } from './types';

export interface MetricDeps {
  /** Builds the provider for a judge. The runner passes one that counts calls. */
  createJudge: (config: ProviderConfig) => Provider;
  onJudgeUse: JudgeUse;
}

/** The judge defaults to temperature 0 so a verdict does not wobble on its own. */
function judgeConfig(config: ProviderConfig): ProviderConfig {
  return {
    ...config,
    temperature: config.temperature === undefined ? 0 : config.temperature,
    max_tokens: config.max_tokens ?? 600,
  };
}

function definitionHash(config: MetricConfig, extra: Record<string, unknown> = {}): string {
  const { name: _name, gate: _gate, max_drop: _maxDrop, ...definition } = config;
  return shortHash({ ...definition, ...extra });
}

function buildJudgeMetric(
  config: MetricConfig & { type: 'rubric' | 'faithfulness' | 'answer_relevance' },
  name: string,
  provider: ProviderConfig,
  deps: MetricDeps,
): Metric {
  const rubric = config.type === 'rubric' ? config.rubric : PRESET_RUBRICS[config.type];
  const scale = config.scale ?? 5;
  const judgeCfg = judgeConfig(provider);
  const judge = deps.createJudge(judgeCfg);

  return {
    name,
    meta: {
      kind: config.type,
      config_hash: shortHash({
        type: config.type,
        rubric,
        scale,
        judge: {
          type: judgeCfg.type,
          model: judgeCfg.model,
          temperature: judgeCfg.temperature,
          base_url: judgeCfg.base_url,
        },
      }),
      gate: config.gate !== false,
      max_drop: config.max_drop,
      judge_model: judgeCfg.model,
    },
    async score(input) {
      if (config.type === 'faithfulness' && !input.contexts) {
        throw new Error('faithfulness needs retrieved `contexts` from the target');
      }
      let reminder: string | undefined;
      let lastError: JudgeParseError | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const { system, prompt } = buildJudgePrompt({
          rubric,
          scale,
          row: input.row,
          output: input.output,
          contexts: input.contexts,
          reminder,
        });
        const completion = await judge.complete({
          system,
          prompt,
          meta: { role: 'judge', row: input.row, trial: input.trial, candidate: input.output },
        });
        deps.onJudgeUse(name, completion);
        try {
          return normaliseScore(parseJudgeReply(completion.text, scale), scale);
        } catch (error) {
          if (!(error instanceof JudgeParseError)) throw error;
          lastError = error;
          reminder = `Your previous reply was rejected: ${error.message}. Reply with only the JSON object.`;
        }
      }
      throw lastError ?? new JudgeParseError('the judge reply could not be read');
    },
  };
}

/** Builds every metric of a suite. Judge providers are created here, so missing keys fail early. */
export function buildMetrics(suite: SuiteConfig, config: Config, deps: MetricDeps): Metric[] {
  return (suite.metrics ?? []).map((metric): Metric => {
    const name = metricName(metric);

    if (isJudgeMetric(metric)) {
      const provider = judgeProvider(metric, suite, config) as ProviderConfig;
      return buildJudgeMetric(
        metric as MetricConfig & { type: 'rubric' | 'faithfulness' | 'answer_relevance' },
        name,
        provider,
        deps,
      );
    }

    const scorer = deterministicScorer(metric) ?? retrievalScorer(metric);
    if (!scorer) throw new Error(`Unknown metric type "${metric.type}"`);
    return {
      name,
      meta: {
        kind: metric.type,
        config_hash: definitionHash(metric),
        gate: metric.gate !== false,
        max_drop: metric.max_drop,
      },
      async score(input) {
        return scorer(input);
      },
    };
  });
}
