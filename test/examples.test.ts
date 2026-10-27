import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { compare } from '../src/compare/compare';
import { loadConfig } from '../src/config/load';
import { loadDataset } from '../src/dataset';
import { runConfig } from '../src/runner/run';

const examples = path.resolve(__dirname, '..', 'examples');

describe('the shipped examples', () => {
  it.each(['support-bot', 'rag-python'])('%s has a valid config and dataset', (name) => {
    const loaded = loadConfig(path.join(examples, name, 'errorbar.yaml'));
    for (const suite of loaded.config.suites) {
      const rows = loadDataset(path.join(loaded.dir, suite.dataset as string));
      expect(rows.length).toBeGreaterThanOrEqual(20); // enough for a verdict
    }
  });

  it('support-bot runs offline, repeats, and a worse prompt is caught', async () => {
    const loaded = loadConfig(path.join(examples, 'support-bot', 'errorbar.yaml'));
    const first = await runConfig({ loaded, env: {} });
    const again = await runConfig({ loaded, env: {} });

    const suite = first.suites[0];
    expect(Object.keys(suite?.metrics ?? {})).toEqual([
      'states_the_policy',
      'brief',
      'helpfulness',
    ]);
    expect(suite?.errors.errored).toBe(0);
    expect(compare(first, again).overall).toBe('pass');

    // The same suite with a prompt that makes the (mock) model much worse.
    const worse = structuredClone(first);
    for (const c of worse.suites[0]?.cases ?? []) {
      for (const trial of c.trials)
        trial.scores.states_the_policy = (trial.scores.states_the_policy ?? 0) * 0.3;
    }
    const verdict = compare(first, worse);
    expect(verdict.overall).toBe('fail');
    expect(verdict.suites[0]?.rows.find((r) => r.metric === 'states_the_policy')?.verdict).toBe(
      'regression',
    );
  });

  it('rag-python only needs the documents its dataset points at', async () => {
    const { readdirSync } = await import('node:fs');
    const docs = new Set(
      readdirSync(path.join(examples, 'rag-python', 'docs')).map((f) => path.parse(f).name),
    );
    const rows = loadDataset(path.join(examples, 'rag-python', 'dataset.jsonl'));
    for (const row of rows) {
      for (const id of row.relevant_ids ?? [])
        expect(docs.has(id), `${row.id} -> ${id}`).toBe(true);
    }
  });
});
