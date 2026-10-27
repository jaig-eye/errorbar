import { readFileSync } from 'node:fs';
import type { PromptTargetConfig, ProviderConfig } from '../config/types';
import type { DatasetRow } from '../dataset';
import { ConfigError } from '../errors';
import type { Provider } from '../providers/types';
import { shortHash } from '../util/hash';
import { errorMessage } from '../util/text';
import type { Target } from './types';

const PLACEHOLDER = /\{\{\s*([A-Za-z_][\w.-]*)\s*\}\}/g;

function lookup(vars: Record<string, unknown>, dotted: string): unknown {
  let value: unknown = vars;
  for (const part of dotted.split('.')) {
    if (value === null || typeof value !== 'object' || !(part in value)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

export function placeholders(template: string): string[] {
  return [...new Set([...template.matchAll(PLACEHOLDER)].map((match) => match[1] as string))];
}

export function renderTemplate(template: string, vars: Record<string, unknown>): string {
  return template.replace(PLACEHOLDER, (_whole, name: string) => {
    const value = lookup(vars, name);
    if (value === undefined)
      throw new Error(`the prompt uses {{${name}}} but the case has no such var`);
    return typeof value === 'string' ? value : JSON.stringify(value);
  });
}

function readText(file: string, what: string): string {
  try {
    return readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read the ${what} ${file}: ${errorMessage(error)}`);
  }
}

export interface PromptTargetInput {
  config: PromptTargetConfig;
  provider: ProviderConfig;
  /** Absolute paths. */
  promptPath: string;
  systemPath?: string;
  rows: DatasetRow[];
  client: Provider;
}

export function createPromptTarget(input: PromptTargetInput): Target {
  const template = readText(input.promptPath, 'prompt file');
  const system = input.systemPath ? readText(input.systemPath, 'system prompt file') : undefined;

  // Fail before spending anything if the prompt cannot be filled for some case.
  const needed = [...placeholders(template), ...(system ? placeholders(system) : [])];
  const problems: string[] = [];
  for (const row of input.rows) {
    const missing = needed.filter((name) => lookup(row.vars, name) === undefined);
    if (missing.length > 0)
      problems.push(`case "${row.id}" has no var ${missing.map((m) => `"${m}"`).join(', ')}`);
  }
  if (problems.length > 0) {
    const shown = problems.slice(0, 5).join('; ');
    const more = problems.length > 5 ? ` (and ${problems.length - 5} more)` : '';
    throw new ConfigError(`The prompt cannot be filled for every case: ${shown}${more}`);
  }

  const { provider } = input;
  return {
    kind: 'prompt',
    targetModel: provider.model,
    configHash: shortHash({
      kind: 'prompt',
      template,
      system,
      provider: {
        type: provider.type,
        model: provider.model,
        temperature: provider.temperature,
        max_tokens: provider.max_tokens,
        base_url: provider.base_url,
        accuracy: provider.accuracy,
      },
    }),
    async run({ row, trial }) {
      const completion = await input.client.complete({
        system: system ? renderTemplate(system, row.vars) : undefined,
        prompt: renderTemplate(template, row.vars),
        meta: { role: 'target', row, trial },
      });
      return {
        output: completion.text,
        model: completion.model,
        usage: {
          calls: 1,
          input_tokens: completion.usage.input_tokens,
          output_tokens: completion.usage.output_tokens,
          latency_ms: completion.latency_ms,
        },
        latency_ms: completion.latency_ms,
      };
    },
    async close() {},
  };
}
