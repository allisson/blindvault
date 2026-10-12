// The vault lifecycle of one app window: startup cleanup, the vault's Web Lock, create, unlock, lock
// and the local settings. It wires `packages/vault` to `packages/storage` and holds no cryptography
// of its own (AGENTS.md). React reads it through `subscribe`/`status`.

import {
  type KdfPort,
  KdfParamsRejectedError,
  Keyring,
  UserVerificationError,
  calibrateDeviceKek,
  deriveDeviceKek,
  derivePrfKek,
  generatePrfInput,
  generateSalt,
  initCrypto,
  isBackupEligible,
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
  VaultLockedError,
  VaultSession,
  localConfigWithoutReplaces,
  parseLocalConfig,
} from '@blindvault/vault';

import {
  PasskeyCancelledError,
  type PasskeyPort,
  type PasskeyResult,
  PrfUnavailableError,
} from './passkey';

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

/** A passkey unlock: `rejected` when the passkey does not open this vault's PRF wrap. */
export type PasskeyOutcome =
  'ok' | 'cancelled' | 'rejected' | 'no-user-verification' | 'unavailable';

export type PasskeySetup =
  /** `backupEligible`: a synced passkey, for the D84 notice. */
  | { readonly kind: 'ok'; readonly backupEligible: boolean }
  | { readonly kind: 'wrong-password' | 'cancelled' | 'no-user-verification' | 'unavailable' };

export interface ControllerDeps {
  readonly factory: IDBFactory;
  readonly locks: LockManager;
  /** A new Argon2id worker for one request (architecture.md). */
  readonly kdf: () => KdfPort;
  readonly now?: () => number;
  readonly storage?: StorageManager;
  /** WebAuthn, for passkey unlock (§5.5); absent where the browser has none. */
  readonly passkeys?: PasskeyPort;
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((v, i) => v === b[i]);
}

