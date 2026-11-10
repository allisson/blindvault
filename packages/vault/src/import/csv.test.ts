import { describe, expect, it } from 'vitest';

import { parseCsvRows } from './csv';

// Copied from BlindPass (`apps/web/src/lib/import/__tests__/csv.test.ts`).
describe('parseCsvRows', () => {
  it('parses a header and a row', () => {
    expect(parseCsvRows('name,url\nGoogle,https://google.com')).toEqual([
      ['name', 'url'],
      ['Google', 'https://google.com'],
    ]);
  });

  it('keeps commas, doubled quotes and line breaks inside quoted cells', () => {
    expect(parseCsvRows('a,b\n"hello, world","she said ""hi"""')).toEqual([
      ['a', 'b'],
      ['hello, world', 'she said "hi"'],
    ]);
    expect(parseCsvRows('notes\n"a\n\nb"')).toEqual([['notes'], ['a\n\nb']]);
  });

  it('turns CRLF and CR into LF, inside and outside quoted cells', () => {
    expect(parseCsvRows('a,b\r\n1,2\r3,"x\r\ny\rz"')).toEqual([
      ['a', 'b'],
      ['1', '2'],
      ['3', 'x\ny\nz'],
    ]);
  });

  it('drops a leading BOM', () => {
    expect(parseCsvRows('\uFEFFname,url\nGoogle,x')[0]).toEqual(['name', 'url']);
  });

  it('skips blank lines and a trailing newline, and keeps empty cells', () => {
    expect(parseCsvRows('a,b,c\n\n1,,3\n')).toEqual([
      ['a', 'b', 'c'],
      ['1', '', '3'],
    ]);
    expect(parseCsvRows('')).toEqual([]);
    expect(parseCsvRows('\n')).toEqual([]);
  });

  it('keeps an unterminated quoted cell to the end of the input', () => {
    expect(parseCsvRows('a\n"open')).toEqual([['a'], ['open']]);
  });
});
