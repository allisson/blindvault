// The vault lifecycle of one app window: startup cleanup, the vault's Web Lock, create, unlock, lock
// and the local settings. It wires `packages/vault` to `packages/storage` and holds no cryptography
// of its own (AGENTS.md). React reads it through `subscribe`/`status`.

import {
  type KdfPort,
  KdfParamsRejectedError,
  Keyring,
  PhraseRejectedError,
  type RecoveryCheckResult,
  RecordType,
  UserVerificationError,
  calibrateDeviceKek,
  deriveDeviceKek,
  derivePrfKek,
  generateDeviceIdentity,
  generatePrfInput,
  generateRecoveryPhrase,
  generateSalt,
  parseRecoveryPhrase,
  initCrypto,
  isBackupEligible,
  normalizePassword,
  type SymmetricKey,
} from '@blindvault/crypto';
import {
  BackupRejectedError,
  type ParsedBackup,
  type ValidatedBackup,
  parseBackup,
  restoreWithPassword,
  restoreWithPhrase,
} from '@blindvault/backup';
import {
  type HeldLock,
  VaultDatabase,
  acquireInstallationGuard,
  acquireVaultLock,
  cleanupDatabases,
  databaseName,
  deleteDatabase,
  requestPersistence,
} from '@blindvault/storage';
import {
  ContentInvalidError,
  ExportRejectedError,
  type LocalConfigCleartext,
  MergeRejectedError,
  type MergeResult,
  type PairingGrant,
  PairingRefusedError,
  PasswordResetRejectedError,
  type Preferences,
  RecordNotFoundError,
  type RecordStore,
  type RecoveryView,
  type RegenerationBlock,
  RegenerationBlockedError,
  RetirementRefusedError,
  RestoreRejectedError,
  UnlockRejectedError,
  type UnlockMethod,
  UnsupportedLocalConfigError,
  VaultLockedError,
  VaultSession,
  localConfigWithoutReplaces,
  parseLocalConfig,
} from '@blindvault/vault';

import { backupFileName, recordIdPrefix } from './backup-file';
import { type BackupReminder, backupReminderOf } from './backup-reminder';
import { devicesOf } from './devices';
import {
  Inviting,
  Joining,
  type PairingPort,
  type PairingStage,
  type PayloadCheck,
} from './pairing';
import { type Ready } from './ready';
import { StorageMonitor } from './storage-state';
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
  /** A fresh restore committing (D33). */
  | { readonly kind: 'restoring' }
  /** The locked vault being replaced by a backup, until the commit (D89, D153, D183). */
  | { readonly kind: 'replacing' }
  /**
   * Joining a pairing, from its password step until the commit (§8.4, D33, D203): with no vault, or
   * `replacing` the locked vault (D150, D153, D204).
   */
  | { readonly kind: 'joining'; readonly replacing?: true }
  /** A forgotten local password being reset with the Recovery Phrase (D173, D184). */
  | { readonly kind: 'resetting' }
  /** Another app window holds the vault's Web Lock (D51). */
  | { readonly kind: 'elsewhere' }
  | { readonly kind: 'locked' }
  | { readonly kind: 'unlocking' }
  | { readonly kind: 'unlocked'; readonly session: VaultSession }
  /** A Local Config or database schema this app does not know (D164). */
  | { readonly kind: 'update-required' }
  /** The app's code did not all load, so it opens nothing until a reload (D142, D191). */
  | { readonly kind: 'incomplete' }
  | { readonly kind: 'corrupt' };

export type Outcome = 'ok' | 'wrong-password';

/** A password change: `locked` when the vault locked before or during it, so nothing changed. */
export type PasswordChange = Outcome | 'locked';

/** A passkey unlock: `rejected` when the passkey does not open this vault's PRF wrap. */
export type PasskeyOutcome =
  'ok' | 'cancelled' | 'rejected' | 'no-user-verification' | 'unavailable';

export type PasskeySetup =
  /** `backupEligible`: a synced passkey, for the D84 notice. */
  | { readonly kind: 'ok'; readonly backupEligible: boolean }
  | { readonly kind: 'wrong-password' | 'cancelled' | 'no-user-verification' | 'unavailable' };

/** Check Recovery Phrase (§5.4, D24, D180): `invalid` for input that is not a phrase at all. */
export type PhraseCheck =
  | { readonly kind: RecoveryCheckResult | 'no-envelope' | 'corrupt-envelope' | 'locked' }
  | {
      readonly kind: 'invalid';
      readonly reason: PhraseRejectedError['reason'];
      /** For `unknown-word`: the 1-based position of the first word not in the list. */
      readonly position?: number;
    };

/** How the user opens the Master Key wrap again before an export (D181). */
export type ExportAuth =
  { readonly kind: 'password'; readonly password: string } | { readonly kind: 'passkey' };

/** Why opening the Master Key wrap again failed (D181, D185). */
type ReauthFailure =
  'wrong-password' | 'locked' | 'cancelled' | 'rejected' | 'no-user-verification' | 'unavailable';

/**
 * A Recovery Phrase regeneration (§5.4, D185): `no-phrase` when no phrase was handed out or it went
 * with a lock, a cancel or the commit.
 */
export type Regeneration =
  | { readonly kind: 'ok'; readonly recovery: RecoveryView }
  | { readonly kind: 'blocked'; readonly block: RegenerationBlock }
  | { readonly kind: ReauthFailure | 'no-phrase' };

/** The proof of the user that starts a re-founding (D187). */
export type RefoundingStart = 'ok' | ReauthFailure;

/**
 * A re-founding (§14, D28, D187): `not-started` without the proof of `beginRefounding`, `no-phrase`
 * without the phrase of `newRefoundingPhrase`, `busy` while another app window holds the
 * installation guard (D97), `locked` when a lock aborted it before the commit (D93).
 */
export type Refounding =
  { readonly kind: 'ok' } | { readonly kind: 'not-started' | 'no-phrase' | 'busy' | 'locked' };

/** A backup export (backup-format.md §8, D64, D179, D181). */
export type BackupExport =
  | { readonly kind: 'ok'; readonly bytes: Uint8Array; readonly name: string }
  | {
      readonly kind:
        | 'wrong-password'
        | 'locked'
        | 'no-envelope'
        | 'cancelled'
        | 'rejected'
        | 'no-user-verification'
        | 'unavailable';
    }
  /** A record that fails verification, named by its type and the start of its `recordId`. */
  | { readonly kind: 'corrupt-record'; readonly recordType: number; readonly recordId: string };

/** What a backup's header says before any keyslot opens: unverified until one does (D95). */
export interface BackupHeaderInfo {
  readonly phraseId: Uint8Array;
  readonly phraseCreatedAt: number;
  readonly hasExportPassword: boolean;
}

/**
 * A `.bvault` file read for a restore: a fresh restore while there is no vault, or a backup merge
 * while unlocked (D182); `unavailable` otherwise.
 */
export type BackupFileCheck =
  | { readonly kind: 'ok'; readonly header: BackupHeaderInfo }
  | { readonly kind: 'not-a-backup' | 'newer-version' | 'malformed' | 'unavailable' };

