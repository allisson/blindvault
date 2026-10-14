import { describe, expect, it } from 'vitest';

import { type ReadyInput, readyAdvice } from './ready';

const CREATED: ReadyInput = {
  ready: { start: 'created' },
  devices: 'only-device',
  passkeys: true,
  exportable: true,
};
const RESTORED: ReadyInput = {
  ready: { start: 'restored', openedWith: 'phrase' },
  devices: 'readmit',
  passkeys: true,
  exportable: true,
};

describe('Vault ready recommendations (§13.3, D198)', () => {
  it('after a creation: passkey, backup, then pairing another device', () => {
    expect(readyAdvice(CREATED)).toEqual(['passkey', 'backup', 'pair']);
  });

  it('after a restore by the phrase with other devices: passkey, re-admission, backup', () => {
    expect(readyAdvice(RESTORED)).toEqual(['passkey', 'readmit', 'backup']);
  });

  it('recommends Check Recovery Phrase only after a restore by the export password (D43)', () => {
    expect(
      readyAdvice({ ...RESTORED, ready: { start: 'restored', openedWith: 'password' } }),
    ).toEqual(['passkey', 'check-phrase', 'readmit', 'backup']);
    expect(readyAdvice(RESTORED)).not.toContain('check-phrase');
    expect(readyAdvice(CREATED)).not.toContain('check-phrase');
  });

  it('recommends pairing instead of re-admission when no other device is left (D119, D186)', () => {
    expect(readyAdvice({ ...RESTORED, devices: 'only-device' })).toEqual([
      'passkey',
      'pair',
      'backup',
    ]);
  });

  it('recommends neither when the device is registered among others', () => {
    expect(readyAdvice({ ...RESTORED, devices: undefined })).toEqual(['passkey', 'backup']);
  });

  it('never offers re-admission after a creation', () => {
    expect(readyAdvice({ ...CREATED, devices: 'readmit' })).toEqual(['passkey', 'backup', 'pair']);
  });

  it('offers no passkey where the browser has none, and no backup where the vault cannot export', () => {
    expect(readyAdvice({ ...CREATED, passkeys: false })).toEqual(['backup', 'pair']);
    expect(readyAdvice({ ...CREATED, exportable: false })).toEqual(['passkey', 'pair']);
    expect(
      readyAdvice({
        ...RESTORED,
        ready: { start: 'restored', openedWith: 'password' },
        passkeys: false,
        exportable: false,
      }),
    ).toEqual(['check-phrase', 'readmit']);
  });

  it('after a pairing: passkey, then a backup, as the pair start of section 13.3 lists (D203)', () => {
    const paired: ReadyInput = { ...CREATED, ready: { start: 'paired' }, devices: undefined };
    expect(readyAdvice(paired)).toEqual(['passkey', 'backup']);
    expect(readyAdvice({ ...paired, passkeys: false, exportable: false })).toEqual([]);
  });
});
