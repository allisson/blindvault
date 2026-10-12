// Web Locks (overview §6, D51, D79, D97, D108, CRYPTO-INV-017): the vault's exclusive lock, named
// like its database, and the installation guard. Every request is `ifAvailable` or a take-over, so
// an app window never waits behind another one.

import { databaseName } from './database';

/** The installation guard's Web Lock name (D97, D108). */
export const INSTALLATION_GUARD = 'blindvault-installation';

/** A Web Lock held by this app window. */
export interface HeldLock {
  readonly name: string;
  /** Resolves when another app window took the lock over; never after `release()`. */
  readonly lost: Promise<void>;
  /** Releases the lock, resolving once another request can acquire it. Idempotent. */
  release(): Promise<void>;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return {
    promise,
    resolve: () => {
      resolve();
    },
  };
}

function hold(locks: LockManager, name: string, options: LockOptions): Promise<HeldLock | null> {
  return new Promise((resolve, reject) => {
    let granted = false;
    const held = deferred();
    const lost = deferred();
    const settled = locks
      .request(name, options, (lock) => {
        if (!lock) {
          resolve(null);
          return;
        }
        granted = true;
        resolve({
          name,
          lost: lost.promise,
          release: () => {
            held.resolve();
            return settled;
          },
        });
        return held.promise;
      })
      // Only a take-over rejects a granted request (`AbortError`); a release resolves it.
      .catch((error: unknown) => {
        if (!granted) reject(error instanceof Error ? error : new Error(String(error)));
        else lost.resolve();
      });
  });
}

/**
 * The vault's Web Lock (D51, D79). Without `takeOver`, `null` when another app window holds it: this
 * one MUST NOT open the vault. With `takeOver`, the lock is taken from that app window, whose `lost`
 * resolves so it locks the vault and ends its sync session.
 */
export function acquireVaultLock(
  vaultId: Uint8Array,
  options: { readonly takeOver?: boolean } = {},
  locks: LockManager = navigator.locks,
): Promise<HeldLock | null> {
  return hold(
    locks,
    databaseName(vaultId),
    options.takeOver ? { steal: true } : { ifAvailable: true },
  );
}

/**
 * The installation guard (D97, D108): `null` when another app window holds it, and this one then
 * creates, replaces and deletes no vault database.
 */
export function acquireInstallationGuard(
  locks: LockManager = navigator.locks,
): Promise<HeldLock | null> {
  return hold(locks, INSTALLATION_GUARD, { ifAvailable: true });
}
