import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/compare/compare';
import { loadConfig } from '../src/config/load';
import { BudgetExceededError, ConfigError, MissingSecretError } from '../src/errors';
import { importJsonl } from '../src/results/import';
import { parseResults, writeResults } from '../src/results/io';
import { runConfig } from '../src/runner/run';
import type { ResultsFile } from '../src/types';
import { makeResults, must, tempDir, writeFiles } from './helpers';

const CASES = 40;

function dataset(): string {
  return `${Array.from({ length: CASES }, (_, i) =>
    JSON.stringify({
      id: `q${i + 1}`,
      vars: { q: `Question ${i + 1}` },
      expected: `Answer ${i + 1}`,
    }),
  ).join('\n')}\n`;
}

interface Options {
  accuracy?: number;
  seed?: string;
  extra?: string;
  metrics?: string;
}

/** A prompt suite on the mock provider. Lower `accuracy` in the prompt to make a regression. */
function promptProject(options: Options = {}) {
  const dir = tempDir();
  writeFiles(dir, {
    'errorbar.yaml': `
version: 1
defaults:
  trials: 3
  provider: { type: mock }
gate: { seed: ${options.seed ?? 'e2e'}, bootstrap: 2000 }
${options.extra ?? ''}
suites:
  - name: qa
    dataset: data.jsonl
    target: { type: prompt, prompt: prompt.md }
    metrics:
${
  options.metrics ??
  `      - { type: equals, name: exact }
      - { type: rubric, name: quality, rubric: Be right., judge: { type: mock } }`
}
`,
    'data.jsonl': dataset(),
    'prompt.md': `{{q}}\nmock-accuracy: ${options.accuracy ?? 0.9}\n`,
  });
  return loadConfig(path.join(dir, 'errorbar.yaml'));
}

const run = (
  loaded: ReturnType<typeof loadConfig>,
  extra: Partial<Parameters<typeof runConfig>[0]> = {},
) => runConfig({ loaded, env: {}, now: () => new Date('2026-10-26T00:00:00Z'), ...extra });

describe('running a prompt suite', () => {
  it('scores every case on every trial and counts what it used', async () => {
    const results = await run(promptProject());
    const suite = must(results.suites[0]);

    expect(suite).toMatchObject({ name: 'qa', kind: 'prompt', trials: 3, models: ['mock-1'] });
    expect(suite.cases).toHaveLength(CASES);
    expect(suite.cases.every((c) => c.trials.length === 3)).toBe(true);
    expect(Object.keys(suite.metrics)).toEqual(['exact', 'quality']);
    expect(suite.metrics.quality?.judge_models).toEqual(['mock-1']);

    const scores = suite.cases.flatMap((c) => c.trials.map((t) => t.scores.exact));
    expect(scores.every((s) => s === 0 || s === 1)).toBe(true);
    const accuracy = (scores as number[]).reduce((a, b) => a + b, 0) / scores.length;
    expect(accuracy).toBeGreaterThan(0.8);
    expect(accuracy).toBeLessThan(1);

    // target calls + judge calls
    expect(suite.usage.calls).toBe(CASES * 3 * 2);
    expect(suite.usage.input_tokens).toBeGreaterThan(0);
    expect(suite.errors).toEqual({ trials: CASES * 3, errored: 0 });
    expect(results.created_at).toBe('2026-10-26T00:00:00.000Z');
  });

  it('gives identical results when run twice', async () => {
    const strip = (r: ResultsFile) => ({
      ...r,
      suites: r.suites.map((s) => ({ ...s, duration_ms: 0 })),
    });
    const a = await run(promptProject());
    const b = await run(promptProject());
    expect(strip(a)).toEqual(strip(b));
  });

  it('survives a round trip through a file', async () => {
    const results = await run(promptProject());
    const file = path.join(tempDir(), 'out', 'results.json');
    writeResults(file, results);
    expect(parseResults(readFileSync(file, 'utf8'), file)).toEqual(results);
  });

  it('can run a single suite and fewer trials', async () => {
    const results = await run(promptProject(), { suite: 'qa', trials: 1 });
    expect(results.suites[0]?.trials).toBe(1);
    await expect(run(promptProject(), { suite: 'nope' })).rejects.toThrow('No suite named "nope"');
  });

  it('keeps secrets out of stored outputs', async () => {
    const loaded = promptProject({
      extra: 'redact: ["Answer \\\\d+"]',
      metrics: '      - { type: contains, name: has }',
    });
    const results = await run(loaded);
    const outputs = must(results.suites[0]).cases.flatMap((c) =>
      c.trials.map((t) => t.output ?? ''),
    );
    expect(outputs.some((o) => o.includes('[redacted]'))).toBe(true);
    expect(outputs.some((o) => /Answer \d+/.test(o))).toBe(false);
  });

  it('stops at max_calls instead of spending without limit', async () => {
    await expect(run(promptProject({ extra: 'max_calls: 10' }))).rejects.toThrow(
      BudgetExceededError,
    );
  });

  it('fails before spending anything if a prompt variable is missing', async () => {
    const loaded = promptProject();
    writeFiles(loaded.dir, { 'prompt.md': '{{q}} and {{missing}}\n' });
    await expect(run(loaded)).rejects.toThrow('no var "missing"');
  });
});

