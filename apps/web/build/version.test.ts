import { describe, expect, it } from 'vitest';

import { versionFile } from './version';

describe('version.txt (D191)', () => {
  it('holds the version on one line', () => {
    expect(versionFile('0.0.0')).toBe('0.0.0\n');
    expect(versionFile('1.2.3-rc.1+b7')).toBe('1.2.3-rc.1+b7\n');
  });

  it.each([
    ['empty', ''],
    ['two lines', '1.0.0\n1.0.1'],
    ['a space', '1.0 beta'],
    ['markup', '<b>1</b>'],
    ['a leading dot', '.1'],
    ['65 characters', '9'.repeat(65)],
  ])('refuses a version that is %s, as the service worker would', (_, version) => {
    expect(() => versionFile(version)).toThrow('cannot be written');
  });
});
