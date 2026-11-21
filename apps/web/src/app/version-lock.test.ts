import { describe, expect, it, vi } from 'vitest';

import { type Build, STORAGE_KEY, VersionLock, readBuild, vaultExists } from './version-lock';

const OLD: Build = { version: '1.0.0', hash: 'a'.repeat(64) };
const NEW: Build = { version: '1.0.1', hash: 'b'.repeat(64) };

function memory(initial?: string) {
  const items = new Map<string, string>(initial === undefined ? [] : [[STORAGE_KEY, initial]]);
  return {
    items,
    getItem: (key: string) => items.get(key) ?? null,
    setItem: vi.fn((key: string, value: string) => {
      items.set(key, value);
    }),
  };
}

function lock(stored: string | undefined, running: Build | undefined, vault: boolean) {
  const storage = memory(stored);
  const exists = vi.fn(() => Promise.resolve(vault));
  const versionLock = new VersionLock({
    storage,
    running: () => Promise.resolve(running),
    vaultExists: exists,
  });
  return { storage, exists, versionLock };
}

describe('the version lock (extension.md §8.2)', () => {
  it('checks before anything opens', () => {
    expect(lock(undefined, NEW, false).versionLock.getState()).toEqual({ kind: 'checking' });
  });

  it('records a first installation with no vault, trust on first use', async () => {
    const { storage, versionLock } = lock(undefined, NEW, false);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'confirmed' });
    expect(readBuild(storage.getItem(STORAGE_KEY))).toEqual(NEW);
  });

  it('passes the build the user confirmed, without asking about the vault', async () => {
    const { exists, storage, versionLock } = lock(JSON.stringify(NEW), NEW, true);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'confirmed' });
    expect(exists).not.toHaveBeenCalled();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it.each([
    ['a changed hash', { ...OLD, hash: NEW.hash }],
    ['a changed version', { ...OLD, version: NEW.version }],
  ])('stops on %s until confirmed, then records it', async (_, previous) => {
    const { storage, versionLock } = lock(JSON.stringify(previous), NEW, true);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'changed', previous, running: NEW });
    expect(storage.setItem).not.toHaveBeenCalled();
    versionLock.confirm();
    expect(versionLock.getState()).toEqual({ kind: 'confirmed' });
    expect(readBuild(storage.getItem(STORAGE_KEY))).toEqual(NEW);
  });

  it('stops on a vault with no record, the previous build unknown', async () => {
    const { versionLock } = lock(undefined, NEW, true);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'changed', previous: undefined, running: NEW });
  });

  it('stops on a vault with an unreadable record', async () => {
    const { versionLock } = lock('{"version":"1.0.0"', NEW, true);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'changed', previous: undefined, running: NEW });
  });

  it('opens where no asset manifest is served (the dev server)', async () => {
    const { storage, versionLock } = lock(JSON.stringify(OLD), undefined, true);
    await versionLock.start();
    expect(versionLock.getState()).toEqual({ kind: 'confirmed' });
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('ignores a confirmation while nothing is asked', async () => {
    const { storage, versionLock } = lock(JSON.stringify(NEW), NEW, true);
    versionLock.confirm();
    await versionLock.start();
    versionLock.confirm();
    expect(storage.setItem).not.toHaveBeenCalled();
  });

  it('tells its subscribers of each change', async () => {
    const { versionLock } = lock(JSON.stringify(OLD), NEW, true);
    const listener = vi.fn();
    versionLock.subscribe(listener);
    await versionLock.start();
    versionLock.confirm();
    expect(listener).toHaveBeenCalledTimes(2);
  });
});

describe('readBuild', () => {
  it.each([
    ['nothing', null],
    ['not JSON', 'x'],
    ['not an object', '"1.0.0"'],
    ['null', 'null'],
    ['no hash', '{"version":"1.0.0"}'],
    ['a hash in upper case', JSON.stringify({ version: '1.0.0', hash: 'A'.repeat(64) })],
    ['a short hash', JSON.stringify({ version: '1.0.0', hash: 'a'.repeat(63) })],
    ['a version with markup', JSON.stringify({ version: '<b>', hash: 'a'.repeat(64) })],
    ['a number as version', JSON.stringify({ version: 1, hash: 'a'.repeat(64) })],
  ])('refuses %s', (_, text) => {
    expect(readBuild(text)).toBeUndefined();
  });

  it('keeps only the version and the hash', () => {
    expect(readBuild(JSON.stringify({ ...OLD, extra: 1 }))).toEqual(OLD);
  });
});

describe('vaultExists', () => {
  function app(kind: string) {
    const listeners = new Set<() => void>();
    return {
      status: { kind },
      subscribe: vi.fn((listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      }),
      set(next: string) {
        this.status = { kind: next };
        for (const l of listeners) l();
      },
      listeners,
    };
  }

  it('answers at once once the app has started', async () => {
    const a = app('no-vault');
    await expect(vaultExists(a)).resolves.toBe(false);
    expect(a.subscribe).not.toHaveBeenCalled();
  });

  it('waits for the app to leave starting, then stops listening', async () => {
    const a = app('starting');
    const answer = vaultExists(a);
    a.set('starting');
    a.set('locked');
    await expect(answer).resolves.toBe(true);
    expect(a.listeners.size).toBe(0);
  });

  it.each(['locked', 'elsewhere', 'busy', 'corrupt', 'update-required', 'incomplete'])(
    'counts %s as a vault',
    async (kind) => {
      await expect(vaultExists(app(kind))).resolves.toBe(true);
    },
  );
});
