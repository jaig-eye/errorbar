import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors';

const CAPITALS: Array<[string, string]> = [
  ['France', 'Paris'],
  ['Japan', 'Tokyo'],
  ['Canada', 'Ottawa'],
  ['Brazil', 'Brasília'],
  ['Egypt', 'Cairo'],
  ['Australia', 'Canberra'],
  ['Kenya', 'Nairobi'],
  ['Norway', 'Oslo'],
  ['Peru', 'Lima'],
  ['Thailand', 'Bangkok'],
  ['Argentina', 'Buenos Aires'],
  ['Poland', 'Warsaw'],
];

function dataset(): string {
  return `${CAPITALS.map(([country, capital]) =>
    JSON.stringify({ id: country.toLowerCase(), vars: { country }, expected: capital }),
  ).join('\n')}\n`;
}

function config(mock: boolean): string {
  const provider = mock
    ? '    type: mock\n    accuracy: 0.9'
    : '    type: anthropic\n    model: claude-haiku-5-5\n    max_tokens: 256';
  return `# yaml-language-server: $schema=https://raw.githubusercontent.com/jaig-eye/errorbar/main/schema/errorbar.schema.json
version: 1

defaults:
  trials: 3        # run each case 3 times so run-to-run noise can be measured
  provider:
${provider}

gate:
  max_drop: 0.03   # fail the build only for a real drop of at least this much

suites:
  - name: capitals
    dataset: evals/capitals.jsonl
    target:
      type: prompt
      prompt: prompts/capital.md
    metrics:
      - type: contains
        name: names_the_capital   # looks for each case's \`expected\` in the answer
`;
}

const PROMPT = `Answer in one short sentence.

What is the capital of {{country}}?
`;

const WORKFLOW = `name: evals

on:
  pull_request:
  push:
    branches: [main]   # every run on main becomes the baseline pull requests are compared with

permissions:
  contents: read
  actions: read          # find the baseline from main
  pull-requests: write   # post the report

jobs:
  eval:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v7
      # Pin to a full commit SHA in production: uses: jaig-eye/errorbar@<sha> # v0
      - uses: jaig-eye/errorbar@v0
        env:
          ANTHROPIC_API_KEY: \${{ secrets.ANTHROPIC_API_KEY }}
`;

export interface InitOptions {
  directory: string;
  mock: boolean;
}

/** Writes a starter config, dataset, prompt and workflow. Never overwrites a file. */
export function initProject(options: InitOptions): string[] {
  const files: Array<[string, string]> = [
    ['errorbar.yaml', config(options.mock)],
    ['evals/capitals.jsonl', dataset()],
    ['prompts/capital.md', PROMPT],
    ['.github/workflows/evals.yml', WORKFLOW],
  ];
  const existing = files.map(([file]) => path.join(options.directory, file)).filter(existsSync);
  if (existing.length > 0) {
    throw new ConfigError(`Not overwriting existing files: ${existing.join(', ')}`);
  }
  for (const [file, content] of files) {
    const target = path.join(options.directory, file);
    mkdirSync(path.dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return files.map(([file]) => file);
}
