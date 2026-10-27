import { readFileSync } from 'node:fs';
import { ConfigError } from './errors';
import { shortHash } from './util/hash';
import { errorMessage, truncate } from './util/text';

/** One test case. */
export interface DatasetRow {
  /** Stable identifier. Cases are paired across runs by this, so never reuse or rename ids. */
  id: string;
  /** Values substituted into the prompt, or passed to your command. */
  vars: Record<string, unknown>;
  /** The reference answer, for `equals`, `contains` and judge rubrics. Never shown to your command. */
  expected?: string;
  /** Ids of the documents that should be retrieved, for `recall_at_k` and `mrr`. */
  relevant_ids?: string[];
  tags?: string[];
  notes?: string;
}

const ALLOWED_KEYS = new Set(['id', 'vars', 'expected', 'relevant_ids', 'tags', 'notes']);

function parseRow(line: string, where: string): DatasetRow {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (error) {
    throw new ConfigError(`${where}: not valid JSON (${errorMessage(error)})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new ConfigError(`${where}: each line must be a JSON object`);
  }
  const obj = raw as Record<string, unknown>;

  for (const key of Object.keys(obj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(
        `${where}: unknown field \`${key}\`. Allowed: ${[...ALLOWED_KEYS].join(', ')}. (A typo here would silently turn a metric off.)`,
      );
    }
  }
  if (typeof obj.id !== 'string' || obj.id.length === 0 || obj.id.length > 200) {
    throw new ConfigError(`${where}: \`id\` must be a non-empty string of at most 200 characters`);
  }
  if (
    obj.vars !== undefined &&
    (typeof obj.vars !== 'object' || obj.vars === null || Array.isArray(obj.vars))
  ) {
    throw new ConfigError(`${where}: \`vars\` must be an object`);
  }
  if (obj.expected !== undefined && typeof obj.expected !== 'string') {
    throw new ConfigError(`${where}: \`expected\` must be a string`);
  }
  if (
    obj.relevant_ids !== undefined &&
    !(Array.isArray(obj.relevant_ids) && obj.relevant_ids.every((id) => typeof id === 'string'))
  ) {
    throw new ConfigError(`${where}: \`relevant_ids\` must be an array of strings`);
  }
  if (
    obj.tags !== undefined &&
    !(Array.isArray(obj.tags) && obj.tags.every((t) => typeof t === 'string'))
  ) {
    throw new ConfigError(`${where}: \`tags\` must be an array of strings`);
  }
  if (obj.notes !== undefined && typeof obj.notes !== 'string') {
    throw new ConfigError(`${where}: \`notes\` must be a string`);
  }
  return { ...obj, vars: (obj.vars as Record<string, unknown> | undefined) ?? {} } as DatasetRow;
}

export function parseDataset(text: string, source: string): DatasetRow[] {
  const rows: DatasetRow[] = [];
  const seen = new Map<string, number>();
  text.split(/\r?\n/).forEach((line, index) => {
    if (line.trim().length === 0) return;
    const where = `${source}:${index + 1}`;
    const row = parseRow(line, where);
    const earlier = seen.get(row.id);
    if (earlier !== undefined) {
      throw new ConfigError(`${where}: id "${row.id}" is already used on line ${earlier}`);
    }
    seen.set(row.id, index + 1);
    rows.push(row);
  });
  if (rows.length === 0) throw new ConfigError(`${source}: the dataset has no cases`);
  return rows;
}

export function loadDataset(file: string): DatasetRow[] {
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    throw new ConfigError(`Could not read dataset ${file}: ${errorMessage(error)}`);
  }
  return parseDataset(text, file);
}

/** Fingerprint of everything about a row that can change what a correct answer is. */
export function rowHash(row: DatasetRow): string {
  return shortHash(row);
}

/** Short readable version of a row's inputs for reports. */
export function rowInput(row: DatasetRow): string {
  return truncate(JSON.stringify(row.vars), 500);
}
