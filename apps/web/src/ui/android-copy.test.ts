// The texts the Android app shows in place of the browser's (D298): its storage is never evicted,
// its shell's picker does not lock the vault (D294), and nothing is dropped on a phone.

import { describe, expect, it } from 'vitest';

import { MESSAGES } from '../i18n/messages';
import { warnsHiddenExport } from './Settings';
import { storageTexts } from './StorageState';
import { dropHint } from './Wizard';

const m = MESSAGES.en;

describe('the storage state (D196, D298)', () => {
  it('keeps the browser texts and the request to keep the storage on the web and in the extension', () => {
    for (const kind of ['web', 'extension'] as const) {
      const t = storageTexts(m, kind);
      expect(t.notKeptOnly).toBe(m.storage.notKeptOnly);
      expect(t.nearlyFull).toBe(m.storage.nearlyFull);
      expect(t.persistence(true)).toBe(m.storage.kept);
      expect(t.persistence(false)).toBe(m.storage.notKept);
      expect(t.persistence(null)).toBe(m.storage.unknown);
      expect(t.canAsk).toBe(true);
    }
  });

  it('says on Android that the vault goes only with the app or its data, and asks nothing', () => {
    const t = storageTexts(m, 'android');
    expect(t.notKeptOnly).toBe(
      'This is the only device of the vault: if the app is uninstalled or its data is cleared, only a backup and the Recovery Phrase bring the vault back. Make a backup, and pair another device.',
    );
    expect(t.nearlyFull).toBe(
      'Storage on this device is nearly full: BlindVault uses {percent} of what the app may use. Free some space, or the app may fail to save changes.',
    );
    for (const persisted of [true, false, null]) {
      expect(t.persistence(persisted)).toBe(
        'The vault lives in the app’s data: it goes only if the app is uninstalled or its data is cleared. Keep a recent backup.',
      );
    }
    expect(t.canAsk).toBe(false);
    for (const text of [t.notKeptOnly, t.nearlyFull, t.persistence(false)]) {
      expect(text).not.toMatch(/browser/i);
    }
  });
});

describe('the warning that hiding the app during an export locks it (D294, D298)', () => {
  it('shows on the web and in the extension when the hidden-app lock is immediate', () => {
    expect(warnsHiddenExport('web', 0)).toBe(true);
    expect(warnsHiddenExport('extension', 0)).toBe(true);
    expect(warnsHiddenExport('web', 30)).toBe(false);
  });

  it('is left out of the Android app, whose picker does not lock the vault', () => {
    expect(warnsHiddenExport('android', 0)).toBe(false);
    expect(warnsHiddenExport('android', 30)).toBe(false);
  });
});

describe('the file step’s hint (D254, D298)', () => {
  it('offers to drop the file on the web and in the extension', () => {
    expect(dropHint(m, 'web', '.bvault')).toBe('or drop it here · .bvault');
    expect(dropHint(m, 'extension', '.csv,.json')).toBe('or drop it here · .csv, .json');
  });

  it('names only the types in the Android app', () => {
    expect(dropHint(m, 'android', '.bvault')).toBe('.bvault');
    expect(dropHint(m, 'android', '.csv,.json')).toBe('.csv, .json');
  });
});
