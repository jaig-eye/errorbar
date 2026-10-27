import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { type Io, main } from '../src/cli/commands';
import { RESULTS_SCHEMA_VERSION, type ResultsFile } from '../src/types';
import { must, tempDir, writeFiles } from './helpers';

function capture(): Io & { stdout: string; stderr: string } {
  const io = {
    stdout: '',
    stderr: '',
    out(text: string) {
      io.stdout += text;
    },
    err(text: string) {
      io.stderr += text;
    },
  };
  return io;
}

const cli = async (...argv: string[]) => {
  const io = capture();
  const code = await main(argv, io);
  return { code, out: io.stdout, err: io.stderr };
};

describe('errorbar init -> run -> compare', () => {
  it('scaffolds a project that runs, repeats, and catches a regression', async () => {
    const dir = tempDir();

    const init = await cli('init', dir, '--mock');
    expect(init.code).toBe(0);
    for (const file of [
      'errorbar.yaml',
      'evals/capitals.jsonl',
      'prompts/capital.md',
      '.github/workflows/evals.yml',
    ]) {
      expect(existsSync(path.join(dir, file))).toBe(true);
    }

    const config = path.join(dir, 'errorbar.yaml');
    const base = path.join(dir, 'base.json');
    const head = path.join(dir, 'head.json');

    const first = await cli('run', '--config', config, '--out', base, '--quiet');
    expect(first.code).toBe(0);
    expect(first.out).toContain('capitals: 12 cases × 3 trials');
    expect(first.out).toMatch(/names_the_capital\s+0\.\d{3}/);

    // The same run again, compared with the first, is a pass with nothing changed.
    const again = await cli(
      'run',
      '--config',
      config,
      '--out',
      head,
      '--baseline',
      base,
      '--quiet',
    );
    expect(again.code).toBe(0);
    expect(again.out).toContain('✅');
    expect(again.out).toContain('no change');

    // Damage the head results by hand: every answer wrong.
    const broken = JSON.parse(readFileSync(head, 'utf8')) as ResultsFile;
    for (const c of must(broken.suites[0]).cases)
      for (const t of c.trials) t.scores.names_the_capital = 0;
    writeFileSync(head, JSON.stringify(broken));

    const compared = await cli('compare', base, head);
    expect(compared.code).toBe(1);
    expect(compared.out).toContain('❌ regression in capitals › names_the_capital');

    const asJson = await cli('compare', base, head, '--format', 'json');
    expect(asJson.code).toBe(1);
    expect(JSON.parse(asJson.out).overall).toBe('fail');
  });

  it('will not overwrite an existing project', async () => {
    const dir = tempDir();
    await cli('init', dir, '--mock');
    await expect(cli('init', dir, '--mock')).rejects.toThrow('Not overwriting existing files');
  });

  it('writes a workflow that has the permissions the Action needs', async () => {
    const dir = tempDir();
    await cli('init', dir);
    const workflow = readFileSync(path.join(dir, '.github/workflows/evals.yml'), 'utf8');
    expect(workflow).toContain('pull-requests: write');
    expect(workflow).toContain('actions: read');
    expect(workflow).toContain('branches: [main]');
    expect(readFileSync(path.join(dir, 'errorbar.yaml'), 'utf8')).toContain('type: anthropic');
  });
});

describe('errorbar compare', () => {
  const results = (score: number): ResultsFile => ({
    schema: RESULTS_SCHEMA_VERSION,
    tool: { name: 'errorbar', version: 't' },
    created_at: '2026-10-26T00:00:00Z',
    git: {},
    gate: {
      confidence: 0.95,
      max_drop: 0.03,
      on_inconclusive: 'warn',
      bootstrap: 1000,
      seed: 's',
      min_cases: 10,
      max_error_rate: 0.1,
      flaky_threshold: 0.5,
    },
    suites: [
      {
        name: 's',
        kind: 'import',
        trials: 1,
        config_hash: 'x',
        models: [],
        metrics: { m: { kind: 'imported', config_hash: 'imported', gate: true } },
        cases: Array.from({ length: 30 }, (_, i) => ({
          id: `c${i}`,
          input_hash: 'h',
          input: '',
          trials: [{ scores: { m: Math.max(0, Math.min(1, score + (i % 5) / 50)) } }],
        })),
        usage: { calls: 0, input_tokens: 0, output_tokens: 0, latency_ms: 0 },
        duration_ms: 0,
        errors: { trials: 30, errored: 0 },
      },
    ],
  });

  const files = () => {
    const dir = tempDir();
    writeFiles(dir, {
      'good.json': JSON.stringify(results(0.8)),
      'bad.json': JSON.stringify(results(0.5)),
    });
    return { good: path.join(dir, 'good.json'), bad: path.join(dir, 'bad.json'), dir };
  };

  it('exits 0 when nothing regressed and 1 when something did', async () => {
    const { good, bad } = files();
    expect((await cli('compare', good, good)).code).toBe(0);
    expect((await cli('compare', good, bad)).code).toBe(1);
    expect((await cli('compare', bad, good)).code).toBe(0);
  });

  it('lets flags change the gate', async () => {
    const { good, bad } = files();
    // A drop of 0.3 is allowed if max-drop says so.
    expect((await cli('compare', good, bad, '--max-drop', '0.5')).code).toBe(0);
  });

  it('writes to a file when asked', async () => {
    const { good, bad, dir } = files();
    const out = path.join(dir, 'report.md');
    const run = await cli('compare', good, bad, '--out', out);
    expect(run.out).toBe('');
    expect(readFileSync(out, 'utf8')).toContain('❌');
  });

  it('explains bad input instead of crashing', async () => {
    const { good } = files();
    await expect(cli('compare', good)).rejects.toThrow('needs BASE.json and HEAD.json');
    await expect(cli('compare', good, good, '--format', 'xml')).rejects.toThrow('--format');
    await expect(cli('compare', good, good, '--nope', '1')).rejects.toThrow(
      'Unknown option --nope',
    );
    await expect(cli('compare', good, good, '--max-drop', 'lots')).rejects.toThrow(
      'must be a number',
    );
    await expect(cli('compare', good, good, '--max-drop')).rejects.toThrow('needs a value');
  });
});

describe('errorbar import', () => {
  it("turns another tool's scores into a results file", async () => {
    const dir = tempDir();
    writeFiles(dir, {
      'scores.jsonl': [
        { case_id: 'a', metric: 'acc', score: 1 },
        { case_id: 'b', metric: 'acc', score: 0 },
      ]
        .map((l) => JSON.stringify(l))
        .join('\n'),
    });
    const out = path.join(dir, 'results.json');
    const result = await cli(
      'import',
      path.join(dir, 'scores.jsonl'),
      '--suite',
      'ext',
      '--out',
      out,
    );
    expect(result.code).toBe(0);
    expect(result.out).toContain('ext: 2 cases');
    expect((JSON.parse(readFileSync(out, 'utf8')) as ResultsFile).suites[0]?.name).toBe('ext');
  });
});

describe('help and errors', () => {
  it('prints usage and the version', async () => {
    expect((await cli()).out).toContain('Usage:');
    expect((await cli('help')).out).toContain('errorbar compare');
    expect((await cli('--version')).out.trim()).toBe('0.0.0-test');
  });

  it('rejects an unknown command', async () => {
    await expect(cli('fly')).rejects.toThrow('Unknown command "fly"');
  });
});
