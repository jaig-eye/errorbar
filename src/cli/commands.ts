import { writeFileSync } from 'node:fs';
import path from 'node:path';
import { type Comparison, compare } from '../compare/compare';
import { loadConfig } from '../config/load';
import { ConfigError } from '../errors';
import { detectGit } from '../git';
import { renderReport } from '../report/markdown';
import { importFile } from '../results/import';
import { readResults, writeResults } from '../results/io';
import { runConfig } from '../runner/run';
import { mean } from '../stats/bootstrap';
import {
  DEFAULT_GATE,
  type GateSettings,
  RESULTS_SCHEMA_VERSION,
  type ResultsFile,
} from '../types';
import { VERSION } from '../version';
import { type FlagSpec, numberOption, type ParsedArgs, parseArgs } from './args';
import { initProject } from './init';

/** Where the CLI writes. Real streams in production; captured strings in tests. */
export interface Io {
  out(text: string): void;
  err(text: string): void;
}

const USAGE = `errorbar ${VERSION}: an LLM eval regression gate

Usage:
  errorbar run [--config errorbar.yaml] [--out .errorbar/results.json] [--suite NAME]
               [--trials N] [--baseline base.json]
      Run the suites and write a results file. With --baseline, also compare and set the exit code.

  errorbar compare BASE.json HEAD.json [--format markdown|json] [--out FILE]
               [--max-drop N] [--confidence N] [--min-cases N] [--on-inconclusive warn|fail|pass]
      Compare two results files. Exit code 1 means a regression, 2 means a broken run.

  errorbar import SCORES.jsonl --suite NAME [--out .errorbar/results.json]
      Turn scores from another tool into a results file.

  errorbar init [DIR] [--mock]
      Write a starter config, dataset, prompt and GitHub workflow.

Exit codes: 0 no regression, 1 regression, 2 error.
Docs: https://github.com/jaig-eye/errorbar#readme
`;

const DEFAULT_OUT = '.errorbar/results.json';

const SPECS: Record<string, FlagSpec> = {
  run: { values: ['config', 'out', 'suite', 'trials', 'baseline'], switches: ['quiet'] },
  compare: {
    values: ['format', 'out', 'max-drop', 'confidence', 'min-cases', 'on-inconclusive'],
    switches: [],
  },
  import: { values: ['suite', 'out'], switches: [] },
  init: { values: [], switches: ['mock'] },
};

function exitCodeFor(comparison: Comparison): number {
  if (comparison.overall === 'error') return 2;
  return comparison.overall === 'fail' ? 1 : 0;
}

function gateOverrides(parsed: ParsedArgs): Partial<GateSettings> {
  const overrides: Partial<GateSettings> = {};
  const maxDrop = numberOption(parsed, 'max-drop');
  const confidence = numberOption(parsed, 'confidence');
  const minCases = numberOption(parsed, 'min-cases');
  const onInconclusive = parsed.values.get('on-inconclusive');
  if (maxDrop !== undefined) overrides.max_drop = maxDrop;
  if (confidence !== undefined) overrides.confidence = confidence;
  if (minCases !== undefined) overrides.min_cases = minCases;
  if (onInconclusive !== undefined) {
    if (onInconclusive !== 'warn' && onInconclusive !== 'fail' && onInconclusive !== 'pass') {
      throw new ConfigError('--on-inconclusive must be warn, fail or pass');
    }
    overrides.on_inconclusive = onInconclusive;
  }
  return overrides;
}

/** Plain scores for a run that has nothing to compare with. */
function describeScores(results: ResultsFile): string {
  const lines: string[] = [];
  for (const suite of results.suites) {
    const tokens = suite.usage.input_tokens + suite.usage.output_tokens;
    lines.push(
      `${suite.name}: ${suite.cases.length} cases × ${suite.trials} trials` +
        (tokens > 0 ? `, ${tokens} tokens` : '') +
        (suite.errors.errored > 0 ? `, ${suite.errors.errored} errored trials` : ''),
    );
    for (const name of Object.keys(suite.metrics)) {
      const perCase = suite.cases.flatMap((c) => {
        const scores = c.trials
          .map((t) => t.scores[name])
          .filter((s): s is number => typeof s === 'number');
        return scores.length > 0 ? [mean(scores)] : [];
      });
      lines.push(`  ${name.padEnd(24)} ${perCase.length > 0 ? mean(perCase).toFixed(3) : '–'}`);
    }
  }
  return lines.join('\n');
}

