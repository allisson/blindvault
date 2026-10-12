import { describe, expect, it } from 'vitest';

import { requestPersistence, storageStatus } from './persistence';

function manager(overrides: Partial<StorageManager>): StorageManager {
  return overrides as StorageManager;
}

describe('persistent storage (overview §6, D55)', () => {
  it('requests persistence and reports the answer', async () => {
    expect(await requestPersistence(manager({ persist: () => Promise.resolve(true) }))).toBe(true);
    expect(await requestPersistence(manager({ persist: () => Promise.resolve(false) }))).toBe(
      false,
    );
    expect(
      await requestPersistence(manager({ persist: () => Promise.reject(new Error('x')) })),
    ).toBe(false);
    expect(await requestPersistence(manager({}))).toBe(false);
    // Node has no StorageManager: the default is unsupported, not an error.
    expect(await requestPersistence()).toBe(false);
  });

  it('reports the status and the estimate, null where the browser gives none', async () => {
    const full = manager({
      persisted: () => Promise.resolve(true),
      estimate: () => Promise.resolve({ usage: 10, quota: 100 }),
    });
    expect(await storageStatus(full)).toEqual({ persisted: true, usage: 10, quota: 100 });
    const partial = manager({
      persisted: () => Promise.reject(new Error('x')),
      estimate: () => Promise.resolve({}),
    });
    expect(await storageStatus(partial)).toEqual({ persisted: null, usage: null, quota: null });
    const failing = manager({ estimate: () => Promise.reject(new Error('x')) });
    expect(await storageStatus(failing)).toEqual({ persisted: null, usage: null, quota: null });
    expect(await storageStatus()).toEqual({ persisted: null, usage: null, quota: null });
  });
});
