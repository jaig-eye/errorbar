import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { ConfigError } from '../errors';
import { RESULTS_SCHEMA_VERSION, type ResultsFile } from '../types';
import { errorMessage } from '../util/text';

export function parseResults(text: string, source: string): ResultsFile {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ConfigError(`${source} is not valid JSON: ${errorMessage(error)}`);
  }
  const file = raw as Partial<ResultsFile> | null;
  if (!file || typeof file !== 'object' || !Array.isArray(file.suites)) {
    throw new ConfigError(`${source} is not an errorbar results file`);
  }
  if (file.schema !== RESULTS_SCHEMA_VERSION) {
    throw new ConfigError(
      `${source} uses results schema ${String(file.schema)}, but this errorbar reads schema ${RESULTS_SCHEMA_VERSION}. Re-run the baseline with the same errorbar version.`,
    );
  }
  for (const suite of file.suites) {
    if (typeof suite?.name !== 'string' || !Array.isArray(suite.cases) || !suite.metrics) {
      throw new ConfigError(`${source} has a malformed suite`);
    }
  }
  return file as ResultsFile;
}

export function readResults(file: string): ResultsFile {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read ${file}: ${errorMessage(error)}`);
  }
  return parseResults(text, file);
}

export function writeResults(file: string, results: ResultsFile): void {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(results, null, 2)}\n`);
}
