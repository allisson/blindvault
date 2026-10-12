// The vault lifecycle of one app window: startup cleanup, the vault's Web Lock, create, unlock, lock
// and the local settings. It wires `packages/vault` to `packages/storage` and holds no cryptography
// of its own (AGENTS.md). React reads it through `subscribe`/`status`.

import {
  type KdfPort,
  KdfParamsRejectedError,
  Keyring,
  calibrateDeviceKek,
  deriveDeviceKek,
  generateSalt,
  initCrypto,
  normalizePassword,
} from '@blindvault/crypto';
import {
  type HeldLock,
  VaultDatabase,
  acquireInstallationGuard,
  acquireVaultLock,
  cleanupDatabases,
  requestPersistence,
} from '@blindvault/storage';
import {
  ContentInvalidError,
  type LocalConfigCleartext,
  type Preferences,
  type RecordStore,
  UnlockRejectedError,
  UnsupportedLocalConfigError,
  VaultSession,
  localConfigWithoutReplaces,
  parseLocalConfig,
} from '@blindvault/vault';

export type Status =
  | { readonly kind: 'starting' }
  /** No IndexedDB or Web Locks. */
  | { readonly kind: 'unsupported' }
  /** Another app window holds the installation guard (D97). */
  | { readonly kind: 'busy' }
  | { readonly kind: 'no-vault' }
  | { readonly kind: 'creating' }
  /** Another app window holds the vault's Web Lock (D51). */
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'unlocking' }
  | { readonly kind: 'unlocked'; readonly session: VaultSession }
  /** A Local Config or database schema this app does not know (D164). */
  | { readonly kind: 'update-required' }
  | { readonly kind: 'corrupt' };

export type Outcome = 'ok' | 'wrong-password';

export interface ControllerDeps {
  readonly factory: IDBFactory;
  readonly locks: LockManager;
  /** A new Argon2id worker for one request (architecture.md). */
  readonly kdf: () => KdfPort;
  readonly now?: () => number;
  readonly storage?: StorageManager;
}

class Aborted extends Error {
  override name = 'Aborted';
}