/** A ceremony that ended without a result: the user's choice or the authenticator's limits. */
function ceremonyFailure(error: unknown): 'cancelled' | 'unavailable' {
  if (error instanceof PasskeyCancelledError) return 'cancelled';
  if (error instanceof PrfUnavailableError) return 'unavailable';
  throw error;
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
  /** The PRF KEK state of the Local Config last read or written, for the unlock prompt. */
  #passkey: { readonly credentialId: Uint8Array; readonly prfInput: Uint8Array } | undefined;
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
      const config = parseLocalConfig(bytes);
      this.#passkey = config.prf;
      return config;
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

  /** Whether this vault has passkey unlock set up on this device, as last read. */
  get hasPasskey(): boolean {
    return this.#passkey !== undefined && this.#deps.passkeys !== undefined;
  }

  /** Whether the browser offers WebAuthn with the PRF extension (detected at runtime, §5.5). */
  async passkeysSupported(): Promise<boolean> {
    return (await this.#deps.passkeys?.supported()) ?? false;
  }

  /**
   * Unlocks with the passkey (§5.5). The assertion is requested first, while the click's user
   * activation lasts; one without user verification never yields a PRF KEK (D75, CRYPTO-INV-021).
   */
  async unlockWithPasskey(): Promise<PasskeyOutcome> {
    const db = this.#db;
    const passkeys = this.#deps.passkeys;
    const held = this.#passkey;
    if (this.#status.kind !== 'locked' || !db || !passkeys || !held) return 'ok';
    const epoch = this.#epoch;
    this.#set({ kind: 'unlocking' });
    let assertion: PasskeyResult;
    try {
      assertion = await passkeys.get(held.credentialId, held.prfInput);
    } catch (error) {
      if (epoch === this.#epoch) this.#set({ kind: 'locked' });
      return ceremonyFailure(error);
    }
    const keyring = new Keyring();
    try {
      if (epoch !== this.#epoch) throw new Aborted();
      const config = await this.#readConfig(db);
      if (!config) return 'ok';
      if (!config.prf || !sameBytes(config.prf.credentialId, assertion.credentialId)) {
        throw new UnlockRejectedError();
      }
      if (!assertion.prfOutput) throw new PrfUnavailableError();
      const kek = derivePrfKek(keyring, {
        authenticatorData: assertion.authenticatorData,
        prfOutput: assertion.prfOutput,
      });
      const session = await VaultSession.unlock({
        store: db,
        localConfig: config,
        keyring,
        kek,
        method: 'passkey',
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
      if (error instanceof ContentInvalidError) {
        this.#set({ kind: 'corrupt' });
        return 'ok';
      }
      this.#set({ kind: 'locked' });
      if (error instanceof UnlockRejectedError) return 'rejected';
      if (error instanceof UserVerificationError) return 'no-user-verification';
      if (error instanceof PrfUnavailableError) return 'unavailable';
      throw error;
    } finally {
      assertion.prfOutput?.fill(0);
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

  /**
   * Sets up passkey unlock (§5.5, D172). The credential is created first, while the click's user
   * activation lasts; then `current` must open the Master Key wrap. A credential that ends up
   * wrapping nothing, after a wrong password, a lock or a failure, is signalled as unknown (D120).
   */
  async setUpPasskey(current: string): Promise<PasskeySetup> {
    const status = this.#status;
    const db = this.#db;
    const passkeys = this.#deps.passkeys;
    if (status.kind !== 'unlocked' || !db || !passkeys) return { kind: 'unavailable' };
    const epoch = this.#epoch;
    const prfInput = generatePrfInput();
    let created: PasskeyResult;
    try {
      created = await passkeys.create(prfInput);
    } catch (error) {
      return { kind: ceremonyFailure(error) };
    }
    const keyring = new Keyring();
    let evaluated: PasskeyResult = created;
    let committed = false;
    try {
      if (epoch !== this.#epoch) throw new Aborted();
      // Every browser of the matrix evaluates the PRF at create (spikes/prf.md); others need a get.
      if (!evaluated.prfOutput) evaluated = await passkeys.get(created.credentialId, prfInput);
      if (!evaluated.prfOutput) throw new PrfUnavailableError();
      const backupEligible = isBackupEligible(created.authenticatorData);
      const prfKek = derivePrfKek(keyring, {
        authenticatorData: evaluated.authenticatorData,
        prfOutput: evaluated.prfOutput,
      });
      const config = await this.#readConfig(db);
      if (!config) throw new Aborted();
      const { salt, opslimit, memlimit } = config.kek;
      const currentKek = await deriveDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(current),
        salt,
        { opslimit, memlimit },
      );
      if (epoch !== this.#epoch) throw new Aborted();
      await status.session.setPasskey({
        current: currentKek,
        prfKek,
        credentialId: created.credentialId,
        prfInput,
      });
      committed = true;
      this.#passkey = { credentialId: created.credentialId, prfInput };
      this.#set({ ...status });
      return { kind: 'ok', backupEligible };
    } catch (error) {
      if (error instanceof UnlockRejectedError) return { kind: 'wrong-password' };
      if (error instanceof UserVerificationError) return { kind: 'no-user-verification' };
      if (error instanceof Aborted || error instanceof VaultLockedError)
        return { kind: 'cancelled' };
      return { kind: ceremonyFailure(error) };
    } finally {
      keyring.wipeAll();
      created.prfOutput?.fill(0);
      evaluated.prfOutput?.fill(0);
      if (!committed) void passkeys.forget(created.credentialId);
    }
  }

  /**
   * Removes passkey unlock: the PRF wrap is deleted, then the authenticator is asked to remove the
   * credential where the browser can (D120). `by-hand`: tell the user to delete it themselves.
   */
  async removePasskey(): Promise<'forgotten' | 'by-hand'> {
    const status = this.#status;
    if (status.kind !== 'unlocked') return 'by-hand';
    const credentialId = status.session.passkeyCredentialId;
    await status.session.removePasskey();
    this.#passkey = undefined;
    this.#set({ ...status });
    if (!credentialId) return 'forgotten';
    return (await this.#deps.passkeys?.forget(credentialId)) ? 'forgotten' : 'by-hand';
  }

  async setPreferences(preferences: Preferences): Promise<void> {
    const status = this.#status;
    if (status.kind !== 'unlocked') return;
    await status.session.setPreferences(preferences);
    this.#set({ ...status });
  }
}
