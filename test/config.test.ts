import { describe, expect, it } from 'vitest';
import { metricName, parseConfig } from '../src/config/load';
import { requiredSecrets } from '../src/config/resolve';
import type { Config } from '../src/config/types';
import { ConfigError } from '../src/errors';

const valid = `
version: 1
defaults:
  trials: 3
  provider: { type: anthropic, model: claude-haiku-5-5 }
suites:
  - name: qa
    dataset: d.jsonl
    target: { type: prompt, prompt: p.md }
    metrics:
      - { type: contains }
      - { type: rubric, name: helpful, rubric: Be helpful }
`;

function reject(yaml: string): string {
  try {
    parseConfig(yaml);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as Error).message;
  }
  throw new Error('expected the config to be rejected');
}

/** Swaps text in the valid config so each test changes one thing. */
const tweak = (from: string, to: string) => valid.replace(from, to);

describe('parseConfig', () => {
  it('accepts a valid config', () => {
    const config = parseConfig(valid);
    expect(config.suites[0]?.name).toBe('qa');
    expect(config.defaults?.trials).toBe(3);
  });

  it('accepts a command target with retrieval metrics', () => {
    const config = parseConfig(`
version: 1
suites:
  - name: rag
    dataset: d.jsonl
    target: { type: command, command: [python, rag.py], workers: 2 }
    metrics:
      - { type: recall_at_k, k: 5 }
      - { type: mrr }
`);
    expect(config.suites[0]?.metrics).toHaveLength(2);
  });

  it('accepts an import suite without metrics', () => {
    const config = parseConfig(`
version: 1
suites:
  - { name: imported, results: scores.jsonl }
`);
    expect(config.suites[0]?.results).toBe('scores.jsonl');
  });

  it('names an unknown top-level option', () => {
    expect(reject(`${valid}\ngates: {}`)).toContain('unknown option `gates`');
  });

  it('names a mistyped metric option instead of ignoring it', () => {
    const yaml = tweak('{ type: contains }', '{ type: regex, pattern: x, flag: i }');
    expect(reject(yaml)).toContain('unknown option `flag`');
  });

  it('lists the valid metric types for an unknown one', () => {
    const message = reject(tweak('{ type: contains }', '{ type: vibes }'));
    expect(message).toContain('recall_at_k');
  });

  it('rejects a bad confidence level', () => {
    expect(reject(`${valid}\ngate: { confidence: 1.5 }`)).toContain('/gate/confidence');
  });

  it('rejects a provider without a model', () => {
    expect(reject(tweak('model: claude-haiku-5-5', 'max_tokens: 5'))).toContain('needs a `model`');
  });

  it('rejects two metrics with the same name', () => {
    const yaml = tweak('{ type: contains }', '{ type: contains, name: helpful }');
    expect(reject(yaml)).toContain('two metrics are called "helpful"');
  });

  it('rejects two suites with the same name', () => {
    const yaml = `${valid}  - name: qa\n    dataset: d.jsonl\n    target: { type: prompt, prompt: p.md }\n    metrics: [{ type: contains }]\n`;
    expect(reject(yaml)).toContain('two suites are called "qa"');
  });

  it('rejects a rubric with no judge available', () => {
    const yaml = `
version: 1
suites:
  - name: rag
    dataset: d.jsonl
    target: { type: command, command: x }
    metrics: [{ type: rubric, name: r, rubric: Be good }]
`;
    expect(reject(yaml)).toContain('needs a judge');
  });

  it('rejects retrieval metrics on a prompt target', () => {
    const yaml = tweak('{ type: contains }', '{ type: recall_at_k, k: 3 }');
    expect(reject(yaml)).toContain('only a `command` target returns');
  });

  it('rejects faithfulness on a prompt target', () => {
    const yaml = tweak('{ type: contains }', '{ type: faithfulness }');
    expect(reject(yaml)).toContain('only a `command` target returns');
  });

  it('rejects an import suite that also declares metrics or a target', () => {
    const yaml = `
version: 1
suites:
  - name: imp
    results: s.jsonl
    dataset: d.jsonl
    metrics: [{ type: contains }]
`;
    const message = reject(yaml);
    expect(message).toContain('replaces `dataset` and `target`');
    expect(message).toContain('remove `metrics`');
  });

  it('rejects a suite with a target but no dataset', () => {
    expect(reject(tweak('dataset: d.jsonl\n    ', ''))).toContain('needs a `dataset`');
  });

  it('rejects a bad regular expression', () => {
    expect(reject(tweak('{ type: contains }', '{ type: regex, pattern: "(" }'))).toContain(
      'bad pattern',
    );
  });

  it('rejects an invalid json_schema', () => {
    const yaml = tweak('{ type: contains }', '{ type: json_schema, schema: { type: nonsense } }');
    expect(reject(yaml)).toContain('bad schema');
  });

  it('rejects YAML that does not parse', () => {
    expect(reject('version: [')).toContain('Could not parse');
  });
});

describe('metricName', () => {
  it('derives a name from the type and options', () => {
    expect(metricName({ type: 'contains' })).toBe('contains');
    expect(metricName({ type: 'recall_at_k', k: 5 })).toBe('recall@5');
    expect(metricName({ type: 'mrr', k: 3 })).toBe('mrr@3');
    expect(metricName({ type: 'mrr' })).toBe('mrr');
    expect(metricName({ type: 'contains', name: 'mine' })).toBe('mine');
  });
});

describe('requiredSecrets', () => {
  const config = parseConfig(valid) as Config;

  it('asks for the provider key when it is missing', () => {
    expect(requiredSecrets(config, {})).toEqual(['ANTHROPIC_API_KEY']);
  });

  it('is satisfied when the key is set', () => {
    expect(requiredSecrets(config, { ANTHROPIC_API_KEY: 'k' })).toEqual([]);
  });

  it('asks for nothing from the mock provider', () => {
    const mock = parseConfig(
      tweak('{ type: anthropic, model: claude-haiku-5-5 }', '{ type: mock }'),
    );
    expect(requiredSecrets(mock, {})).toEqual([]);
  });

  it('does not insist on a key for a local OpenAI-compatible server', () => {
    const local = parseConfig(
      tweak(
        '{ type: anthropic, model: claude-haiku-5-5 }',
        '{ type: openai, model: llama3, base_url: "http://localhost:11434/v1" }',
      ),
    );
    expect(requiredSecrets(local, {})).toEqual([]);
  });

  it('honours a custom key variable and lists each once', () => {
    const custom = parseConfig(
      tweak(
        '{ type: anthropic, model: claude-haiku-5-5 }',
        '{ type: openai, model: gpt, api_key_env: MY_KEY }',
      ),
    );
    expect(requiredSecrets(custom, {})).toEqual(['MY_KEY']);
  });
});