/** The secret that opens one of a backup's keyslots (backup-format.md §8 step 3). */
export type BackupSecret =
  | { readonly kind: 'phrase'; readonly words: string }
  | { readonly kind: 'password'; readonly password: string };

/**
 * A backup opened and validated (backup-format.md §8 steps 3 to 8). `wrong-secret`,
 * `invalid-phrase` and `no-password-keyslot` keep the file for another try; any other failure
 * drops it, and `no-file` says there is none.
 */
export type BackupOpening =
  | { readonly kind: 'ok'; readonly openedWith: 'phrase' | 'password'; readonly exportedAt: number }
  | {
      readonly kind: 'invalid-phrase';
      readonly reason: PhraseRejectedError['reason'];
      readonly position?: number;
    }
  | {
      readonly kind:
        | 'wrong-secret'
        | 'no-password-keyslot'
        | 'not-a-backup'
        | 'newer-version'
        | 'malformed'
        | 'corrupt'
        | 'newer-record'
        | 'envelope-mismatch'
        | 'master-key-mismatch'
        | 'public-key-mismatch'
        | 'locked'
        | 'no-file'
        /** Opened for a merge, but a backup of another vault (D13). */
        | 'different-vault';
    }
  /** Named when the record decodes (D64). */
  | {
      readonly kind: 'corrupt-record';
      readonly recordType?: number;
      readonly recordId?: string;
    };

/**
 * A fresh restore's commit, or a replacement's: `no-backup` when none was opened, or a lock dropped
 * it; `busy` when another app window holds the installation guard during a replacement (D97).
 */
export type RestoreOutcome =
  | { readonly kind: 'ok' | 'locked' | 'no-backup' | 'busy' }
  | { readonly kind: 'corrupt-record'; readonly recordType: number; readonly recordId: string };

/** A backup merge (sync-protocol.md §1, D182): `no-backup` when none was opened. */
export type MergeOutcome =
  | { readonly kind: 'ok'; readonly result: MergeResult }
  | { readonly kind: 'no-backup' | 'locked' | 'different-vault' | 'master-key-mismatch' }
  /** The merge can be retried from `retryAt` (Unix ms, D64). */
  | { readonly kind: 'future-clock'; readonly retryAt: number }
  | {
      readonly kind: 'corrupt-record' | 'immutable-record';
      readonly recordType: number;
      readonly recordId: string;
    };

/**
 * A forgotten password reset (§14, D173, D184): `invalid` for input that is not a phrase,
 * `unavailable` unless the vault is locked, `locked` when a lock stopped it before the commit.
 */
export type PasswordReset =
  | {
      readonly kind:
        'ok' | 'no-envelope' | 'wrong-phrase' | 'master-key-mismatch' | 'locked' | 'unavailable';
    }
  | {
      readonly kind: 'invalid';
      readonly reason: PhraseRejectedError['reason'];
      readonly position?: number;
    };

/**
 * Starting a pairing on the device holding the vault (§8.4, D202): why it could not start, after the
 * local password or the passkey opened the Master Key wrap again.
 */
export type PairingStart =
  | 'ok'
  | ReauthFailure
  | Exclude<PairingRefusedError['reason'], 'known-device'>
  /** No WebRTC in this browser. */
  | 'no-webrtc';

/** How a pairing runs: `sameNetwork` uses no STUN server (§9.2, D203). */
export interface PairingOptions {
  readonly sameNetwork: boolean;
}

