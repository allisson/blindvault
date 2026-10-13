import { describe, expect, it } from 'vitest';

import { backupFileName, recordIdPrefix } from './backup-file';

describe('backup file (D181)', () => {
  it('names the file by the local date of the export, without the vaultId', () => {
    expect(backupFileName(new Date(2026, 0, 9, 23, 59).getTime())).toBe(
      'blindvault-2026-01-09.bvault',
    );
    expect(backupFileName(new Date(2031, 11, 31, 0, 0).getTime())).toBe(
      'blindvault-2031-12-31.bvault',
    );
  });

  it('names a record by the first 8 hex digits of its recordId', () => {
    expect(recordIdPrefix(new Uint8Array([0x0a, 0xff, 0x00, 0x7b, 0x99, 0x99]))).toBe('0aff007b');
  });
});