describe('talking to a real provider shape', () => {
  const yaml = `
version: 1
defaults:
  trials: 2
  provider: { type: anthropic, model: claude-haiku-5-5 }
suites:
  - name: qa
    dataset: data.jsonl
    target: { type: prompt, prompt: prompt.md }
    metrics: [{ type: contains, name: has }]
`;
  const project = () => {
    const dir = tempDir();
    writeFiles(dir, { 'errorbar.yaml': yaml, 'data.jsonl': dataset(), 'prompt.md': '{{q}}\n' });
    return loadConfig(path.join(dir, 'errorbar.yaml'));
  };

  it('asks for the missing key by name', async () => {
    await expect(run(project())).rejects.toThrow(MissingSecretError);
    await expect(run(project())).rejects.toThrow('ANTHROPIC_API_KEY');
  });

  it('records the model the API reports, which can differ from the alias', async () => {
    let n = 0;
    const fetchStub = async () =>
      new Response(
        JSON.stringify({
          model: 'claude-haiku-5-5-20261001',
          content: [{ type: 'text', text: n++ % 2 === 0 ? 'Answer 1' : 'nope' }],
          usage: { input_tokens: 9, output_tokens: 3 },
        }),
        { status: 200 },
      );
    const results = await run(project(), {
      env: { ANTHROPIC_API_KEY: 'sk-test' },
      http: { fetch: fetchStub as unknown as typeof fetch },
    });
    const suite = must(results.suites[0]);
    expect(suite).toMatchObject({
      target_model: 'claude-haiku-5-5',
      models: ['claude-haiku-5-5-20261001'],
    });
    expect(suite.usage).toMatchObject({
      calls: CASES * 2,
      input_tokens: 9 * CASES * 2,
      output_tokens: 3 * CASES * 2,
    });
  });
});

describe('from a run to a verdict', () => {
  it('fails a prompt change that makes answers worse', async () => {
    const base = await run(promptProject({ accuracy: 0.9 }));
    const head = await run(promptProject({ accuracy: 0.4 }));
    const result = compare(base, head);
    expect(result.overall).toBe('fail');
    expect(result.suites[0]?.rows.find((r) => r.metric === 'exact')?.verdict).toBe('regression');
    expect(result.suites[0]?.rows.find((r) => r.metric === 'quality')?.verdict).toBe('regression');
  });

  it('passes a change that does nothing', async () => {
    const base = await run(promptProject());
    const head = await run(promptProject());
    expect(compare(base, head).overall).toBe('pass');
  });

  it('almost never fails run-to-run noise on an unchanged prompt', async () => {
    // The same prompt, run again with a different seed, 30 times. The nominal false-alarm rate is
    // about 2.5%, so one or two failures would be normal and five would mean the gate is broken.
    let failures = 0;
    for (let i = 0; i < 30; i++) {
      const base = await run(promptProject({ seed: `a${i}` }));
      const head = await run(promptProject({ seed: `b${i}` }));
      if (compare(base, head).overall === 'fail') failures++;
    }
    expect(failures).toBeLessThanOrEqual(3);
  });

  it('shows a better prompt as improved', async () => {
    const base = await run(promptProject({ accuracy: 0.5 }));
    const head = await run(promptProject({ accuracy: 0.95 }));
    expect(compare(base, head).suites[0]?.rows.find((r) => r.metric === 'exact')?.verdict).toBe(
      'improved',
    );
  });

  it('reports a broken pipeline as an error, not a regression', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'errorbar.yaml': `
version: 1
defaults: { trials: 2 }
suites:
  - name: rag
    dataset: data.jsonl
    target: { type: command, command: [node, -e, "process.exit(1)"], timeout_ms: 5000 }
    metrics: [{ type: contains, name: has }]
`,
      'data.jsonl': dataset(),
    });
    const head = await run(loadConfig(path.join(dir, 'errorbar.yaml')));
    expect(head.suites[0]?.errors.errored).toBe(CASES * 2);
    expect(head.suites[0]?.cases[0]?.trials[0]?.error).toContain('exited');
    const good = await run(promptProject());
    const goodAsRag = {
      ...good,
      suites: [{ ...must(good.suites[0]), name: 'rag', metrics: must(head.suites[0]).metrics }],
    };
    expect(compare(goodAsRag, head).overall).toBe('error');
  });
});

