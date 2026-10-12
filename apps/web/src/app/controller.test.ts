import { type KdfPort, type KdfRequest, MEMLIMIT } from '@blindvault/crypto';
import { VaultDatabase, acquireInstallationGuard, acquireVaultLock } from '@blindvault/storage';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { VaultController } from './controller';
import { PasskeyCancelledError, type PasskeyPort, type PasskeyResult } from './passkey';

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

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;

/**
 * A stand-in authenticator: the PRF output is the PRF input XOR a per-credential byte, so it is
 * stable per credential and input. `flags` and `prf` change what the next ceremonies return.
 */
class FakeAuthenticator implements PasskeyPort {
  flags = UP | UV;
  /** `create`: PRF output at create, only on a later get, or never. */
  prf: 'create' | 'get' | 'none' = 'create';
  cancel = false;
  signal = true;
  readonly calls: string[] = [];
  readonly forgotten: Uint8Array[] = [];
  #next = 1;
  readonly #known = new Set<number>();

  #result(credentialId: Uint8Array, prfInput: Uint8Array, output: boolean): PasskeyResult {
    const authenticatorData = new Uint8Array(37);
    authenticatorData[32] = this.flags;
    const key = credentialId[0] ?? 0;
    return {
      credentialId: credentialId.slice(),
      authenticatorData,
      ...(output ? { prfOutput: prfInput.map((b) => b ^ key) } : {}),
    };
  }

  supported() {
    return Promise.resolve(true);
  }

  create(prfInput: Uint8Array) {
    this.calls.push('create');
    if (this.cancel) return Promise.reject(new PasskeyCancelledError());
    const id = this.#next++;
    this.#known.add(id);
    return Promise.resolve(this.#result(new Uint8Array([id]), prfInput, this.prf === 'create'));
  }

  get(credentialId: Uint8Array, prfInput: Uint8Array) {
    this.calls.push('get');
    if (this.cancel || !this.#known.has(credentialId[0] ?? 0)) {
      return Promise.reject(new PasskeyCancelledError());
    }
    return Promise.resolve(this.#result(credentialId, prfInput, this.prf !== 'none'));
  }

  forget(credentialId: Uint8Array) {
    this.forgotten.push(credentialId);
    return Promise.resolve(this.signal);
  }
}

function controller(factory = new IDBFactory(), log?: KdfRequest['op'][], passkeys?: PasskeyPort) {
  const c = new VaultController({
    factory,
    locks: navigator.locks,
    kdf: fakeKdf(log),
    ...(passkeys ? { passkeys } : {}),
  });
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

  it('fails a near miss and an unrelated password alike, storing and logging nothing (Gate A)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log);
    await c.start();
    await c.create(PASSWORD, 'Test device');
    const vaultId = session(c).vaultId;
    c.lock();
    const stored = async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      try {
        return await db.localConfig();
      } finally {
        db.close();
      }
    };
    const before = await stored();
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    log.length = 0;
    // The stand-in KDF reads the first 32 bytes: each near miss differs within them.
    const nearMiss = `${PASSWORD.slice(0, 20)}X${PASSWORD.slice(21)}`;
    for (const attempt of [nearMiss, PASSWORD.slice(1), 'zz', PASSWORD.toUpperCase()]) {
      expect(await c.unlock(attempt)).toBe('wrong-password');
      expect(c.status).toEqual({ kind: 'locked' });
    }
    // Every attempt runs one full derivation at the stored parameters, near miss or not.
    expect(log).toEqual(['derive', 'derive', 'derive', 'derive']);
    for (const spy of consoleCalls) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(await stored()).toEqual(before);
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('after lock, derives, asks the authenticator and writes nothing until a new unlock (CRYPTO-INV-010)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const authenticator = new FakeAuthenticator();
    const c = controller(factory, log, authenticator);
    await c.start();
    await c.create(PASSWORD, 'Test device');
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    const old = session(c);
    const vaultId = old.vaultId;
    const preferences = old.preferences;
    c.lock();
    expect(old.locked).toBe(true);
    const stored = async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      try {
        return await db.localConfig();
      } finally {
        db.close();
      }
    };
    const before = await stored();
    log.length = 0;
    authenticator.calls.length = 0;

    await c.changePassword(PASSWORD, 'a new password nobody will guess');
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    expect(await c.removePasskey()).toBe('by-hand');
    await c.setPreferences({ ...preferences, clipboardClearSeconds: 45 });
    expect(log).toEqual([]);
    expect(authenticator.calls).toEqual([]);
    expect(authenticator.forgotten).toEqual([]);
    expect(c.status).toEqual({ kind: 'locked' });
    expect(await stored()).toEqual(before);

    // A new unlock opens a new session; the old one stays locked.
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(session(c)).not.toBe(old);
    expect(old.locked).toBe(true);
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

describe('passkey unlock (§5.5, D75, D84, D172)', () => {
  async function withPasskey(authenticator = new FakeAuthenticator(), factory = new IDBFactory()) {
    const c = controller(factory, undefined, authenticator);
    await c.start();
    await c.create(PASSWORD, 'Test device');
    return { c, authenticator, factory };
  }

  it('sets up a passkey with the current password and unlocks with it', async () => {
    const { c, authenticator, factory } = await withPasskey();
    expect(c.hasPasskey).toBe(false);
    expect(await c.passkeysSupported()).toBe(true);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    expect(c.hasPasskey).toBe(true);
    expect(authenticator.forgotten).toEqual([]);
    const vaultId = session(c).vaultId;
    c.lock();
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(session(c).vaultId).toEqual(vaultId);
    // Known at the next start too, from the stored Local Config.
    await c.close();
    const next = controller(factory, undefined, authenticator);
    await next.start();
    expect(next.hasPasskey).toBe(true);
    expect(await next.unlockWithPasskey()).toBe('ok');
  });

  it('reports a synced passkey for the notice (D84)', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.flags = UP | UV | BE;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: true });
  });

  it('evaluates the PRF with a get when the create gave no output', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.prf = 'get';
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    expect(authenticator.calls).toEqual(['create', 'get']);
  });

  it('refuses another current password and signals the new credential as unknown (D172, D120)', async () => {
    const { c, authenticator } = await withPasskey();
    expect(await c.setUpPasskey('not the password')).toEqual({ kind: 'wrong-password' });
    expect(c.hasPasskey).toBe(false);
    expect(session(c).passkeyCredentialId).toBeUndefined();
    expect(authenticator.forgotten).toEqual([new Uint8Array([1])]);
  });

  it('never derives a PRF KEK from a credential created without user verification (D75)', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.flags = UP;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'no-user-verification' });
    expect(c.hasPasskey).toBe(false);
    expect(authenticator.forgotten).toHaveLength(1);
  });

  it('rejects an unlock assertion without user verification (D75, CRYPTO-INV-021)', async () => {
    const { c, authenticator } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    c.lock();
    authenticator.flags = UP | BE;
    expect(await c.unlockWithPasskey()).toBe('no-user-verification');
    expect(c.status.kind).toBe('locked');
    authenticator.flags = UP | UV;
    expect(await c.unlockWithPasskey()).toBe('ok');
  });

  it('reports a cancelled prompt and a PRF the authenticator does not give', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.cancel = true;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'cancelled' });
    authenticator.cancel = false;
    authenticator.prf = 'none';
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    authenticator.prf = 'create';
    await c.setUpPasskey(PASSWORD);
    c.lock();
    authenticator.cancel = true;
    expect(await c.unlockWithPasskey()).toBe('cancelled');
    expect(c.status.kind).toBe('locked');
    authenticator.cancel = false;
    authenticator.prf = 'none';
    expect(await c.unlockWithPasskey()).toBe('unavailable');
    expect(c.status.kind).toBe('locked');
  });

  it('rejects a passkey whose PRF output does not open the wrap', async () => {
    const { c, factory } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    await c.close();
    // Another authenticator answering for the same credential ID gives another PRF output.
    const other = new FakeAuthenticator();
    await other.create(new Uint8Array(32));
    const next = controller(factory, undefined, {
      supported: () => other.supported(),
      create: (input) => other.create(input),
      forget: (id) => other.forget(id),
      get: async (id, input) => ({
        ...(await other.get(id, input)),
        prfOutput: new Uint8Array(32).fill(0x33),
      }),
    });
    await next.start();
    expect(await next.unlockWithPasskey()).toBe('rejected');
    expect(next.status.kind).toBe('locked');
    expect(await next.unlock(PASSWORD)).toBe('ok');
  });

  it('aborts a setup locked during the prompt, signalling the credential (D104, D105)', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await withPasskey(authenticator);
    const create = authenticator.create.bind(authenticator);
    authenticator.create = (input) => {
      c.lock();
      return create(input);
    };
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'cancelled' });
    expect(c.status.kind).toBe('locked');
    expect(c.hasPasskey).toBe(false);
    expect(authenticator.forgotten).toHaveLength(1);
  });

  it('aborts an unlock locked during the prompt', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await withPasskey(authenticator);
    await c.setUpPasskey(PASSWORD);
    c.lock();
    const get = authenticator.get.bind(authenticator);
    authenticator.get = (id, input) => {
      c.lock();
      return get(id, input);
    };
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(c.status.kind).toBe('locked');
  });

  it('removes the passkey and asks the authenticator to forget it, or says to do it by hand (D120)', async () => {
    const { c, authenticator } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    expect(await c.removePasskey()).toBe('forgotten');
    expect(authenticator.forgotten).toEqual([new Uint8Array([1])]);
    expect(c.hasPasskey).toBe(false);
    c.lock();
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
    authenticator.signal = false;
    await c.setUpPasskey(PASSWORD);
    expect(await c.removePasskey()).toBe('by-hand');
  });

  it('offers no passkey without WebAuthn', async () => {
    const c = await created();
    expect(await c.passkeysSupported()).toBe(false);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    expect(c.hasPasskey).toBe(false);
  });
});
