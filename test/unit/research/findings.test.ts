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
  it('throws on an object with no angle array', () => {
    expect(() => parseAngles('{"a":1}')).toThrow(FindingsParseError);
  });
  it('parses prose-wrapped output with a fenced array', () => {
    const text =
      'Here is the research plan:\n```json\n["one","two","three"]\n```\nThat covers it.';
    expect(parseAngles(text)).toEqual(['one', 'two', 'three']);
  });
  it('unwraps an object that nests the angle array under a key', () => {
    expect(parseAngles('{"angles":[{"q":"a"},{"q":"b"}]}')).toEqual(['a', 'b']);
  });
  it('extracts angle text from an array of objects', () => {
    const text = '[{"angle":"first"},{"question":"second"},{"text":"third"}]';
    expect(parseAngles(text)).toEqual(['first', 'second', 'third']);
  });
  it('tolerates a trailing comma in the array', () => {
    expect(parseAngles('["a","b","c",]')).toEqual(['a', 'b', 'c']);
  });
  it('throws when no angles can be extracted', () => {
    expect(() => parseAngles('[]')).toThrow(FindingsParseError);
  });
  it('salvages complete angles from an array truncated mid-string', () => {
    // A thinking model can exhaust its output-token budget mid-array, leaving
    // the final string unterminated. The complete angles before it must survive.
    const truncated =
      '["first complete angle","second complete angle","third angle cut off mid-sen';
    expect(parseAngles(truncated)).toEqual([
      'first complete angle',
      'second complete angle',
    ]);
  });
  it('salvages angles from a truncated unclosed fenced block', () => {
    expect(parseAngles('```json\n["alpha","beta","gamma is incompl')).toEqual([
      'alpha',
      'beta',
    ]);
  });
  it('salvages complete objects from a truncated array of objects', () => {
    const truncated = '[{"angle":"one"},{"angle":"two"},{"angle":"thr';
    expect(parseAngles(truncated)).toEqual(['one', 'two']);
  });
  it('throws when the array truncates before the first angle completes', () => {
    expect(() => parseAngles('["only angle cut off mid')).toThrow(FindingsParseError);
  });
});
