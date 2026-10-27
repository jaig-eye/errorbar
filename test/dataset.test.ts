import { describe, expect, it } from 'vitest';
import { parseDataset, rowHash, rowInput } from '../src/dataset';
import { ConfigError } from '../src/errors';

const line = (row: object) => JSON.stringify(row);

describe('parseDataset', () => {
  it('reads cases, skips blank lines and defaults vars', () => {
    const rows = parseDataset(
      `${line({ id: 'a', vars: { q: 1 }, expected: 'x' })}\n\n${line({ id: 'b' })}\n`,
      'd.jsonl',
    );
    expect(rows.map((r) => r.id)).toEqual(['a', 'b']);
    expect(rows[1]?.vars).toEqual({});
  });

  it('accepts Windows line endings', () => {
    expect(parseDataset(`${line({ id: 'a' })}\r\n${line({ id: 'b' })}\r\n`, 'd')).toHaveLength(2);
  });

  it.each([
    ['not JSON', '{oops', 'd:1: not valid JSON'],
    ['not an object', '[1]', 'must be a JSON object'],
    ['no id', line({ vars: {} }), '`id` must be'],
    ['bad vars', line({ id: 'a', vars: [1] }), '`vars` must be an object'],
    ['bad expected', line({ id: 'a', expected: 5 }), '`expected` must be a string'],
    ['bad relevant_ids', line({ id: 'a', relevant_ids: [1] }), '`relevant_ids`'],
    ['typo in a field', line({ id: 'a', expectd: 'x' }), 'unknown field `expectd`'],
  ])('rejects %s', (_label, text, message) => {
    expect(() => parseDataset(text, 'd')).toThrow(message);
  });

  it('rejects a repeated id and says where the first one is', () => {
    expect(() => parseDataset(`${line({ id: 'a' })}\n${line({ id: 'a' })}`, 'd')).toThrow(
      'id "a" is already used on line 1',
    );
  });

  it('rejects an empty dataset', () => {
    expect(() => parseDataset('\n\n', 'd')).toThrow(ConfigError);
  });
});

describe('rowHash', () => {
  it('changes when anything about the case changes, and only then', () => {
    const base = { id: 'a', vars: { q: 'x' }, expected: 'y' };
    expect(rowHash(base)).toBe(rowHash({ ...base }));
    expect(rowHash(base)).not.toBe(rowHash({ ...base, expected: 'z' }));
    expect(rowHash(base)).not.toBe(rowHash({ ...base, vars: { q: 'w' } }));
  });

  it('ignores the order of keys', () => {
    expect(rowHash({ id: 'a', vars: { a: 1, b: 2 } })).toBe(
      rowHash({ id: 'a', vars: { b: 2, a: 1 } }),
    );
  });
});

describe('rowInput', () => {
  it('shortens long inputs', () => {
    expect(rowInput({ id: 'a', vars: { q: 'x'.repeat(2000) } }).length).toBeLessThanOrEqual(500);
  });
});
