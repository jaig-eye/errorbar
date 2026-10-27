import type { GateSettings } from '../types';

export interface ProviderConfig {
  type: 'anthropic' | 'openai' | 'mock';
  model?: string;
  temperature?: number | null;
  max_tokens?: number;
  base_url?: string;
  api_key_env?: string;
  timeout_ms?: number;
  max_retries?: number;
  max_tokens_param?: 'max_tokens' | 'max_completion_tokens';
  /** mock only */
  accuracy?: number;
}

export interface PromptTargetConfig {
  type: 'prompt';
  prompt: string;
  system?: string;
  provider?: ProviderConfig;
}

export interface CommandTargetConfig {
  type: 'command';
  command: string | string[];
  workers?: number;
  timeout_ms?: number;
  cwd?: string;
  env?: Record<string, string>;
}

export type TargetConfig = PromptTargetConfig | CommandTargetConfig;

interface MetricCommon {
  name?: string;
  gate?: boolean;
  max_drop?: number;
}

export type MetricConfig =
  | (MetricCommon & { type: 'equals'; value?: string; ignore_case?: boolean; trim?: boolean })
  | (MetricCommon & { type: 'contains' | 'not_contains'; value?: string; ignore_case?: boolean })
  | (MetricCommon & { type: 'regex'; pattern: string; flags?: string })
  | (MetricCommon & { type: 'json_valid' })
  | (MetricCommon & { type: 'json_schema'; schema: Record<string, unknown> })
  | (MetricCommon & { type: 'max_length'; max: number; unit?: 'chars' | 'words' })
  | (MetricCommon & { type: 'recall_at_k'; k: number })
  | (MetricCommon & { type: 'mrr'; k?: number })
  | (MetricCommon & { type: 'rubric'; rubric: string; scale?: number; judge?: ProviderConfig })
  | (MetricCommon & {
      type: 'faithfulness' | 'answer_relevance';
      scale?: number;
      judge?: ProviderConfig;
    });

export interface SuiteConfig {
  name: string;
  dataset?: string;
  target?: TargetConfig;
  results?: string;
  trials?: number;
  concurrency?: number;
  /** Absent only for suites that import scores with `results`. */
  metrics?: MetricConfig[];
}

export interface DefaultsConfig {
  trials?: number;
  concurrency?: number;
  provider?: ProviderConfig;
  judge?: ProviderConfig;
}

export interface Config {
  version: 1;
  defaults?: DefaultsConfig;
  gate?: Partial<GateSettings>;
  redact?: string[];
  max_calls?: number;
  suites: SuiteConfig[];
}

export interface LoadedConfig {
  config: Config;
  /** Absolute path of the config file. */
  path: string;
  /** Directory every relative path in the config is resolved against. */
  dir: string;
}