describe('a pipeline run as a command', () => {
  const fixture = path.resolve(__dirname, 'fixtures', 'target.mjs');

  it('scores retrieval from the contexts the command returns', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'errorbar.yaml': `
version: 1
defaults: { trials: 2, provider: { type: mock } }
suites:
  - name: rag
    dataset: data.jsonl
    target: { type: command, command: [node, "${fixture.replaceAll('\\', '/')}"], workers: 2, timeout_ms: 10000 }
    metrics:
      - { type: recall_at_k, k: 1 }
      - { type: recall_at_k, k: 2 }
      - { type: mrr }
      - { type: equals, name: shouted }
      - { type: faithfulness, judge: { type: mock } }
`,
      'data.jsonl': [
        { id: 'first', vars: { q: 'alpha' }, expected: 'ALPHA', relevant_ids: ['a'] },
        { id: 'second', vars: { q: 'beta' }, expected: 'BETA', relevant_ids: ['b'] },
        { id: 'none', vars: { q: 'gamma' }, expected: 'GAMMA' },
      ]
        .map((r) => JSON.stringify(r))
        .join('\n'),
    });
    const results = await run(loadConfig(path.join(dir, 'errorbar.yaml')));
    const suite = must(results.suites[0]);
    const score = (id: string, metric: string) =>
      suite.cases.find((c) => c.id === id)?.trials[0]?.scores[metric];

    expect(score('first', 'recall@1')).toBe(1);
    expect(score('second', 'recall@1')).toBe(0);
    expect(score('second', 'recall@2')).toBe(1);
    expect(score('second', 'mrr')).toBe(0.5);
    expect(score('none', 'recall@1')).toBeNull(); // no relevant_ids: not applicable
    expect(score('first', 'shouted')).toBe(1);
    expect(score('first', 'faithfulness')).toBeGreaterThan(0);
    expect(suite.cases[0]?.trials[0]?.context_ids).toEqual(['a', 'b']);
    expect(suite.errors.errored).toBe(0);
  });
});

describe('importing scores from another tool', () => {
  it('gates imported scores exactly like native ones', async () => {
    const [base, head] = [
      await run(promptProject({ accuracy: 0.9 })),
      await run(promptProject({ accuracy: 0.45 })),
    ];

    const toJsonl = (results: ResultsFile) =>
      must(results.suites[0])
        .cases.flatMap((c) =>
          c.trials.flatMap((t, trial) =>
            Object.entries(t.scores).map(([metric, score]) =>
              JSON.stringify({ case_id: c.id, trial, metric, score, input_hash: c.input_hash }),
            ),
          ),
        )
        .join('\n');

    const asImport = (results: ResultsFile) =>
      makeResults(
        [importJsonl(toJsonl(results), { suite: 'qa', source: 'scores.jsonl' })],
        results.gate,
      );

    const native = compare(base, head);
    const imported = compare(asImport(base), asImport(head));

    const verdicts = (c: typeof native) =>
      c.suites[0]?.rows.map((r) => [r.metric, r.verdict, r.delta.toFixed(6)]);
    expect(imported.overall).toBe(native.overall);
    expect(verdicts(imported)).toEqual(verdicts(native));
  });

  it('reads trials, fills gaps with null and leaves edited cases out', () => {
    const suite = importJsonl(
      [
        { case_id: 'a', trial: 0, metric: 'acc', score: 1, input_hash: 'h1' },
        { case_id: 'a', trial: 1, metric: 'acc', score: 0, input_hash: 'h1' },
        { case_id: 'a', trial: 0, metric: 'f1', score: 0.5 },
        { case_id: 'b', metric: 'acc', score: 0.25, output: 'text' },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
      { suite: 'x', source: 's' },
    );
    expect(suite.kind).toBe('import');
    expect(suite.trials).toBe(2);
    expect(suite.cases.find((c) => c.id === 'a')?.trials.map((t) => t.scores)).toEqual([
      { acc: 1, f1: 0.5 },
      { acc: 0, f1: null },
    ]);
    expect(suite.cases.find((c) => c.id === 'b')?.trials[0]?.output).toBe('text');
    expect(Object.keys(suite.metrics)).toEqual(['acc', 'f1']);
  });

  it.each([
    ['{oops', 'not valid JSON'],
    [JSON.stringify({ metric: 'm', score: 1 }), '`case_id`'],
    [JSON.stringify({ case_id: 'a', score: 1 }), '`metric`'],
    [JSON.stringify({ case_id: 'a', metric: 'm', score: 4 }), 'from 0 to 1'],
    [JSON.stringify({ case_id: 'a', metric: 'm', score: 1, trial: -1 }), '`trial`'],
    ['', 'no scores found'],
  ])('rejects %j', (text, message) => {
    expect(() => importJsonl(text, { suite: 'x', source: 's' })).toThrow(message);
  });

  it('is wired into a config with `results`', async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'errorbar.yaml': 'version: 1\nsuites:\n  - { name: external, results: scores.jsonl }\n',
      'scores.jsonl': `${JSON.stringify({ case_id: 'a', metric: 'acc', score: 1 })}\n`,
    });
    const results = await run(loadConfig(path.join(dir, 'errorbar.yaml')));
    expect(results.suites[0]).toMatchObject({ name: 'external', kind: 'import' });
  });
});

describe('results files', () => {
  it('reject a file from a different schema version with advice', () => {
    expect(() => parseResults(JSON.stringify({ schema: 99, suites: [] }), 'old.json')).toThrow(
      'Re-run the baseline',
    );
  });

  it.each(['{', '[]', '{"schema":1}'])('reject %j', (text) => {
    expect(() => parseResults(text, 'f')).toThrow(ConfigError);
  });
});