function emit(text: string, out: string | undefined, io: Io): void {
  if (out) writeFileSync(out, text);
  else io.out(text);
}

async function runCommand(parsed: ParsedArgs, io: Io): Promise<number> {
  const loaded = loadConfig(parsed.values.get('config') ?? 'errorbar.yaml');
  const quiet = parsed.switches.has('quiet');
  const results = await runConfig({
    loaded,
    suite: parsed.values.get('suite'),
    trials: numberOption(parsed, 'trials'),
    git: detectGit(process.env, loaded.dir),
    log: quiet ? undefined : (message) => io.err(`${message}\n`),
  });
  const out = parsed.values.get('out') ?? DEFAULT_OUT;
  writeResults(out, results);
  io.err(`Wrote ${out}\n`);

  const baselinePath = parsed.values.get('baseline');
  if (!baselinePath) {
    io.out(`${describeScores(results)}\n`);
    return results.suites.some(
      (s) =>
        s.errors.trials > 0 && s.errors.errored / s.errors.trials > results.gate.max_error_rate,
    )
      ? 2
      : 0;
  }
  const comparison = compare(readResults(baselinePath), results);
  io.out(renderReport(comparison));
  return exitCodeFor(comparison);
}

function compareCommand(parsed: ParsedArgs, io: Io): number {
  const [basePath, headPath] = parsed.positionals;
  if (!basePath || !headPath) throw new ConfigError('compare needs BASE.json and HEAD.json');
  const comparison = compare(readResults(basePath), readResults(headPath), gateOverrides(parsed));
  const format = parsed.values.get('format') ?? 'markdown';
  if (format !== 'markdown' && format !== 'json') {
    throw new ConfigError('--format must be markdown or json');
  }
  emit(
    format === 'json' ? `${JSON.stringify(comparison, null, 2)}\n` : renderReport(comparison),
    parsed.values.get('out'),
    io,
  );
  return exitCodeFor(comparison);
}

function importCommand(parsed: ParsedArgs, io: Io): number {
  const file = parsed.positionals[0];
  const suite = parsed.values.get('suite');
  if (!file || !suite) throw new ConfigError('import needs SCORES.jsonl and --suite NAME');
  const results: ResultsFile = {
    schema: RESULTS_SCHEMA_VERSION,
    tool: { name: 'errorbar', version: VERSION },
    created_at: new Date().toISOString(),
    git: detectGit(process.env, process.cwd()),
    gate: { ...DEFAULT_GATE },
    suites: [importFile(path.resolve(file), suite)],
  };
  const out = parsed.values.get('out') ?? DEFAULT_OUT;
  writeResults(out, results);
  io.err(`Wrote ${out}\n`);
  io.out(`${describeScores(results)}\n`);
  return 0;
}

function initCommand(parsed: ParsedArgs, io: Io): number {
  const directory = parsed.positionals[0] ?? '.';
  const written = initProject({ directory, mock: parsed.switches.has('mock') });
  io.out(
    `Created:\n${written.map((f) => `  ${f}`).join('\n')}\n\nNext: add an ANTHROPIC_API_KEY secret, then run \`errorbar run\`.\n`,
  );
  return 0;
}

export async function main(argv: string[], io: Io): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === 'help' || command === '--help' || command === '-h') {
    io.out(USAGE);
    return 0;
  }
  if (command === 'version' || command === '--version' || command === '-v') {
    io.out(`${VERSION}\n`);
    return 0;
  }
  const spec = SPECS[command];
  if (!spec) throw new ConfigError(`Unknown command "${command}". Run \`errorbar help\`.`);
  const parsed = parseArgs(rest, spec);
  switch (command) {
    case 'run':
      return runCommand(parsed, io);
    case 'compare':
      return compareCommand(parsed, io);
    case 'import':
      return importCommand(parsed, io);
    default:
      return initCommand(parsed, io);
  }
}
