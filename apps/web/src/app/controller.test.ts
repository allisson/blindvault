import { type KdfPort, type KdfRequest, MEMLIMIT } from '@blindvault/crypto';
import { VaultDatabase, acquireInstallationGuard, acquireVaultLock } from '@blindvault/storage';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it } from 'vitest';

import { VaultController } from './controller';

const PASSWORD = 'correct horse battery staple orbit';

/**
 * A stand-in for the Argon2id worker: the key is the password's bytes padded to 32, so another
 * password gives another key. Argon2id itself is tested in `packages/crypto`.
 */
function fakeKdf(log: KdfRequest['op'][] = []): () => KdfPort {
  return () => {
    const port: KdfPort = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        log.push(message.op);
        const key = new Uint8Array(32);
        key.set(message.password.subarray(0, 32));
        message.password.fill(0);
        const params =
          message.op === 'derive' ? message.params : { opslimit: 2, memlimit: MEMLIMIT };
        queueMicrotask(() => port.onmessage?.({ data: { ok: true, key, params } }));
      },
      terminate() {
        // nothing runs in the background
      },
    };
    return port;
  };
}

const controllers: VaultController[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});

function controller(factory = new IDBFactory(), log?: KdfRequest['op'][]) {
  const c = new VaultController({ factory, locks: navigator.locks, kdf: fakeKdf(log) });
  controllers.push(c);
  return c;
}

async function created(factory = new IDBFactory()) {
  const c = controller(factory);
  await c.start();
  await c.create(PASSWORD, 'Test device');
  return c;
}

function session(c: VaultController) {
  const s = c.status;
  if (s.kind !== 'unlocked') throw new Error(`not unlocked: ${s.kind}`);
  return s.session;
}

describe('vault controller', () => {
  it('starts with no vault, creates one and requests persistence', async () => {
    const factory = new IDBFactory();
    const persist: boolean[] = [];
    const c = new VaultController({
      factory,
      locks: navigator.locks,
      kdf: fakeKdf(),
      storage: { persist: () => Promise.resolve(persist.push(true) > 0) } as StorageManager,
    });
    controllers.push(c);
    await c.start();
    expect(c.status.kind).toBe('no-vault');
    await c.create(PASSWORD, 'Test device');
    expect(session(c).devices()).toHaveLength(1);
    expect(persist).toEqual([true]);
    expect((await factory.databases()).map((d) => d.name)).toEqual([
      `blindvault-${[...session(c).vaultId].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    ]);
  });

  it('locks, refuses a wrong password, and unlocks the same vault again', async () => {
    const c = await created();
    const vaultId = session(c).vaultId;
    const s = session(c);
    c.lock();
    expect(c.status.kind).toBe('locked');
    expect(s.locked).toBe(true);
    expect(await c.unlock('another password entirely')).toBe('wrong-password');
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(session(c).vaultId).toEqual(vaultId);
  });

  it('finds the vault at the next start, through its database', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    await first.close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('deletes an uncommitted database at start (D89)', async () => {
    const factory = new IDBFactory();
    (await VaultDatabase.open(new Uint8Array(16).fill(1), factory)).close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('is busy while another app window holds the installation guard (D97)', async () => {
    const guard = await acquireInstallationGuard();
    const c = controller();
    await c.start();
    expect(c.status.kind).toBe('busy');
    await guard?.release();
    await c.start();
    expect(c.status.kind).toBe('no-vault');
  });

  it('does not open a vault another app window holds, and takes it over (D51)', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    const firstSession = session(first);
    const second = controller(factory);
    await second.start();
    expect(second.status.kind).toBe('elsewhere');
    await second.takeOver();
    expect(second.status.kind).toBe('locked');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first.status.kind).toBe('elsewhere');
    expect(firstSession.locked).toBe(true);
    expect(await second.unlock(PASSWORD)).toBe('ok');
  });

  it('aborts a creation locked before its commit, persisting nothing (D104)', async () => {
    const factory = new IDBFactory();
    const c = controller(factory);
    await c.start();
    const pending = c.create(PASSWORD, 'Test device');
    c.lock();
    await pending;
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
    // The installation guard is free again.
    const guard = await acquireInstallationGuard();
    expect(guard).not.toBeNull();
    await guard?.release();
  });

  it('aborts a creation locked while its password is derived (D104)', async () => {
    const factory = new IDBFactory();
    let answer = () => {
      // replaced once the request is posted
    };
    const slow = () => {
      const port = fakeKdf()();
      const post = port.postMessage.bind(port);
      port.postMessage = (message, transfer) => {
        answer = () => {
          post(message, transfer);
        };
      };
      return port;
    };
    const c = new VaultController({ factory, locks: navigator.locks, kdf: slow });
    controllers.push(c);
    await c.start();
    const pending = c.create(PASSWORD, 'Test device');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(c.status.kind).toBe('creating');
    c.lock();
    answer();
    await pending;
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('aborts an unlock locked before it completes', async () => {
    const c = await created();
    c.lock();
    const pending = c.unlock(PASSWORD);
    c.lock();
    expect(await pending).toBe('ok');
    expect(c.status.kind).toBe('locked');
  });

  it('changes the password only with the current one (D168)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log);
    await c.start();
    await c.create(PASSWORD, 'Test device');
    expect(await c.changePassword('not the password', 'a new long passphrase here')).toBe(
      'wrong-password',
    );
    log.length = 0;
    expect(await c.changePassword(PASSWORD, 'a new long passphrase here')).toBe('ok');
    // The current one is derived at the stored parameters; the new one is calibrated (D9).
    expect(log).toEqual(['derive', 'calibrate']);
    c.lock();
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    expect(await c.unlock('a new long passphrase here')).toBe('ok');
  });

  it('sets preferences and refuses one outside its range', async () => {
    const c = await created();
    const next = { autoLockMinutes: 10, hiddenLockSeconds: 0, clipboardClearSeconds: 60 };
    await c.setPreferences(next);
    expect(session(c).preferences).toEqual(next);
    await expect(c.setPreferences({ ...next, autoLockMinutes: 0 })).rejects.toThrow(RangeError);
  });

  it('reports a corrupt or newer Local Config instead of unlocking', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    const vaultId = session(first).vaultId;
    await first.close();
    const db = await VaultDatabase.open(vaultId, factory);
    await db.updateLocalConfig(() => new Uint8Array([0xa0]));
    db.close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('corrupt');
    const lock = await acquireVaultLock(vaultId);
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});