export class VaultController {
  readonly #deps: ControllerDeps;
  #status: Status = { kind: 'starting' };
  readonly #listeners = new Set<() => void>();
  #vaultId: Uint8Array | undefined;
  #db: VaultDatabase | undefined;
  #lock: HeldLock | undefined;
  /** Bumped by every lock: an operation started before it is aborted (D104). */
  #epoch = 0;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
  }

  get status(): Status {
    return this.#status;
  }

  subscribe = (listener: () => void): (() => void) => {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  };

  getStatus = (): Status => this.#status;

  #set(status: Status): void {
    this.#status = status;
    for (const l of this.#listeners) l();
  }

  get #now(): () => number {
    return this.#deps.now ?? Date.now;
  }

  // --- startup -----------------------------------------------------------------------------------

  /** Runs the startup cleanup under the installation guard, then finds this installation's vault. */
  async start(): Promise<void> {
    this.#set({ kind: 'starting' });
    await initCrypto();
    const { factory, locks } = this.#deps;
    const guard = await acquireInstallationGuard(locks);
    if (!guard) {
      this.#set({ kind: 'busy' });
      return;
    }
    let vaults: readonly string[];
    try {
      const report = await cleanupDatabases(
        guard,
        {
          replaces: (bytes) => parseLocalConfig(bytes).replacesVaultId,
          withoutReplaces: localConfigWithoutReplaces,
        },
        { factory, locks },
      );
      vaults = report.vaults;
      if (vaults.length === 0 && report.skipped.length > 0) {
        this.#set({ kind: 'update-required' });
        return;
      }
    } finally {
      await guard.release();
    }
    // v1 holds one vault (D13); the first name is the vault.
    const name = vaults[0];
    if (name === undefined) {
      this.#set({ kind: 'no-vault' });
      return;
    }
    const db = await VaultDatabase.openExisting(factory, name);
    if (!db) {
      this.#set({ kind: 'update-required' });
      return;
    }
    const config = await this.#readConfig(db);
    if (!config) {
      db.close();
      return;
    }
    this.#db = db;
    this.#vaultId = config.vaultId;
    await this.#acquire(false);
  }

  /** The stored Local Config, or `undefined` after setting the status that explains why not. */
  async #readConfig(db: VaultDatabase): Promise<LocalConfigCleartext | undefined> {
    const bytes = await db.localConfig();
    try {
      if (!bytes) throw new Error('no Local Config');
      return parseLocalConfig(bytes);
    } catch (error) {
      this.#set({
        kind: error instanceof UnsupportedLocalConfigError ? 'update-required' : 'corrupt',
      });
      return undefined;
    }
  }

  async #acquire(takeOver: boolean): Promise<void> {
    const vaultId = this.#vaultId;
    if (!vaultId) return;
    const lock = await acquireVaultLock(vaultId, { takeOver }, this.#deps.locks);
    if (!lock) {
      this.#set({ kind: 'elsewhere' });
      return;
    }
    this.#hold(lock);
    this.#set({ kind: 'locked' });
  }

  #hold(lock: HeldLock): void {
    this.#lock = lock;
    void lock.lost.then(() => {
      if (this.#lock !== lock) return;
      this.#lock = undefined;
      this.lock();
      this.#set({ kind: 'elsewhere' });
    });
  }

  /** Takes the vault's Web Lock from the app window holding it, which locks there (D51). */
  async takeOver(): Promise<void> {
    if (this.#status.kind !== 'elsewhere') return;
    await this.#acquire(true);
  }

  // --- create ------------------------------------------------------------------------------------

  /**
   * Creates the vault with `password`, already checked for strength by the caller (D71). Holds the
   * installation guard until the commit; a lock before the commit aborts it with nothing persisted
   * (D104).
   */
  async create(password: string, displayName: string): Promise<void> {
    if (this.#status.kind !== 'no-vault') return;
    // Captured before the first await: a lock from here on aborts the creation.
    const epoch = this.#epoch;
    this.#set({ kind: 'creating' });
    const { factory, locks } = this.#deps;
    const guard = await acquireInstallationGuard(locks);
    if (!guard) {
      this.#set({ kind: 'busy' });
      return;
    }
    if (epoch !== this.#epoch) {
      await guard.release();
      return;
    }
    const keyring = new Keyring();
    let db: VaultDatabase | undefined;
    let lock: HeldLock | undefined;
    try {
      const salt = generateSalt();
      const { kek, params } = await calibrateDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
      );
      if (epoch !== this.#epoch) throw new Aborted();
      const store: RecordStore = {
        records: () => Promise.resolve([]),
        commit: async (commit) => {
          if (epoch !== this.#epoch) throw new Aborted();
          if (!db) {
            const { vaultId } = parseLocalConfig(commit.localConfig);
            lock = (await acquireVaultLock(vaultId, {}, locks)) ?? undefined;
            if (!lock) throw new Aborted();
            db = await VaultDatabase.open(vaultId, factory);
          }
          await db.commit(commit);
        },
      };
      const session = await VaultSession.create({
        store,
        keyring,
        kek,
        salt,
        kdfParams: params,
        displayName,
        now: this.#now,
      });
      if (!db || !lock) throw new Aborted();
      this.#db = db;
      this.#vaultId = session.vaultId;
      this.#hold(lock);
      this.#set({ kind: 'unlocked', session });
      void requestPersistence(this.#deps.storage);
    } catch (error) {
      keyring.wipeAll();
      db?.close();
      await lock?.release();
      this.#set({ kind: 'no-vault' });
      if (!(error instanceof Aborted)) throw error;
    } finally {
      await guard.release();
    }
  }

  // --- unlock and lock ---------------------------------------------------------------------------

  /** Unlocks with the local password. A password that does not open the wrap is `'wrong-password'`. */
  async unlock(password: string): Promise<Outcome> {
    const db = this.#db;
    if (this.#status.kind !== 'locked' || !db) return 'ok';
    const epoch = this.#epoch;
    this.#set({ kind: 'unlocking' });
    const config = await this.#readConfig(db);
    if (!config) return 'ok';
    const keyring = new Keyring();
    try {
      const { salt, opslimit, memlimit } = config.kek;
      const kek = await deriveDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
        {
          opslimit,
          memlimit,
        },
      );
      if (epoch !== this.#epoch) throw new Aborted();
      const session = await VaultSession.unlock({
        store: db,
        localConfig: config,
        keyring,
        kek,
        method: 'password',
        now: this.#now,
      });
      if (epoch !== this.#epoch) {
        session.lock();
        throw new Aborted();
      }
      this.#set({ kind: 'unlocked', session });
      return 'ok';
    } catch (error) {
      keyring.wipeAll();
      if (error instanceof Aborted) return 'ok';
      if (error instanceof UnlockRejectedError) {
        this.#set({ kind: 'locked' });
        return 'wrong-password';
      }
      if (error instanceof ContentInvalidError || error instanceof KdfParamsRejectedError) {
        this.#set({ kind: 'corrupt' });
        return 'ok';
      }
      this.#set({ kind: 'locked' });
      throw error;
    }
  }

  /** Locks: wipes the session's keys and state and aborts what is in progress (overview §7). */
  lock(): void {
    this.#epoch += 1;
    const status = this.#status;
    if (status.kind === 'unlocked') status.session.lock();
    if (status.kind === 'unlocked' || status.kind === 'unlocking') this.#set({ kind: 'locked' });
    if (status.kind === 'creating') this.#set({ kind: 'no-vault' });
  }

  /** Locks, releases the vault's Web Lock and closes the database (the app window is closing). */
  async close(): Promise<void> {
    this.lock();
    const lock = this.#lock;
    this.#lock = undefined;
    await lock?.release();
    this.#db?.close();
    this.#db = undefined;
  }

  // --- local settings ----------------------------------------------------------------------------

  /** Changes the local password; the current one is checked by opening the wrap (D168). */
  async changePassword(current: string, next: string): Promise<Outcome> {
    const status = this.#status;
    if (status.kind !== 'unlocked' || !this.#db) return 'ok';
    const config = await this.#readConfig(this.#db);
    if (!config) return 'ok';
    const keyring = new Keyring();
    try {
      const { salt, opslimit, memlimit } = config.kek;
      const currentKek = await deriveDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(current),
        salt,
        { opslimit, memlimit },
      );
      const nextSalt = generateSalt();
      const { kek: nextKek, params } = await calibrateDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(next),
        nextSalt,
      );
      await status.session.changePassword({
        current: currentKek,
        next: nextKek,
        salt: nextSalt,
        kdfParams: params,
      });
      return 'ok';
    } catch (error) {
      if (error instanceof UnlockRejectedError) return 'wrong-password';
      throw error;
    } finally {
      keyring.wipeAll();
    }
  }

  async setPreferences(preferences: Preferences): Promise<void> {
    const status = this.#status;
    if (status.kind !== 'unlocked') return;
    await status.session.setPreferences(preferences);
    this.#set({ ...status });
  }
}
