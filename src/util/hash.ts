import { createHash } from 'node:crypto';

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).sort(([a], [b]) =>
      a < b ? -1 : a > b ? 1 : 0,
    );
    return Object.fromEntries(entries.map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** JSON with object keys sorted, so equal data always serialises to equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value)) ?? 'null';
}

/** Short stable fingerprint of any JSON-able value (12 hex chars of SHA-256). */
export function shortHash(value: unknown): string {
  const text = typeof value === 'string' ? value : canonicalJson(value);
  return createHash('sha256').update(text).digest('hex').slice(0, 12);
}
