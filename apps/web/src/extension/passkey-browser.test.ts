import { describe, expect, it, vi } from 'vitest';

import { PASSKEY_SCRIPTS, passkeySwitch, windowToken } from './passkey-browser';

function api(granted: boolean, registered: string[] = []) {
  let held = granted;
  let scripts = [...registered];
  const calls: string[] = [];
  return {
    calls,
    scripts: () => scripts,
    api: {
      permissions: {
        contains: vi.fn(() => Promise.resolve(held)),
        request: vi.fn(() => {
          calls.push('request');
          held = granted;
          return Promise.resolve(granted);
        }),
        remove: vi.fn(() => {
          calls.push('remove');
          held = false;
          return Promise.resolve(true);
        }),
      },
      scripting: {
        registerContentScripts: vi.fn((list: readonly object[]) => {
          const ids = list.map((s) => (s as { id: string }).id);
          if (ids.some((id) => scripts.includes(id))) {
            return Promise.reject(new Error('Duplicate script ID'));
          }
          calls.push(`register ${ids.join(' ')}`);
          scripts = [...scripts, ...ids];
          return Promise.resolve();
        }),
        unregisterContentScripts: vi.fn(({ ids }: { ids: string[] }) => {
          calls.push(`unregister ${ids.join(' ')}`);
          scripts = scripts.filter((s) => !ids.includes(s));
          return Promise.resolve();
        }),
        getRegisteredContentScripts: vi.fn(({ ids }: { ids: string[] }) =>
          Promise.resolve(scripts.filter((s) => ids.includes(s)).map((id) => ({ id }))),
        ),
      },
    },
  };
}

describe('passkeySwitch (extension.md §7.1)', () => {
  it('registers both scripts at document_start in every frame, the first in the MAIN world', () => {
    expect(PASSKEY_SCRIPTS).toEqual([
      {
        id: 'passkey-main',
        js: ['passkey-main.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
        world: 'MAIN',
      },
      {
        id: 'passkey-isolated',
        js: ['passkey-isolated.js'],
        matches: ['<all_urls>'],
        runAt: 'document_start',
        allFrames: true,
      },
    ]);
  });

  it('asks the permission first, and registers only once granted', async () => {
    const yes = api(true);
    await expect(passkeySwitch(yes.api).enable()).resolves.toBe(true);
    expect(yes.calls).toEqual(['request', 'register passkey-main passkey-isolated']);
    const no = api(false);
    await expect(passkeySwitch(no.api).enable()).resolves.toBe(false);
    expect(no.calls).toEqual(['request']);
  });

  it('turns off by unregistering and giving the permission back', async () => {
    const a = api(true, ['passkey-main', 'passkey-isolated', 'other']);
    const s = passkeySwitch(a.api);
    await s.disable();
    expect(a.calls).toEqual(['unregister passkey-main passkey-isolated', 'remove']);
    expect(a.scripts()).toEqual(['other']);
    await expect(s.on()).resolves.toBe(false);
  });

  it('registers again at start when the permission is held, replacing what is there (D289)', async () => {
    const held = api(true, ['passkey-isolated']);
    await passkeySwitch(held.api).restore();
    expect(held.calls).toEqual([
      'unregister passkey-isolated',
      'register passkey-main passkey-isolated',
    ]);
    const none = api(false);
    await passkeySwitch(none.api).restore();
    expect(none.calls).toEqual([]);
  });
});

describe('windowToken (§7.7)', () => {
  it('draws 32 lowercase hexadecimal digits, a new one each time', () => {
    const a = windowToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(windowToken()).not.toBe(a);
  });
});
