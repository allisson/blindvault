import { initCrypto, randomId } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { databaseName } from './database';
import { INSTALLATION_GUARD, acquireInstallationGuard, acquireVaultLock } from './locks';

beforeAll(async () => {
  await initCrypto();
});

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

function watch(p: Promise<void>): { done: boolean } {
  const state = { done: false };
  void p.then(() => {
    state.done = true;
  });
  return state;
}

describe('vault Web Lock (D51, D79, CRYPTO-INV-017)', () => {
  it('is named like the vault database, and a second app window cannot acquire it', async () => {
    const vaultId = randomId();
    const first = await acquireVaultLock(vaultId);
    expect(first?.name).toBe(databaseName(vaultId));
    expect(await acquireVaultLock(vaultId)).toBeNull();
    // Another vault's lock is independent.
    const other = await acquireVaultLock(randomId());
    expect(other).not.toBeNull();
    await other?.release();
    await first?.release();
  });

  it('is acquirable again once released, and a release is not a loss', async () => {
    const vaultId = randomId();
    const first = await acquireVaultLock(vaultId);
    const lost = watch(first?.lost ?? Promise.resolve());
    await first?.release();
    await first?.release();
    await tick();
    const second = await acquireVaultLock(vaultId);
    expect(second).not.toBeNull();
    await tick();
    expect(lost.done).toBe(false);
    await second?.release();
  });

  it('take-over reports the loss to the holder, which can no longer keep it', async () => {
    const vaultId = randomId();
    const first = await acquireVaultLock(vaultId);
    const lost = watch(first?.lost ?? Promise.resolve());
    const second = await acquireVaultLock(vaultId, { takeOver: true });
    expect(second).not.toBeNull();
    await first?.lost;
    expect(lost.done).toBe(true);
    // The old holder's release does not free the new holder's lock.
    await first?.release();
    expect(await acquireVaultLock(vaultId)).toBeNull();
    await second?.release();
  });

  it('rejects when the lock manager refuses the request', async () => {
    const failing = {
      request: () => Promise.reject(new DOMException('denied', 'SecurityError')),
    } as unknown as LockManager;
    await expect(acquireVaultLock(randomId(), {}, failing)).rejects.toThrow('denied');
    // A lock manager rejecting with a non-Error still surfaces as an Error.
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors
    const odd = { request: () => Promise.reject('denied') } as unknown as LockManager;
    await expect(acquireInstallationGuard(odd)).rejects.toThrow('denied');
  });
});

describe('installation guard (D97, D108)', () => {
  it('is one installation-wide lock, held by one app window at a time', async () => {
    const guard = await acquireInstallationGuard();
    expect(guard?.name).toBe(INSTALLATION_GUARD);
    expect(await acquireInstallationGuard()).toBeNull();
    await guard?.release();
    const again = await acquireInstallationGuard();
    expect(again).not.toBeNull();
    await again?.release();
  });
});
