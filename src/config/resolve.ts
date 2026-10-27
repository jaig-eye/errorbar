import type {
  Config,
  MetricConfig,
  PromptTargetConfig,
  ProviderConfig,
  SuiteConfig,
} from './types';

/** The provider a prompt target talks to: its own, or the default. */
export function targetProvider(suite: SuiteConfig, config: Config): ProviderConfig | undefined {
  if (suite.target?.type !== 'prompt') return undefined;
  return (suite.target as PromptTargetConfig).provider ?? config.defaults?.provider;
}

/**
 * The judge a rubric metric uses: its own, the default judge, the target's provider, or the
 * default provider. A command target has no provider of its own, hence the last fallback.
 */
export function judgeProvider(
  metric: MetricConfig,
  suite: SuiteConfig,
  config: Config,
): ProviderConfig | undefined {
  if (
    metric.type !== 'rubric' &&
    metric.type !== 'faithfulness' &&
    metric.type !== 'answer_relevance'
  ) {
    return undefined;
  }
  return (
    metric.judge ??
    config.defaults?.judge ??
    targetProvider(suite, config) ??
    config.defaults?.provider
  );
}

export function isJudgeMetric(metric: MetricConfig): boolean {
  return (
    metric.type === 'rubric' || metric.type === 'faithfulness' || metric.type === 'answer_relevance'
  );
}

export interface KeyRequirement {
  /** Environment variable that holds the key. */
  variable: string;
  /** False for local OpenAI-compatible servers, which usually need no key. */
  required: boolean;
}

export function keyRequirement(provider: ProviderConfig): KeyRequirement | null {
  if (provider.type === 'mock') return null;
  if (provider.api_key_env) return { variable: provider.api_key_env, required: true };
  if (provider.type === 'anthropic') return { variable: 'ANTHROPIC_API_KEY', required: true };
  return { variable: 'OPENAI_API_KEY', required: provider.base_url === undefined };
}

/** Every provider a config can end up calling. */
export function providersInUse(config: Config): ProviderConfig[] {
  const found: ProviderConfig[] = [];
  for (const suite of config.suites) {
    const target = targetProvider(suite, config);
    if (target) found.push(target);
    for (const metric of suite.metrics ?? []) {
      const judge = judgeProvider(metric, suite, config);
      if (judge) found.push(judge);
    }
  }
  return found;
}

/** Names of the environment variables that must be set for this config to run. */
export function requiredSecrets(config: Config, env: NodeJS.ProcessEnv = process.env): string[] {
  const missing = new Set<string>();
  for (const provider of providersInUse(config)) {
    const need = keyRequirement(provider);
    if (need?.required && !env[need.variable]) missing.add(need.variable);
  }
  return [...missing];
}