export interface ControllerDeps {
  readonly factory: IDBFactory;
  readonly locks: LockManager;
  /** A port to the Argon2id worker for one request (architecture.md). */
  readonly kdf: () => KdfPort;
  /**
   * Loads every piece of code the app may need after the first unlock (D142, D191): the start
   * screen waits for it, and a failure keeps the vault closed.
   */
  readonly preload?: () => Promise<void>;
  readonly now?: () => number;
  readonly storage?: StorageManager;
  /** WebAuthn, for passkey unlock (§5.5); absent where the browser has none. */
  readonly passkeys?: PasskeyPort;
  /** WebRTC, for pairing (§8.4); absent where the browser has none. */
  readonly pairing?: PairingPort;
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

/** What a failure to open the Master Key wrap again tells the user (D181, D185). */
function reauthFailure(error: unknown, auth: ExportAuth): ReauthFailure | undefined {
  if (error instanceof UnlockRejectedError) {
    return auth.kind === 'password' ? 'wrong-password' : 'rejected';
  }
  if (error instanceof VaultLockedError) return 'locked';
  if (error instanceof UserVerificationError) return 'no-user-verification';
  if (error instanceof PrfUnavailableError) return 'unavailable';
  return undefined;
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
  /**
   * The Recovery Phrase shown for the vault being created, or for a regeneration while unlocked, as
   * its entropy only (§5.4, D179, D185). At creation its keyring becomes the new session's; a lock,
   * a new phrase or the end of a regeneration wipes it.
   */
  #phrase: { readonly keyring: Keyring; readonly entropy: SymmetricKey } | undefined;
  /**
   * The backup being restored: the file as parsed, then, once a keyslot opened it, the validated
   * backup and the keyring holding its Master Key, which becomes the new session's. A lock wipes it.
   */
  #restore:
    | {
        readonly parsed: ParsedBackup;
        readonly keyring?: Keyring;
        readonly backup?: ValidatedBackup;
      }
    | undefined;
  /** After a restore opened with an export password: recommend Check Recovery Phrase (D43). */
  #afterRestore: 'check-phrase' | undefined;
  /**
   * The KEK that proved the user for a re-founding (D187), held until its commit; a lock or a
   * cancel wipes it.
   */
  #refounding:
    | { readonly keyring: Keyring; readonly kek: SymmetricKey; readonly method: UnlockMethod }
    | undefined;
  /** After a re-founding: what to do next (§14, D107). */
  #refounded = false;
  /** After a fresh restore, while other devices exist: recommend re-admission (D30, D186). */
  #readmission = false;
  /** After a creation or a restore: the "Vault ready" screen, until closed or locked (D198). */
  #ready: Ready | undefined;
  /** The replaced vault's passkey, which the authenticator could not be asked to forget (D120). */
  #leftoverPasskey = false;
  /**
   * The session whose backup reminder was dismissed: until the next lock, and not for a vault that
   * replaces it (D188).
   */
  #reminderDismissed: VaultSession | undefined;
  /** The pairing in progress, inviting (A) or joining (B), until closed or locked (§8.4, D93). */
  #pairing: Inviting | Joining | undefined;

  /** Whether the browser keeps this origin's storage, and how much is used (D196). */
  readonly storage: StorageMonitor;

  constructor(deps: ControllerDeps) {
    this.#deps = deps;
    this.storage = new StorageMonitor(deps.storage);
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

  /** At creation, restore and re-founding (section 7), then the status is read again (D196). */
  async #requestPersistence(): Promise<void> {
    await requestPersistence(this.#deps.storage);
    await this.storage.refresh();
  }

  get #now(): () => number {
    return this.#deps.now ?? Date.now;
  }

  // --- startup -----------------------------------------------------------------------------------

  /** Runs the startup cleanup under the installation guard, then finds this installation's vault. */
  async start(): Promise<void> {
    this.#set({ kind: 'starting' });
    try {
      await this.#deps.preload?.();
    } catch {
      this.#set({ kind: 'incomplete' });
      return;
    }
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
   * A new Recovery Phrase for the vault about to be created: its 24 words, to show once (D179).
   * Replaces any phrase handed out before. The words are a string, which cannot be wiped: the UI
   * keeps them only until the phrase is confirmed. `undefined` unless there is no vault yet.
   */
  newRecoveryPhrase(): string | undefined {
    if (this.#status.kind !== 'no-vault') return undefined;
    this.#phrase?.keyring.wipeAll();
    const keyring = new Keyring();
    const { words, entropy } = generateRecoveryPhrase(keyring);
    this.#phrase = { keyring, entropy };
    this.#set({ ...this.#status });
    return words;
  }

  /**
   * Whether a Recovery Phrase is held, shown or being confirmed (creation, regeneration,
   * re-founding): its screens keep their single control, with no About button (D179, D192).
   */
  get holdsPhrase(): boolean {
    return this.#phrase !== undefined;
  }

  /**
   * Creates the vault with `password`, already checked for strength by the caller (D71), and the
   * Recovery Phrase last handed out by `newRecoveryPhrase`, which the user has confirmed. Holds the
   * installation guard until the commit; a lock before the commit aborts it with nothing persisted
   * (D104). Without a phrase, nothing happens.
   */
  async create(password: string, displayName: string): Promise<void> {
    const phrase = this.#phrase;
    if (this.#status.kind !== 'no-vault' || !phrase) return;
    this.#phrase = undefined;
    // Captured before the first await: a lock from here on aborts the creation.
    const epoch = this.#epoch;
    this.#set({ kind: 'creating' });
    const { factory, locks } = this.#deps;
    const guard = await acquireInstallationGuard(locks);
    if (!guard) {
      phrase.keyring.wipeAll();
      this.#set({ kind: 'busy' });
      return;
    }
    if (epoch !== this.#epoch) {
      phrase.keyring.wipeAll();
      await guard.release();
      return;
    }
    const keyring = phrase.keyring;
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
        // Empty until the founding commit opens the database; read from it afterwards (export).
        records: () => (db ? db.records() : Promise.resolve([])),
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
        recoveryEntropy: phrase.entropy,
        salt,
        kdfParams: params,
        displayName,
        now: this.#now,
      });
      if (!db || !lock) throw new Aborted();
      this.#db = db;
      this.#vaultId = session.vaultId;
      this.#hold(lock);
      this.#ready = { start: 'created' };
      this.#set({ kind: 'unlocked', session });
      void this.#requestPersistence();
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

  // --- fresh restore and backup merge -----------------------------------------------------------

  /**
   * Whether a backup can be opened now: for a fresh restore, for a replacement of the locked vault
   * (D183) or, while unlocked, for a merge.
   */
  #restoring(): boolean {
    const { kind } = this.#status;
    return kind === 'no-vault' || kind === 'locked' || kind === 'unlocked';
  }

  /** Reads a `.bvault` file for a restore (backup-format.md §8 steps 1 and 2). */
  openBackupFile(bytes: Uint8Array): BackupFileCheck {
    if (!this.#restoring()) return { kind: 'unavailable' };
    this.#dropRestore();
    try {
      const parsed = parseBackup(bytes.slice());
      this.#restore = { parsed };
      this.#set({ ...this.#status });
      const { header } = parsed;
      return {
        kind: 'ok',
        header: {
          phraseId: header.phraseId.slice(),
          phraseCreatedAt: header.phraseCreatedAt,
          hasExportPassword: header.keyslots.length === 2,
        },
      };
    } catch (error) {
      if (error instanceof BackupRejectedError) {
        const { reason } = error;
        return {
          kind: reason === 'newer-version' || reason === 'malformed' ? reason : 'not-a-backup',
        };
      }
      throw error;
    }
  }

  /**
   * Opens the file last read with the Recovery Phrase as typed or the export password, and
   * validates it in full (backup-format.md §8 steps 3 to 8). Writes nothing.
   */
  async openBackup(secret: BackupSecret): Promise<BackupOpening> {
    const held = this.#restore;
    if (!this.#restoring() || !held) return { kind: 'no-file' };
    held.keyring?.wipeAll();
    const epoch = this.#epoch;
    const keyring = new Keyring();
    // Held from now on, so a lock during the derivation wipes it.
    this.#restore = { parsed: held.parsed, keyring };
    try {
      const backup =
        secret.kind === 'phrase'
          ? restoreWithPhrase(keyring, held.parsed, secret.words)
          : await restoreWithPassword(
              keyring,
              this.#deps.kdf(),
              held.parsed,
              normalizePassword(secret.password),
            );
      if (epoch !== this.#epoch) throw new Aborted();
      const status = this.#status;
      // A merge takes only a backup of this vault (D13): say so before asking to confirm.
      if (status.kind === 'unlocked' && !sameBytes(backup.vaultId, status.session.vaultId)) {
        keyring.wipeAll();
        this.#restore = undefined;
        return { kind: 'different-vault' };
      }
      this.#restore = { parsed: held.parsed, keyring, backup };
      return { kind: 'ok', openedWith: backup.openedWith, exportedAt: backup.exportedAt };
    } catch (error) {
      keyring.wipeAll();
      if (epoch !== this.#epoch || error instanceof Aborted) return { kind: 'locked' };
      if (error instanceof PhraseRejectedError) {
        const { reason, position } = error;
        return { kind: 'invalid-phrase', reason, ...(position !== undefined ? { position } : {}) };
      }
      if (!(error instanceof BackupRejectedError)) throw error;
      const { reason, record } = error;
      if (reason === 'wrong-secret' || reason === 'no-password-keyslot') return { kind: reason };
      this.#restore = undefined;
      if (reason !== 'corrupt-record') return { kind: reason };
      return {
        kind: 'corrupt-record',
        ...(record
          ? { recordType: record.recordType, recordId: recordIdPrefix(record.recordId) }
          : {}),
      };
    }
  }

  /**
   * Restores the backup last opened, with `password`, already checked for strength by the caller
   * (D71), as this device's local password: one commit writes its records and the new Local Config
   * (D33). Holds the installation guard until then; a lock before the commit aborts it with nothing
   * persisted (D104). A record that fails the content checks rejects it as a whole (D59, D61).
   *
   * With `replace`, the locked vault is replaced, after the confirmation the UI asked for (D183).
   * This app window already holds its Web Lock (D154). A backup of another vault commits a database
   * of its own that records the replaced `vaultId`, then the old database is deleted (D89, D96);
   * one of the same vault commits in the existing database, clearing it in the same transaction
   * (D153). Either way the old vault stays intact until the commit, and its passkey is forgotten
   * afterwards (D120).
   */
  async restore(
    password: string,
    options: { readonly replace?: boolean } = {},
  ): Promise<RestoreOutcome> {
    const held = this.#restore;
    const replacing = this.#status.kind === 'locked' && options.replace === true;
    const old =
      replacing && this.#db && this.#vaultId && this.#lock
        ? { db: this.#db, vaultId: this.#vaultId, lock: this.#lock, passkey: this.#passkey }
        : undefined;
    if ((this.#status.kind !== 'no-vault' && !old) || !held?.keyring || !held.backup) {
      return { kind: 'no-backup' };
    }
    const { keyring, backup } = held;
    this.#restore = undefined;
    const epoch = this.#epoch;
    this.#set({ kind: old ? 'replacing' : 'restoring' });
    const { factory, locks } = this.#deps;
    const guard = await acquireInstallationGuard(locks);
    if (!guard) {
      keyring.wipeAll();
      if (old) {
        if (epoch === this.#epoch) this.#set({ kind: 'locked' });
        return { kind: 'busy' };
      }
      this.#set({ kind: 'busy' });
      return { kind: 'locked' };
    }
    const same = old !== undefined && sameBytes(old.vaultId, backup.vaultId);
    let db: VaultDatabase | undefined;
    let lock: HeldLock | undefined;
    try {
      if (epoch !== this.#epoch) throw new Aborted();
      const salt = generateSalt();
      const { kek, params } = await calibrateDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
      );
      if (epoch !== this.#epoch) throw new Aborted();
      let clear = same;
      const store: RecordStore = {
        records: () => (db ? db.records() : Promise.resolve([])),
        commit: async (commit) => {
          if (epoch !== this.#epoch) throw new Aborted();
          if (!db) {
            if (same) {
              db = old.db;
              lock = old.lock;
            } else {
              lock = (await acquireVaultLock(backup.vaultId, {}, locks)) ?? undefined;
              if (!lock) throw new Aborted();
              db = await VaultDatabase.open(backup.vaultId, factory);
            }
          }
          // D153: the first commit clears the old vault in the transaction that writes the new one.
          await db.commit(clear ? { ...commit, clear } : commit);
          clear = false;
        },
      };
      const session = await VaultSession.restore({
        store,
        keyring,
        kek,
        salt,
        kdfParams: params,
        backup,
        ...(old && !same ? { replacesVaultId: old.vaultId } : {}),
        now: this.#now,
      });
      if (!db || !lock) throw new Aborted();
      if (old && !same) {
        old.db.close();
        try {
          await deleteDatabase(factory, databaseName(old.vaultId));
          await session.forgetReplacedVault();
        } catch {
          // The new vault has committed: the startup cleanup deletes the old one (D89, D96).
        }
        this.#hold(lock);
        await old.lock.release();
      } else if (!same) {
        this.#hold(lock);
      }
      this.#db = db;
      this.#vaultId = session.vaultId;
      this.#passkey = undefined;
      if (old?.passkey) {
        const forgotten = await this.#deps.passkeys?.forget(old.passkey.credentialId);
        this.#leftoverPasskey = forgotten !== true;
      }
      this.#afterRestore = backup.openedWith === 'password' ? 'check-phrase' : undefined;
      this.#readmission = devicesOf(session).advice === 'readmit';
      this.#ready = { start: 'restored', openedWith: backup.openedWith };
      this.#set({ kind: 'unlocked', session });
      void this.#requestPersistence();
      return { kind: 'ok' };
    } catch (error) {
      keyring.wipeAll();
      if (db !== old?.db) db?.close();
      if (lock !== old?.lock) await lock?.release();
      if (old) {
        // The old vault is intact; a take-over during the replacement already said so (D154).
        if (this.#lock === old.lock) this.#set({ kind: 'locked' });
      } else {
        this.#set({ kind: 'no-vault' });
      }
      if (error instanceof Aborted || epoch !== this.#epoch) return { kind: 'locked' };
      if (error instanceof RestoreRejectedError) {
        const { record } = error;
        return {
          kind: 'corrupt-record',
          recordType: record.recordType,
          recordId: recordIdPrefix(record.recordId),
        };
      }
      throw error;
    } finally {
      await guard.release();
    }
  }

  /**
   * Merges the backup last opened into the unlocked vault (§10, sync-protocol.md §1, D13, D57,
   * D182): one commit, or nothing written when it is refused. The backup's Master Key is wiped
   * either way. After a backup opened with an export password, recommends Check Recovery Phrase
   * (D43).
   */
  async mergeBackup(): Promise<MergeOutcome> {
    const status = this.#status;
    const held = this.#restore;
    if (status.kind !== 'unlocked' || !held?.keyring || !held.backup) return { kind: 'no-backup' };
    const { keyring, backup } = held;
    this.#restore = undefined;
    try {
      const result = await status.session.mergeBackup(backup);
      if (backup.openedWith === 'password') this.#afterRestore = 'check-phrase';
      this.#set({ ...status });
      return { kind: 'ok', result };
    } catch (error) {
      if (error instanceof VaultLockedError) return { kind: 'locked' };
      if (!(error instanceof MergeRejectedError)) throw error;
      const { reason, record, retryAt } = error;
      if (reason === 'future-clock') return { kind: reason, retryAt: retryAt ?? 0 };
      if (reason === 'corrupt-record' || reason === 'immutable-record') {
        return {
          kind: reason,
          recordType: record?.recordType ?? 0,
          recordId: record ? recordIdPrefix(record.recordId) : '',
        };
      }
      return { kind: reason };
    } finally {
      keyring.wipeAll();
    }
  }

  /** Drops the backup being restored, wiping its Master Key. */
  cancelRestore(): void {
    this.#dropRestore();
    this.#set({ ...this.#status });
  }

  #dropRestore(): void {
    this.#restore?.keyring?.wipeAll();
    this.#restore = undefined;
  }

  /** What the UI recommends right after a restore (D43), until dismissed. */
  get afterRestore(): 'check-phrase' | undefined {
    return this.#afterRestore;
  }

  dismissAfterRestore(): void {
    this.#afterRestore = undefined;
    this.#set({ ...this.#status });
  }

  /** The "Vault ready" screen after a creation or a restore, until closed (§13.3, D198). */
  get ready(): Ready | undefined {
    return this.#ready;
  }

  /**
   * Closes "Vault ready". After a restore it listed Check Recovery Phrase (D43) and re-admission
   * (D186), so their one-time notices count as shown.
   */
  dismissReady(): void {
    if (this.#ready?.start === 'restored') {
      this.#afterRestore = undefined;
      this.#readmission = false;
    }
    this.#ready = undefined;
    this.#set({ ...this.#status });
  }

  /**
   * Right after a fresh restore, while other non-retired devices exist: the one-time re-admission
   * recommendation (§10, D30, D186). Settings keeps it while the device stays unregistered.
   */
  get readmissionNotice(): boolean {
    return this.#readmission;
  }

  dismissReadmission(): void {
    this.#readmission = false;
    this.#set({ ...this.#status });
  }

  /**
   * Whether a backup is due, and why (§13.4, D188): none made on this device, the last one older
   * than the current Recovery Phrase, or 30 days old. A dismissal lasts until the next lock.
   */
  get backupReminder(): BackupReminder | undefined {
    const status = this.#status;
    if (status.kind !== 'unlocked' || this.#reminderDismissed === status.session) return undefined;
    return backupReminderOf(status.session, this.#now());
  }

  dismissBackupReminder(): void {
    const status = this.#status;
    if (status.kind === 'unlocked') this.#reminderDismissed = status.session;
    this.#set({ ...this.#status });
  }

  /**
   * Whether the replaced vault's passkey is left in the authenticator, for the user to delete by
   * hand (D120), until dismissed.
   */
  get leftoverPasskey(): boolean {
    return this.#leftoverPasskey;
  }

  dismissLeftoverPasskey(): void {
    this.#leftoverPasskey = false;
    this.#set({ ...this.#status });
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

  /**
   * Resets the forgotten local password with the Recovery Phrase (§14, D173, D184): `words` as
   * typed, and `password`, already checked for strength by the caller (D71). The vault must be
   * locked; it ends unlocked. Only Local Config is written, in one commit; a lock before it aborts
   * with nothing written (D104).
   */
  async resetPassword(words: string, password: string): Promise<PasswordReset> {
    const db = this.#db;
    if (this.#status.kind !== 'locked' || !db) return { kind: 'unavailable' };
    const epoch = this.#epoch;
    const keyring = new Keyring();
    let entropy: SymmetricKey;
    try {
      entropy = parseRecoveryPhrase(keyring, words);
    } catch (error) {
      keyring.wipeAll();
      if (!(error instanceof PhraseRejectedError)) throw error;
      const { reason, position } = error;
      return { kind: 'invalid', reason, ...(position !== undefined ? { position } : {}) };
    }
    this.#set({ kind: 'resetting' });
    try {
      const config = await this.#readConfig(db);
      if (!config) throw new Aborted();
      const salt = generateSalt();
      const { kek, params } = await calibrateDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
      );
      if (epoch !== this.#epoch) throw new Aborted();
      const session = await VaultSession.resetPassword({
        store: db,
        localConfig: config,
        keyring,
        entropy,
        kek,
        salt,
        kdfParams: params,
        now: this.#now,
      });
      if (epoch !== this.#epoch) {
        // Committed: the new password is set, and the lock stands.
        session.lock();
        return { kind: 'ok' };
      }
      this.#set({ kind: 'unlocked', session });
      return { kind: 'ok' };
    } catch (error) {
      keyring.wipeAll();
      if (error instanceof Aborted || epoch !== this.#epoch) {
        if (this.getStatus().kind === 'resetting') this.#set({ kind: 'locked' });
        return { kind: 'locked' };
      }
      if (error instanceof PasswordResetRejectedError) {
        this.#set({ kind: 'locked' });
        return { kind: error.reason };
      }
      if (error instanceof ContentInvalidError || error instanceof KdfParamsRejectedError) {
        this.#set({ kind: 'corrupt' });
        return { kind: 'locked' };
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
    this.#phrase?.keyring.wipeAll();
    this.#phrase = undefined;
    this.#dropRestore();
    this.#afterRestore = undefined;
    this.#readmission = false;
    this.#ready = undefined;
    this.#dropRefounding();
    this.#refounded = false;
    this.#reminderDismissed = undefined;
    // Before the session locks: the peer learns why the pairing ended (D93).
    this.#pairing?.end('locked');
    this.#pairing = undefined;
    const status = this.#status;
    if (status.kind === 'unlocked') status.session.lock();
    if (status.kind === 'unlocked' || status.kind === 'unlocking') this.#set({ kind: 'locked' });
    if (status.kind === 'joining') this.#set(this.#joined());
    if (status.kind === 'creating' || status.kind === 'restoring') this.#set({ kind: 'no-vault' });
    if (status.kind === 'replacing' || status.kind === 'resetting') this.#set({ kind: 'locked' });
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
  async changePassword(current: string, next: string): Promise<PasswordChange> {
    const status = this.#status;
    if (status.kind !== 'unlocked' || !this.#db) return 'locked';
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
      if (error instanceof VaultLockedError) return 'locked';
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

  // --- Recovery Phrase ---------------------------------------------------------------------------

  /**
   * Whether the unlocked vault has a Recovery Envelope to check: `none` for a D177 preview vault
   * (D179), `corrupt` for one kept aside at unlock.
   */
  recoveryEnvelope(): 'held' | 'none' | 'corrupt' | 'locked' {
    const status = this.#status;
    if (status.kind !== 'unlocked') return 'locked';
    if (status.session.recovery) return 'held';
    const corrupt = status.session
      .corrupt()
      .some((k) => k.recordType === RecordType.recoveryEnvelope);
    return corrupt ? 'corrupt' : 'none';
  }

  /**
   * Check Recovery Phrase (§5.4, D24, D180) on `input`, the phrase as typed. Writes nothing; the
   * caller drops `input` once checked.
   */
  checkRecoveryPhrase(input: string): PhraseCheck {
    const status = this.#status;
    if (status.kind !== 'unlocked') return { kind: 'locked' };
    try {
      return { kind: status.session.checkRecoveryPhrase(input) };
    } catch (error) {
      if (error instanceof PhraseRejectedError) {
        const { reason, position } = error;
        return { kind: 'invalid', reason, ...(position !== undefined ? { position } : {}) };
      }
      if (error instanceof VaultLockedError) return { kind: 'locked' };
      throw error;
    }
  }

  // --- backup ------------------------------------------------------------------------------------

  /**
   * Makes a backup (§10, D181): the local password, or a passkey assertion asked for first while
   * the click's user activation lasts, opens the Master Key wrap again. `exportPassword`, already
   * checked for strength by the caller (D134, D155), adds the password keyslot. The caller hands
   * the file to the browser.
   */
  async exportBackup(auth: ExportAuth, exportPassword?: string): Promise<BackupExport> {
    const status = this.#status;
    const db = this.#db;
    if (status.kind !== 'unlocked' || !db) return { kind: 'locked' };
    const epoch = this.#epoch;
    const keyring = new Keyring();
    try {
      const kek = await this.#reauthenticate(auth, keyring, db);
      if (typeof kek === 'string') return { kind: kek };
      if (epoch !== this.#epoch) return { kind: 'locked' };
      const file = await status.session.exportBackup({
        kek,
        method: auth.kind,
        ...(exportPassword !== undefined
          ? {
              exportPassword: {
                password: normalizePassword(exportPassword),
                port: this.#deps.kdf(),
              },
            }
          : {}),
      });
      this.#set({ ...status });
      return { kind: 'ok', bytes: file.bytes, name: backupFileName(file.exportedAt) };
    } catch (error) {
      const failure = reauthFailure(error, auth);
      if (failure) return { kind: failure };
      if (error instanceof ExportRejectedError) {
        const { record } = error;
        if (!record) return { kind: 'no-envelope' };
        return {
          kind: 'corrupt-record',
          recordType: record.recordType,
          recordId: recordIdPrefix(record.recordId),
        };
      }
      throw error;
    } finally {
      keyring.wipeAll();
    }
  }

  /**
   * The KEK that opens the Master Key wrap again, derived into `keyring` (D181, D185): from a
   * passkey assertion asked for first, while the click's user activation lasts, or from the local
   * password. A ceremony that gave no result, or a Local Config gone, returns why.
   */
  async #reauthenticate(
    auth: ExportAuth,
    keyring: Keyring,
    db: VaultDatabase,
  ): Promise<SymmetricKey | 'cancelled' | 'unavailable' | 'locked'> {
    if (auth.kind === 'password') {
      const config = await this.#readConfig(db);
      if (!config) return 'locked';
      const { salt, opslimit, memlimit } = config.kek;
      return deriveDeviceKek(keyring, this.#deps.kdf(), normalizePassword(auth.password), salt, {
        opslimit,
        memlimit,
      });
    }
    const passkeys = this.#deps.passkeys;
    const held = this.#passkey;
    if (!passkeys || !held) return 'unavailable';
    let assertion: PasskeyResult;
    try {
      assertion = await passkeys.get(held.credentialId, held.prfInput);
    } catch (error) {
      return ceremonyFailure(error);
    }
    try {
      if (!sameBytes(assertion.credentialId, held.credentialId)) throw new UnlockRejectedError();
      if (!assertion.prfOutput) throw new PrfUnavailableError();
      return derivePrfKek(keyring, {
        authenticatorData: assertion.authenticatorData,
        prfOutput: assertion.prfOutput,
      });
    } finally {
      assertion.prfOutput?.fill(0);
    }
  }

  // --- Recovery Phrase regeneration --------------------------------------------------------------

  /**
   * A new Recovery Phrase for a regeneration of the unlocked vault (§5.4, D185): its 24 words, to
   * show once. Replaces any phrase handed out before. `undefined` unless unlocked and regeneration
   * is possible (`VaultSession.regenerationBlock`). The words are a string, which cannot be wiped:
   * the UI keeps them only until the phrase is confirmed.
   */
  newRegenerationPhrase(): string | undefined {
    const status = this.#status;
    if (status.kind !== 'unlocked' || status.session.regenerationBlock) return undefined;
    this.#phrase?.keyring.wipeAll();
    const keyring = new Keyring();
    const { words, entropy } = generateRecoveryPhrase(keyring);
    this.#phrase = { keyring, entropy };
    this.#set({ ...status });
    return words;
  }

  /**
   * Whether a regeneration's phrase is being shown or confirmed: the inactivity lock pauses until it
   * is committed, cancelled or locked away (D104).
   */
  get showingPhrase(): boolean {
    return this.#status.kind === 'unlocked' && this.#phrase !== undefined;
  }

  /**
   * Whether an asset update may be offered now (D152, D191): with no vault, locked or unlocked, and
   * no restore, merge, re-founding, pairing, shown Recovery Phrase or step that follows one in
   * progress.
   */
  get updateAllowed(): boolean {
    const { kind } = this.#status;
    if (kind !== 'no-vault' && kind !== 'locked' && kind !== 'unlocked') return false;
    return (
      this.#phrase === undefined &&
      this.#restore === undefined &&
      this.#afterRestore === undefined &&
      !this.#readmission &&
      this.#refounding === undefined &&
      !this.#refounded &&
      this.#pairing === undefined
    );
  }

  /** Drops the phrase handed out for a regeneration. */
  cancelRegeneration(): void {
    const status = this.#status;
    if (status.kind !== 'unlocked' || !this.#phrase) return;
    this.#phrase.keyring.wipeAll();
    this.#phrase = undefined;
    this.#set({ ...status });
  }

  /**
   * Regenerates the Recovery Phrase with the phrase last handed out by `newRegenerationPhrase`, once
   * confirmed (§5.4, D185): the local password, or a passkey assertion, opens the Master Key wrap
   * again, as for an export (D181). A wrong password or a failed ceremony keeps the phrase for
   * another try; the commit and a block drop it.
   */
  async regenerateRecoveryPhrase(auth: ExportAuth): Promise<Regeneration> {
    const status = this.#status;
    const db = this.#db;
    if (status.kind !== 'unlocked' || !db) return { kind: 'locked' };
    const phrase = this.#phrase;
    if (!phrase) return { kind: 'no-phrase' };
    const drop = () => {
      if (this.#phrase !== phrase) return;
      phrase.keyring.wipeAll();
      this.#phrase = undefined;
      this.#set({ ...status });
    };
    const block = status.session.regenerationBlock;
    if (block) {
      drop();
      return { kind: 'blocked', block };
    }
    const epoch = this.#epoch;
    const keyring = new Keyring();
    try {
      const kek = await this.#reauthenticate(auth, keyring, db);
      if (typeof kek === 'string') return { kind: kek };
      if (epoch !== this.#epoch) return { kind: 'locked' };
      const recovery = await status.session.regenerateRecoveryPhrase({
        kek,
        method: auth.kind,
        entropy: phrase.entropy,
      });
      drop();
      return { kind: 'ok', recovery };
    } catch (error) {
      if (epoch !== this.#epoch) return { kind: 'locked' };
      const failure = reauthFailure(error, auth);
      if (failure) return { kind: failure };
      if (error instanceof RegenerationBlockedError) {
        drop();
        return { kind: 'blocked', block: error.block };
      }
      throw error;
    } finally {
      keyring.wipeAll();
    }
  }

  // --- pairing -----------------------------------------------------------------------------------

  /** The pairing in progress on this device, as its screens show it (§8.4, D203). */
  get pairing(): PairingStage | undefined {
    return this.#pairing?.stage;
  }

  #pairingChanged = (): void => {
    this.#set({ ...this.#status });
  };

  /**
   * A starts a pairing (§8.4, D202): the local password, or a passkey assertion asked for first
   * while the click's user activation lasts, opens the Master Key wrap again for this pairing alone,
   * then the connection is gathered and A's payload shown. An unregistered device names its own
   * Device record `defaultName` (D141, D203).
   */
  async startPairing(
    auth: ExportAuth,
    options: PairingOptions & { readonly defaultName: string },
  ): Promise<PairingStart> {
    const status = this.#status;
    const db = this.#db;
    const port = this.#deps.pairing;
    if (status.kind !== 'unlocked' || !db) return 'locked';
    if (!port) return 'no-webrtc';
    this.#dropPairing();
    const epoch = this.#epoch;
    const keyring = new Keyring();
    let grant: PairingGrant;
    let readmit: boolean;
    try {
      const kek = await this.#reauthenticate(auth, keyring, db);
      if (typeof kek === 'string') return kek;
      if (epoch !== this.#epoch) return 'locked';
      const { session } = status;
      const registered = session.registered;
      readmit = !registered && devicesOf(session).listed.some((d) => !d.own);
      grant = session.openPairing({
        kek,
        method: auth.kind,
        ...(registered ? {} : { displayName: options.defaultName }),
      });
    } catch (error) {
      if (epoch !== this.#epoch) return 'locked';
      const failure = reauthFailure(error, auth);
      if (failure) return failure;
      if (error instanceof PairingRefusedError && error.reason !== 'known-device') {
        return error.reason;
      }
      throw error;
    } finally {
      keyring.wipeAll();
    }
    const flow = new Inviting({
      port,
      sameNetwork: options.sameNetwork,
      grant,
      readmit,
      onChange: this.#pairingChanged,
    });
    this.#pairing = flow;
    this.#set({ ...status });
    await flow.begin();
    return 'ok';
  }

  /** A takes B's answer, pasted (§3.4). */
  pairingAnswer(text: string): PayloadCheck {
    const flow = this.#pairing;
    return flow instanceof Inviting ? flow.answer(text) : 'unavailable';
  }

  /**
   * B starts joining a pairing from an installation with no vault (§8.4, D33): `password`, already
   * checked for strength by the caller (D71), becomes its local password; the Device KEK and the
   * identity exist in memory only until the commit. Holds the installation guard until then (D97);
   * any lock before it ends the pairing with nothing persisted (D93, D104).
   *
   * With `replace`, the locked vault is replaced, after the confirmation the UI asked for (D204).
   * This app window already holds its Web Lock (D154), and the old vault stays intact until the
   * commit (D150, D153).
   */
  async beginJoin(
    password: string,
    options: PairingOptions & { readonly name: string; readonly replace?: boolean },
  ): Promise<'ok' | 'busy' | 'locked' | 'unavailable'> {
    const port = this.#deps.pairing;
    const { kind } = this.#status;
    const old =
      kind === 'locked' && options.replace === true && this.#db && this.#vaultId && this.#lock
        ? { db: this.#db, vaultId: this.#vaultId, lock: this.#lock, passkey: this.#passkey }
        : undefined;
    if ((kind !== 'no-vault' && !old) || !port) return 'unavailable';
    const epoch = this.#epoch;
    const joining: Status = old ? { kind: 'joining', replacing: true } : { kind: 'joining' };
    this.#set(joining);
    const guard = await acquireInstallationGuard(this.#deps.locks);
    if (!guard) {
      if (epoch === this.#epoch) this.#set(old ? { kind: 'locked' } : { kind: 'busy' });
      return 'busy';
    }
    const keyring = new Keyring();
    try {
      if (epoch !== this.#epoch) throw new Aborted();
      const salt = generateSalt();
      const { kek, params } = await calibrateDeviceKek(
        keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
      );
      if (epoch !== this.#epoch) throw new Aborted();
      const identity = generateDeviceIdentity(keyring);
      this.#pairing = new Joining({
        port,
        sameNetwork: options.sameNetwork,
        identity,
        name: options.name,
        keyring,
        onChange: this.#pairingChanged,
        commit: (received, peerPublicKey) =>
          this.#join(epoch, old, {
            keyring,
            kek,
            salt,
            kdfParams: params,
            identity,
            vaultId: received.vaultId,
            masterKey: received.masterKey,
            records: received.records,
            peerPublicKey,
          }),
        released: () => void guard.release(),
      });
      this.#set(joining);
      return 'ok';
    } catch (error) {
      keyring.wipeAll();
      await guard.release();
      if (this.#status.kind === 'joining') this.#set(this.#joined());
      if (error instanceof Aborted || epoch !== this.#epoch) return 'locked';
      throw error;
    }
  }

  /** B takes A's payload, pasted (§3.4), and shows its answer once gathered. */
  async joinOffer(text: string): Promise<PayloadCheck> {
    const flow = this.#pairing;
    return flow instanceof Joining ? flow.offer(text) : 'unavailable';
  }

  /** The status a joining device goes back to when its pairing ends before the commit. */
  #joined(): Status {
    const status = this.#status;
    return status.kind === 'joining' && status.replacing
      ? { kind: 'locked' }
      : { kind: 'no-vault' };
  }

  /**
   * B's single commit (§8 step 6, D33): the vault is this window's from then on. A lock after the
   * commit leaves it committed and locked; one before aborts it with nothing persisted, and the
   * vault it replaces stays intact. Another vault commits a database of its own that records the
   * replaced `vaultId`, then the old database is deleted (D89, D96, D150); the same vault commits in
   * the existing database, clearing it in the same transaction (D153). The old vault's passkey is
   * forgotten afterwards (D120).
   */
  async #join(
    epoch: number,
    old:
      | {
          readonly db: VaultDatabase;
          readonly vaultId: Uint8Array;
          readonly lock: HeldLock;
          readonly passkey: { readonly credentialId: Uint8Array } | undefined;
        }
      | undefined,
    options: Omit<Parameters<typeof VaultSession.join>[0], 'store' | 'now'>,
  ): Promise<VaultSession> {
    const { factory, locks } = this.#deps;
    const same = old !== undefined && sameBytes(old.vaultId, options.vaultId);
    let db: VaultDatabase | undefined;
    let lock: HeldLock | undefined;
    let clear = same;
    const store: RecordStore = {
      records: () => (db && !clear ? db.records() : Promise.resolve([])),
      commit: async (commit) => {
        if (epoch !== this.#epoch) throw new Aborted();
        if (!db) {
          if (same) {
            db = old.db;
            lock = old.lock;
          } else {
            const { vaultId } = parseLocalConfig(commit.localConfig);
            lock = (await acquireVaultLock(vaultId, {}, locks)) ?? undefined;
            if (!lock) throw new Aborted();
            db = await VaultDatabase.open(vaultId, factory);
          }
        }
        // D153: the first commit clears the old vault in the transaction that writes the new one.
        await db.commit(clear ? { ...commit, clear } : commit);
        clear = false;
      },
    };
    let session: VaultSession;
    try {
      session = await VaultSession.join({
        ...options,
        ...(old && !same ? { replacesVaultId: old.vaultId } : {}),
        store,
        now: this.#now,
      });
      if (!db || !lock) throw new Aborted();
    } catch (error) {
      if (db !== old?.db) db?.close();
      if (lock !== old?.lock) await lock?.release();
      if (error instanceof Aborted) throw new VaultLockedError();
      throw error;
    }
    if (old && !same) {
      old.db.close();
      try {
        await deleteDatabase(factory, databaseName(old.vaultId));
        await session.forgetReplacedVault();
      } catch {
        // The new vault has committed: the startup cleanup deletes the old one (D89, D96).
      }
      this.#hold(lock);
      await old.lock.release();
    } else if (!same) {
      this.#hold(lock);
    }
    this.#db = db;
    this.#vaultId = session.vaultId;
    this.#passkey = undefined;
    if (old?.passkey) {
      const forgotten = await this.#deps.passkeys?.forget(old.passkey.credentialId);
      this.#leftoverPasskey = forgotten !== true;
    }
    if (epoch !== this.#epoch) {
      // Committed: the vault exists, and the lock stands.
      session.lock();
      this.#set({ kind: 'locked' });
      return session;
    }
    this.#pairing = undefined;
    this.#ready = { start: 'paired' };
    this.#set({ kind: 'unlocked', session });
    void this.#requestPersistence();
    return session;
  }

  /** The user said the SAS matches the other device's (§6.4). */
  confirmSas(): void {
    this.#pairing?.confirm();
  }

  /** The user said the SAS differs from the other device's: the pairing aborts (§6.4). */
  rejectSas(): void {
    this.#pairing?.reject();
  }

  /**
   * Cancels the pairing, or closes one that ended: B goes back to having no vault. Any secret of the
   * session is wiped.
   */
  cancelPairing(): void {
    this.#dropPairing();
    if (this.#status.kind === 'joining') this.#set(this.#joined());
    else this.#set({ ...this.#status });
  }

  #dropPairing(): void {
    this.#pairing?.end('cancelled');
    this.#pairing = undefined;
  }

  // --- re-founding --------------------------------------------------------------------------------

  /**
   * Starts a re-founding after its warnings (§14, D187): the local password, or a passkey assertion,
   * must open the Master Key wrap. Its KEK is held as the proof until the commit, a cancel or a lock.
   */
  async beginRefounding(auth: ExportAuth): Promise<RefoundingStart> {
    const status = this.#status;
    const db = this.#db;
    if (status.kind !== 'unlocked' || !db) return 'locked';
    this.#dropRefounding();
    const epoch = this.#epoch;
    const keyring = new Keyring();
    try {
      const kek = await this.#reauthenticate(auth, keyring, db);
      if (typeof kek === 'string') {
        keyring.wipeAll();
        return kek;
      }
      if (epoch !== this.#epoch) throw new Aborted();
      status.session.confirmUser({ kek, method: auth.kind });
      this.#refounding = { keyring, kek, method: auth.kind };
      this.#set({ ...status });
      return 'ok';
    } catch (error) {
      keyring.wipeAll();
      if (error instanceof Aborted || epoch !== this.#epoch) return 'locked';
      const failure = reauthFailure(error, auth);
      if (failure) return failure;
      throw error;
    }
  }

  /**
   * The new Recovery Phrase of a re-founding, once `beginRefounding` proved the user: its 24 words,
   * to show once (D187). The inactivity lock pauses while it is held (`showingPhrase`, D104).
   */
  newRefoundingPhrase(): string | undefined {
    const status = this.#status;
    if (status.kind !== 'unlocked' || !this.#refounding) return undefined;
    this.#phrase?.keyring.wipeAll();
    const keyring = new Keyring();
    const { words, entropy } = generateRecoveryPhrase(keyring);
    this.#phrase = { keyring, entropy };
    this.#set({ ...status });
    return words;
  }

  /** Drops a re-founding in progress: its proof and its phrase. */
  cancelRefounding(): void {
    const status = this.#status;
    this.#dropRefounding();
    if (status.kind === 'unlocked') this.#set({ ...status });
  }

  #dropRefounding(): void {
    if (!this.#refounding) return;
    this.#refounding.keyring.wipeAll();
    this.#refounding = undefined;
    this.#phrase?.keyring.wipeAll();
    this.#phrase = undefined;
  }

  /**
   * Re-founds the vault (§14, D28, D89, D96, D187) with the confirmed phrase and `password`, already
   * checked for strength by the caller (D71). Holds the installation guard until the commit; a lock
   * before it aborts with the old vault intact (D93). The new Device record takes the old own
   * record's name, or `defaultName` on an unregistered device. After the commit, the old vault is
   * locked, its database deleted (the startup cleanup does it if this fails) and its passkey handled
   * as after a replacement (D120).
   */
  async refound(password: string, defaultName: string): Promise<Refounding> {
    const status = this.#status;
    const oldDb = this.#db;
    const oldLock = this.#lock;
    const oldVaultId = this.#vaultId;
    if (status.kind !== 'unlocked' || !oldDb || !oldLock || !oldVaultId) return { kind: 'locked' };
    const proof = this.#refounding;
    if (!proof) return { kind: 'not-started' };
    const phrase = this.#phrase;
    if (!phrase) return { kind: 'no-phrase' };
    const epoch = this.#epoch;
    const { factory, locks } = this.#deps;
    const guard = await acquireInstallationGuard(locks);
    if (!guard) return { kind: 'busy' };
    let db: VaultDatabase | undefined;
    let lock: HeldLock | undefined;
    try {
      if (epoch !== this.#epoch) throw new Aborted();
      const old = status.session;
      const own = old.devices().find((d) => sameBytes(d.deviceId, old.deviceId));
      const salt = generateSalt();
      const { kek, params } = await calibrateDeviceKek(
        phrase.keyring,
        this.#deps.kdf(),
        normalizePassword(password),
        salt,
      );
      if (epoch !== this.#epoch) throw new Aborted();
      const store: RecordStore = {
        records: () => (db ? db.records() : Promise.resolve([])),
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
      // The phrase's keyring becomes the new session's, as at creation.
      this.#phrase = undefined;
      const session = await VaultSession.refound(old, {
        store,
        keyring: phrase.keyring,
        kek,
        recoveryEntropy: phrase.entropy,
        salt,
        kdfParams: params,
        displayName: own?.device.displayName ?? defaultName,
        current: { kek: proof.kek, method: proof.method },
        now: this.#now,
      });
      if (!db || !lock) throw new Aborted();
      this.#dropRefounding();
      old.lock();
      oldDb.close();
      try {
        await deleteDatabase(factory, databaseName(oldVaultId));
        await session.forgetReplacedVault();
      } catch {
        // The new vault has committed: the startup cleanup deletes the old one (D89, D96).
      }
      this.#hold(lock);
      await oldLock.release();
      this.#db = db;
      this.#vaultId = session.vaultId;
      const oldPasskey = this.#passkey;
      this.#passkey = undefined;
      if (oldPasskey) {
        const forgotten = await this.#deps.passkeys?.forget(oldPasskey.credentialId);
        this.#leftoverPasskey = forgotten !== true;
      }
      this.#refounded = true;
      this.#set({ kind: 'unlocked', session });
      void this.#requestPersistence();
      return { kind: 'ok' };
    } catch (error) {
      phrase.keyring.wipeAll();
      if (this.#phrase === phrase) this.#phrase = undefined;
      db?.close();
      await lock?.release();
      if (error instanceof Aborted || epoch !== this.#epoch) return { kind: 'locked' };
      this.#dropRefounding();
      throw error;
    } finally {
      await guard.release();
    }
  }

  /** Right after a re-founding: back up the new vault, pair the other devices again (§14, D107). */
  get afterRefounding(): boolean {
    return this.#refounded;
  }

  dismissRefounded(): void {
    this.#refounded = false;
    this.#set({ ...this.#status });
  }

  /**
   * Retires another device's Device record (§8.4, D31, D41, D186), after the confirmation the UI
   * asks for; no password, since it exposes no secret. `refused`: this device's own record, one
   * already retired, or one not held as a Device.
   */
  async retireDevice(deviceId: Uint8Array): Promise<'ok' | 'refused' | 'locked'> {
    const status = this.#status;
    if (status.kind !== 'unlocked') return 'locked';
    try {
      await status.session.retireDevice(deviceId);
    } catch (error) {
      if (error instanceof VaultLockedError) return 'locked';
      if (error instanceof RetirementRefusedError || error instanceof RecordNotFoundError) {
        return 'refused';
      }
      throw error;
    }
    this.#set({ ...status });
    return 'ok';
  }

  async setPreferences(preferences: Preferences): Promise<void> {
    const status = this.#status;
    if (status.kind !== 'unlocked') return;
    await status.session.setPreferences(preferences);
    this.#set({ ...status });
  }
}
