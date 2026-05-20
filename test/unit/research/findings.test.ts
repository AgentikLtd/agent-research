import { describe, it, expect } from 'vitest';
import { parseFindings, parseAngles, FindingsParseError } from '../../../src/research/findings.js';

const validFinding = {
  claim: 'X shipped', detail: 'Detail.', label: 'GA', confidence: 'high',
  category: 'releases', sources: [{ url: 'https://e.example/a' }], flags: [],
};

describe('parseFindings', () => {
  it('parses a fenced JSON array of findings', () => {
    const text = 'Here:\n```json\n' + JSON.stringify([validFinding]) + '\n```';
    const out = parseFindings(text);
    expect(out).toHaveLength(1);
    expect(out[0]?.claim).toBe('X shipped');
  });
  it('parses a bare JSON array', () => {
    expect(parseFindings(JSON.stringify([validFinding]))).toHaveLength(1);
  });
  it('throws FindingsParseError on non-JSON', () => {
    expect(() => parseFindings('no json here')).toThrow(FindingsParseError);
  });
  it('throws FindingsParseError on a schema-invalid finding', () => {
    expect(() => parseFindings(JSON.stringify([{ claim: 'x' }]))).toThrow(FindingsParseError);
  });
});

describe('parseAngles', () => {
  it('parses a JSON array of strings', () => {
    expect(parseAngles('```json\n["a","b"]\n```')).toEqual(['a', 'b']);
  });
  it('throws on a non-array', () => {
    expect(() => parseAngles('{"a":1}')).toThrow(FindingsParseError);
  });
});
