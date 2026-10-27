import { Ajv } from 'ajv';
import type { MetricConfig } from '../config/types';
import type { MetricInput } from './types';

type Scorer = (input: MetricInput) => number | null;

const schemaAjv = new Ajv({ strict: false, allErrors: false });

/** Models often wrap JSON in a Markdown fence. Accept that. */
function unfence(text: string): string {
  const trimmed = text.trim();
  const match = /^```[a-zA-Z]*\s*\n([\s\S]*?)\n?```$/.exec(trimmed);
  return match ? (match[1] as string) : trimmed;
}

function tryParseJson(text: string): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(unfence(text)) };
  } catch {
    return { ok: false };
  }
}

function target(config: { value?: string }, input: MetricInput): string | undefined {
  return config.value ?? input.row.expected;
}

const bool = (value: boolean): number => (value ? 1 : 0);

/** Scorers that need nothing but the output and the case. Returns null for other types. */
export function deterministicScorer(config: MetricConfig): Scorer | null {
  switch (config.type) {
    case 'equals':
      return (input) => {
        const want = target(config, input);
        if (want === undefined) return null;
        const norm = (text: string) => {
          const trimmed = config.trim === false ? text : text.trim();
          return config.ignore_case ? trimmed.toLowerCase() : trimmed;
        };
        return bool(norm(input.output) === norm(want));
      };
    case 'contains':
    case 'not_contains':
      return (input) => {
        const want = target(config, input);
        if (want === undefined) return null;
        const haystack = config.ignore_case ? input.output.toLowerCase() : input.output;
        const needle = config.ignore_case ? want.toLowerCase() : want;
        const found = haystack.includes(needle);
        return bool(config.type === 'contains' ? found : !found);
      };
    case 'regex': {
      const pattern = new RegExp(config.pattern, config.flags);
      return (input) => bool(pattern.test(input.output));
    }
    case 'json_valid':
      return (input) => bool(tryParseJson(input.output).ok);
    case 'json_schema': {
      const validate = schemaAjv.compile(config.schema);
      return (input) => {
        const parsed = tryParseJson(input.output);
        return bool(parsed.ok && validate(parsed.value) === true);
      };
    }
    case 'max_length':
      return (input) => {
        const size =
          config.unit === 'words'
            ? input.output.trim().split(/\s+/).filter(Boolean).length
            : input.output.length;
        return bool(size <= config.max);
      };
    default:
      return null;
  }
}
