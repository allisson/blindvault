// The unlocked vault session (D163): key handles, the HLC, the decrypted state loaded at unlock
// and every domain operation, written through a `RecordStore`. Locking wipes it (CRYPTO-INV-010).

import {
  type Keyslots,
  createPasswordKeyslot,
  createRecoveryKeyslot,
  sealBackup,
} from '@blindvault/backup';
import {
  type CborMap,
  type CborValue,
  CryptoError,
  DecryptionError,
  type DeviceIdentity,
  type Hlc,
  ITEM_CAP,
  type KdfParams,
  type KdfPort,
  Keyring,
  LocalPurpose,
  type MasterSubkeys,
  PRF_INPUT_LENGTH,
  RECORD_FORMAT_VERSION,
  type RecordEnvelope,
  type RecordHeader,
  type RecoveryCheckResult,
  RecordType,
  SALT_LENGTH,
  type Sealed,
  type SymmetricKey,
  checkKdfParams,
  checkRecoveryEnvelope,
  deriveMasterSubkeys,
  deriveRecoveryKeys,
  encodeCbor,
  generateDeviceIdentity,
  generateKey,
  isMasterKeyOf,
  itemContentLength,
  localAad,
  openLocalConfigPart,
  parseRecoveryPhrase,
  randomId,
  openRecoveryEnvelope,
  recoveryEnvelopeRecordId,
  sameKey,
  sealLocalConfigPart,
  sealPurgedTombstone,
  sealRecord,
  sealRecoveryEnvelope,
  sealVaultKeyRecord,
  unwrapKey,
  vaultKeyRecordId,
  verifyRecord,
  versionId,
  wrapKey,
} from '@blindvault/crypto';

import {
  type BlockedRecord,
  ContentInvalidError,
  ExportRejectedError,
  MergeRejectedError,
  PasswordResetRejectedError,
  RecordBlockedError,
  type RegenerationBlock,
  RegenerationBlockedError,
  RecordNotFoundError,
  RestoreRejectedError,
  SubtreeBlockedError,
  UnlockRejectedError,
  VaultLockedError,
} from './errors';
import {
  type Device,
  type Folder,
  type Kept,
  deviceToCbor,
  folderToCbor,
  readDevice,
  readFolder,
} from './folder';
import { FUTURE_CLOCK_BOUND_MS, HlcClock, compareHlc } from './hlc';
import { idKey, sameBytes } from './ids';
import {
  type Item,
  type ItemReading,
  type ReadOnlyRule,
  TITLE_MAX,
  itemToCbor,
  readItem,
} from './item';
import {
  DEFAULT_PREFERENCES,
  type LocalConfigCleartext,
  type LocalConfigState,
  type Preferences,
  localConfigStateToCbor,
  localConfigToCbor,
  preferencesValid,
  readLocalConfigState,
} from './local-config';
import { incomingDeviceWins, incomingWins, sameVersion } from './merge';
import { type RecordKey, type RecordStore, type StoredRecord } from './store';
import { codePointLength, compareBytes, isId } from './text';
import { type TreeNode, buildTree, displayedParents, isWithin } from './tree';

/** Item Versions kept per item: the 20 greatest `(hlc, versionId)` (D6). */
export const HISTORY_LIMIT = 20;
/** A tombstone's content is purged 30 days after the physical time of its HLC (D7, D27). */
export const PURGE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
/** While unlocked, the automatic purge and the history cut run this often (D94). */
export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const FIRST_EPOCH = 1;
/** The Recovery Envelope metadata keys this app knows (crypto-spec.md §9.5 step 8, D98). */
const RECOVERY_METADATA_KEYS = 3;

export type UnlockMethod = 'password' | 'passkey';

/** What a caller writes: the session alone sets `trashOperationId`. */
export type ItemInput = Omit<Item, 'trashOperationId'>;

/** Why a record is read-only (overview §6, D52, D74). */
export type ReadOnlyReason = 'newer-content' | 'future-clock';

export interface ItemView {
  readonly id: Uint8Array;
  readonly hlc: Hlc;
  readonly inTrash: boolean;
  /** For an item in the trash: when the automatic purge removes its content (Unix ms). */
  readonly purgeAt?: number;
  /** The decoded item; absent while it holds content from a newer app version. */
  readonly item?: Item;
  readonly readOnly?: ReadOnlyReason;
  /** The `record-content.md` §2 rule, for `newer-content`. */
  readonly readOnlyRule?: ReadOnlyRule;
}

export interface VersionView {
  readonly versionId: Uint8Array;
  /** The `hlc` of the snapshotted state. */
  readonly hlc: Hlc;
  readonly item?: Item;
  readonly readOnly?: ReadOnlyReason;
  readonly readOnlyRule?: ReadOnlyRule;
}

export interface FolderView {
  readonly id: Uint8Array;
  readonly hlc: Hlc;
  readonly name: string;
  /** The stored parent; the tree may show the folder elsewhere (orphan and cycle rules, D14). */
  readonly parentId?: Uint8Array;
  readonly inTrash: boolean;
  readonly trashOperationId?: Uint8Array;
  /** For a folder in the trash: when the automatic purge removes its content (Unix ms). */
  readonly purgeAt?: number;
  /** Content keys from a newer app version, kept on every write (D59). */
  readonly unknownKeys: readonly string[];
  /** A folder is never read-only for its content (D59), only for its HLC (D74). */
  readonly readOnly?: 'future-clock';
}

/** An item in the tree, with the title and folder it is placed by. */
export type TreeItem = ItemView & { readonly name: string; readonly folderId?: Uint8Array };

export type FolderTree = TreeNode<FolderView, TreeItem>;

export interface DeviceView {
  readonly deviceId: Uint8Array;
  readonly hlc: Hlc;
  readonly device: Device;
  /** Content keys from a newer app version, kept on every write (D59). */
  readonly unknownKeys: readonly string[];
}

/** The current Recovery Phrase, as the held Recovery Envelope's metadata says (§5.4). */
export interface RecoveryView {
  /** Seals a backup's recovery keyslot without the phrase (D16). */
  readonly keyslotPublicKey: Uint8Array;
  readonly phraseId: Uint8Array;
  /** Unix ms. */
  readonly phraseCreatedAt: number;
}

/**
 * What Check Recovery Phrase found (§5.4, D24, D180), or why it could not run: no Recovery
 * Envelope (a D177 preview vault, D179), or one kept aside as corrupt at unlock.
 */
export type RecoveryCheck = RecoveryCheckResult | 'no-envelope' | 'corrupt-envelope';

export interface BackupOptions {
  /**
   * The Device KEK of the local password (`password`) or the PRF KEK of a passkey assertion with
   * user verification (`passkey`), derived again for this export (D181). The caller wipes it.
   */
  readonly kek: SymmetricKey;
  readonly method: UnlockMethod;
  /**
   * The export password, normalized and already checked for strength (D134, D155), with the
   * Argon2id worker that derives its KEK. The password is wiped and the worker terminated.
   */
  readonly exportPassword?: { readonly password: Uint8Array; readonly port: KdfPort };
}

/** A `.bvault` file (backup-format.md), ready to hand to the browser. */
export interface BackupFile {
  readonly bytes: Uint8Array;
  /** Unix ms, as in the payload and the Local Config's last backup date. */
  readonly exportedAt: number;
}

export interface RegenerateOptions {
  /**
   * The Device KEK of the local password (`password`) or the PRF KEK of a passkey assertion with
   * user verification (`passkey`), derived again for this regeneration (D185). The caller wipes it.
   */
  readonly kek: SymmetricKey;
  readonly method: UnlockMethod;
  /** The entropy of the new Recovery Phrase, once confirmed (D179). The caller wipes it. */
  readonly entropy: SymmetricKey;
}

/** A Recovery Phrase named by its `phraseId` and creation date (Unix ms), as a notice shows it. */
export interface PhraseName {
  readonly phraseId: Uint8Array;
  readonly phraseCreatedAt: number;
}

export interface CreateOptions {
  readonly store: RecordStore;
  /** A new keyring holding only `kek` and `recoveryEntropy`; the session owns it from now on. */
  readonly keyring: Keyring;
  /** The Device KEK of the new local password; released once the Master Key is wrapped. */
  readonly kek: SymmetricKey;
  /** The entropy of the Recovery Phrase just confirmed; released once the envelope is sealed. */
  readonly recoveryEntropy: SymmetricKey;
  readonly salt: Uint8Array;
  readonly kdfParams: KdfParams;
  /** This device's Device record name (D30). */
  readonly displayName: string;
  readonly now?: () => number;
}

export interface RestoreOptions {
  readonly store: RecordStore;
  /** A new keyring holding only `kek` and the backup's Master Key; the session owns it from now on. */
  readonly keyring: Keyring;
  /** The Device KEK of the new local password; released once the Master Key is wrapped. */
  readonly kek: SymmetricKey;
  readonly salt: Uint8Array;
  readonly kdfParams: KdfParams;
  readonly backup: BackupRecords;
  /**
   * The `vaultId` of the vault this restore replaces, another one (D89): kept in the cleartext part
   * of Local Config until `forgetReplacedVault` (D96).
   */
  readonly replacesVaultId?: Uint8Array;
  readonly now?: () => number;
}

/** A backup validated by `packages/backup` (backup-format.md §8 steps 1 to 8). */
export interface BackupRecords {
  readonly vaultId: Uint8Array;
  /** In the caller's keyring, which the caller wipes. */
  readonly masterKey: SymmetricKey;
  readonly records: readonly StoredRecord[];
}

/** What a backup merge did and the notices it calls for, shown once (sync-protocol.md §1.6, D182). */
export interface MergeResult {
  /** Records this device did not hold. */
  readonly added: number;
  /** Held records the backup's copy replaced, a record kept aside as corrupt included. */
  readonly replaced: number;
  /** Item Versions written: received, or made from a conflict loser (D6). */
  readonly versions: number;
  /**
   * The Recovery Envelope's `phraseId` differs from the last one seen (D43), unless
   * `phraseSuperseded` says more.
   */
  readonly phraseChanged: boolean;
  /**
   * The envelope this device wrote, replaced by one of another `phraseId`: the phrase it names is
   * superseded (D145, D185).
   */
  readonly phraseSuperseded?: PhraseName;
  /** Device records never seen before, the own one excepted (D48, D53). */
  readonly newDevices: readonly DeviceView[];
  /** Device records seen before, now retired, the own one excepted (D47). */
  readonly retiredDevices: readonly DeviceView[];
  /** Conflict losers written by this device that the history kept no room for (D70). */
  readonly droppedLosers: readonly { readonly itemId: Uint8Array; readonly title: string }[];
}

export interface UnlockOptions {
  readonly store: RecordStore;
  /** The cleartext Local Config, read before the KEK was derived from it. */
  readonly localConfig: LocalConfigCleartext;
  /** A new keyring holding only `kek`; the session owns it from now on, and wipes it on failure. */
  readonly keyring: Keyring;
  /** The Device KEK (`password`) or the PRF KEK (`passkey`); released once used. */
  readonly kek: SymmetricKey;
  readonly method: UnlockMethod;
  readonly now?: () => number;
}

export interface ResetPasswordOptions {
  readonly store: RecordStore;
  /** The cleartext Local Config, read before the KEK was derived. */
  readonly localConfig: LocalConfigCleartext;
  /**
   * A new keyring holding only `entropy` and `kek`; the session owns it from now on, and wipes it on
   * failure.
   */
  readonly keyring: Keyring;
  /** The entropy of the Recovery Phrase as typed; released once the envelope is opened. */
  readonly entropy: SymmetricKey;
  /** The Device KEK of the new local password; released once the Master Key is wrapped. */
  readonly kek: SymmetricKey;
  readonly salt: Uint8Array;
  readonly kdfParams: KdfParams;
  readonly now?: () => number;
}

interface HeldItem {
  readonly header: RecordHeader;
  /** `null` for a purged tombstone. */
  readonly content: CborMap | null;
  readonly reading: ItemReading | null;
}

interface LiveItem extends HeldItem {
  readonly content: CborMap;
  readonly reading: { readonly readOnly: false; readonly item: Item };
}

interface HeldVersion {
  readonly header: RecordHeader;
  readonly itemId: Uint8Array;
  readonly reading: ItemReading;
  /** `{item, itemId}`, as written. */
  readonly content: CborMap;
}

interface HeldFolder {
  readonly header: RecordHeader;
  readonly folder: Kept<Folder> | null;
}

interface LiveFolder extends HeldFolder {
  readonly folder: Kept<Folder>;
}

interface HeldDevice {
  readonly header: RecordHeader;
  readonly device: Kept<Device>;
}

interface HeldRecovery {
  readonly header: RecordHeader;
  /** The metadata, verified to hold its three fields (crypto-spec.md §9.5 step 8). */
  readonly content: CborMap;
  /** As stored: Check Recovery Phrase opens its `mk` (D24). */
  readonly envelope: RecordEnvelope;
}

interface Write {
  readonly header: RecordHeader;
  /** The content written; `null` for a purged tombstone and for a Vault Key record. */
  readonly content: CborMap | null;
  readonly envelope: RecordEnvelope;
  /** For a Vault Key record of an epoch not held before: its key, held once committed. */
  readonly vaultKey?: SymmetricKey;
}

/** An Item Version a merge may keep: held, received, or made from a conflict loser (§1.4). */
interface Candidate {
  readonly header: RecordHeader;
  readonly held: boolean;
  /** Not held: written if the history cut keeps it. */
  readonly write?: Write;
  /** Made from a conflict loser: who wrote that state, for the D70 notice. */
  readonly loser?: { readonly deviceId: Uint8Array; readonly title: string };
}

/** What a merge records in Local Config (sync-protocol.md §1.5, D43, D48). */
type Seen = Pick<LocalConfigState, 'seenDevices' | 'seenRetiredDevices' | 'lastPhraseId'>;

type Cleartext = Omit<LocalConfigCleartext, 'encrypted'>;

interface Plan<T> {
  readonly writes: readonly Write[];
  readonly deletes: readonly RecordKey[];
  readonly result: T;
  /** A new cleartext part or new preferences: commits the Local Config even with no record. */
  readonly cleartext?: Cleartext;
  readonly preferences?: Preferences;
  /** The date of the last backup made on this device (§13.4). */
  readonly lastBackupAt?: number;
  readonly seen?: Seen;
}

/** The records held, decrypted at unlock. */
interface State {
  readonly vaultKeys: Map<number, SymmetricKey>;
  /** The Vault Key records' headers, by epoch: immutable once held (D42). */
  readonly vaultKeyHeaders: Map<number, RecordHeader>;
  readonly items: Map<string, HeldItem>;
  /** By `itemId`, then by `versionId`. */
  readonly versions: Map<string, Map<string, HeldVersion>>;
  readonly folders: Map<string, HeldFolder>;
  readonly devices: Map<string, HeldDevice>;
  /** `null` for a vault created before the Recovery Envelope existed (D177, D179). */
  recovery: HeldRecovery | null;
  readonly corrupt: RecordKey[];
}

function emptyState(): State {
  return {
    vaultKeys: new Map(),
    vaultKeyHeaders: new Map(),
    items: new Map(),
    versions: new Map(),
    folders: new Map(),
    devices: new Map(),
    recovery: null,
    corrupt: [],
  };
}

function copyHlc(hlc: Hlc): Hlc {
  return { physicalMs: hlc.physicalMs, counter: hlc.counter, deviceId: hlc.deviceId.slice() };
}

/** Descending `(hlc, versionId)`: the order of the history cut (D6). */
function newestFirst(a: RecordHeader, b: RecordHeader): number {
  return compareHlc(b.hlc, a.hlc) || compareBytes(b.recordId, a.recordId);
}

function sameContent(a: CborMap, b: CborMap): boolean {
  return sameBytes(encodeCbor(a), encodeCbor(b));
}

/** `item` without `trashOperationId`, at `folderId` (absent: the vault root). */
function liveItem(item: ItemInput, folderId: Uint8Array | undefined): Item {
  return {
    templateId: item.templateId,
    templateVersion: item.templateVersion,
    title: item.title,
    fields: item.fields,
    tags: item.tags,
    ...(item.notes !== undefined ? { notes: item.notes } : {}),
    ...(folderId !== undefined ? { folderId } : {}),
  };
}

function versionReading(content: CborMap): ItemReading {
  // An Item Version is exactly {item, itemId}; any other key is from a newer app version (§2).
  if (content.size !== 2) return { readOnly: true, rule: 1 };
  return readItem(content.get('item') as CborValue, null);
}

/** An Item Version as held. Verification checked its `item` map and `itemId` (steps 9, 10). */
function versionOf(header: RecordHeader, content: CborMap | null): HeldVersion {
  const itemId = content?.get('itemId');
  if (!content || !(itemId instanceof Uint8Array)) throw new ContentInvalidError('item version');
  return { header, itemId, reading: versionReading(content), content };
}

function addVersion(state: State, version: HeldVersion): void {
  const itemKey = idKey(version.itemId);
  const versions = state.versions.get(itemKey) ?? new Map<string, HeldVersion>();
  versions.set(idKey(version.header.recordId), version);
  state.versions.set(itemKey, versions);
}

function readOnlyOf(reading: ItemReading, beyond: boolean) {
  if (reading.readOnly) {
    return { readOnly: 'newer-content' as const, readOnlyRule: reading.rule };
  }
  return { item: reading.item, ...(beyond ? { readOnly: 'future-clock' as const } : {}) };
}

/**
 * Decrypts every stored record with the `crypto-spec.md` §9.5 verification. A record that fails
 * it, holds an invalid Folder or Device value (D59), or sits under another key than its header's
 * is kept aside as corrupt: never shown and never written. `known` are Vault Keys already held, used
 * first for their epochs, so a merged record verifies under the local Vault Key (D57).
 */
function load(
  keyring: Keyring,
  stored: readonly StoredRecord[],
  vaultId: Uint8Array,
  subkeys: MasterSubkeys,
  known?: ReadonlyMap<number, SymmetricKey>,
): { state: State; held: Hlc[] } {
  const state = emptyState();
  const held: Hlc[] = [];
  const keys = {
    vaultId,
    vaultKey: (epoch: number) => known?.get(epoch) ?? state.vaultKeys.get(epoch),
    vaultKeyWrapKey: subkeys.vaultKeyWrap,
    versionIdKey: subkeys.versionId,
  };
  // Vault Key records first: every other record needs the Vault Key of its epoch.
  const ordered = [
    ...stored.filter((s) => s.recordType === RecordType.vaultKey),
    ...stored.filter((s) => s.recordType !== RecordType.vaultKey),
  ];
  for (const s of ordered) {
    const corrupt = () => state.corrupt.push({ recordType: s.recordType, recordId: s.recordId });
    let verified;
    try {
      verified = verifyRecord(keyring, s.envelope, keys);
    } catch (error) {
      if (error instanceof CryptoError) {
        corrupt();
        continue;
      }
      throw error;
    }
    const { header } = verified.envelope;
    const { content, vaultKey } = verified;
    if (header.recordType !== s.recordType || !sameBytes(header.recordId, s.recordId)) {
      if (vaultKey) keyring.release(vaultKey);
      corrupt();
      continue;
    }
    held.push(header.hlc);
    if (vaultKey) {
      state.vaultKeys.set(header.keyEpoch, vaultKey);
      state.vaultKeyHeaders.set(header.keyEpoch, header);
      continue;
    }
    const key = idKey(header.recordId);
    try {
      switch (header.recordType) {
        case RecordType.item:
          state.items.set(key, {
            header,
            content,
            reading: content ? readItem(content, header.deleted) : null,
          });
          break;
        case RecordType.itemVersion:
          addVersion(state, versionOf(header, content));
          break;
        case RecordType.folder:
          state.folders.set(key, {
            header,
            folder: content ? readFolder(content, header.deleted) : null,
          });
          break;
        case RecordType.device:
          state.devices.set(key, { header, device: readDevice(content) });
          break;
        case RecordType.recoveryEnvelope:
          // Verification fixed its recordId (one per vault) and checked its metadata.
          if (!content) throw new ContentInvalidError('recovery envelope');
          state.recovery = { header, content, envelope: s.envelope };
          break;
        default:
          break;
      }
    } catch (error) {
      if (!(error instanceof ContentInvalidError)) throw error;
      held.pop();
      corrupt();
    }
  }
  return { state, held };
}

interface SessionParts {
  readonly store: RecordStore;
  readonly keyring: Keyring;
  readonly subkeys: MasterSubkeys;
  readonly identity: DeviceIdentity;
  readonly cleartext: Omit<LocalConfigCleartext, 'encrypted'>;
  readonly localState: LocalConfigState;
  readonly clock: HlcClock;
  readonly state: State;
  readonly now: () => number;
}

export class VaultSession {
  readonly #store: RecordStore;
  readonly #keyring: Keyring;
  readonly #subkeys: MasterSubkeys;
  readonly #identity: DeviceIdentity;
  #cleartext: Cleartext;
  #localState: LocalConfigState;
  readonly #clock: HlcClock;
  #state: State;
  readonly #now: () => number;
  #queue: Promise<unknown> = Promise.resolve();
  #timer: ReturnType<typeof setInterval> | undefined;
  #locked = false;

  private constructor(parts: SessionParts) {
    this.#store = parts.store;
    this.#keyring = parts.keyring;
    this.#subkeys = parts.subkeys;
    this.#identity = parts.identity;
    this.#cleartext = parts.cleartext;
    this.#localState = parts.localState;
    this.#clock = parts.clock;
    this.#state = parts.state;
    this.#now = parts.now;
  }

  /**
   * Creates a vault. One commit writes the Vault Key record, the Recovery Envelope of the confirmed
   * phrase (§5.4, D2, D16), this device's Device record (D30) and the Local Config, which records
   * the new `phraseId` as the last one seen (D43).
   */
  static async create(options: CreateOptions): Promise<VaultSession> {
    const { store, keyring, kek, recoveryEntropy, salt, kdfParams, displayName } = options;
    const now = options.now ?? Date.now;
    try {
      checkKdfParams(kdfParams);
      const vaultId = randomId();
      const localConfigId = randomId();
      const masterKey = generateKey(keyring);
      const mkWrap = wrapKey(
        kek,
        localAad(LocalPurpose.mkWrapDeviceKek, vaultId, localConfigId),
        masterKey,
      );
      keyring.release(kek);
      const recovery = deriveRecoveryKeys(keyring, recoveryEntropy);
      keyring.release(recoveryEntropy);
      const phrase = { phraseId: randomId(), phraseCreatedAt: Math.floor(now()) };
      const subkeys = deriveMasterSubkeys(keyring, masterKey);
      const identity = generateDeviceIdentity(keyring);
      const clock = HlcClock.create(identity.deviceId, now);
      const state = emptyState();
      state.vaultKeys.set(FIRST_EPOCH, generateKey(keyring));
      const session = new VaultSession({
        store,
        keyring,
        subkeys,
        identity,
        cleartext: {
          vaultId,
          localConfigId,
          kek: { salt, opslimit: kdfParams.opslimit, memlimit: kdfParams.memlimit, mkWrap },
        },
        localState: {
          preferences: DEFAULT_PREFERENCES,
          hlc: clock.state,
          lastPhraseId: phrase.phraseId,
        },
        clock,
        state,
        now,
      });
      try {
        await session.#run(() =>
          session.#founding(displayName, {
            masterKey,
            envelopeKey: recovery.envelopeKey,
            metadata: new Map<CborValue, CborValue>([
              ['keyslotPublicKey', recovery.keyslotPublicKey],
              ['phraseCreatedAt', phrase.phraseCreatedAt],
              ['phraseId', phrase.phraseId],
            ]),
          }),
        );
      } finally {
        // Only the public key outlives creation: the phrase-derived secrets go now (§5.4).
        keyring.release(recovery.envelopeKey);
        keyring.release(recovery.keyslotPrivateKey);
      }
      session.#startMaintenance();
      return session;
    } catch (error) {
      keyring.wipeAll();
      throw error;
    }
  }

  /**
   * A fresh restore (overview §10, D33): the backup's records, verified again and read as unlock
   * reads them, then written as they came with a new Local Config in one commit. Any record kept
   * aside as corrupt, the content checks of D59 included, rejects the whole restore with
   * `RestoreRejectedError` and writes nothing (D61, D64). The device gets a new identity and writes
   * no Device record (D30). A record beyond the future-clock bound does not advance the HLC, so the
   * vault stays writable and only that record is read-only until within the bound (D39, D109).
   */
  static async restore(options: RestoreOptions): Promise<VaultSession> {
    const { store, keyring, kek, salt, kdfParams, backup, replacesVaultId } = options;
    const now = options.now ?? Date.now;
    const { vaultId, masterKey, records } = backup;
    try {
      checkKdfParams(kdfParams);
      if (replacesVaultId && (!isId(replacesVaultId) || sameBytes(replacesVaultId, vaultId))) {
        // The same vault is replaced in its own database (D153), never through this field.
        throw new RangeError('replacesVaultId is the ID of another vault');
      }
      const localConfigId = randomId();
      const mkWrap = wrapKey(
        kek,
        localAad(LocalPurpose.mkWrapDeviceKek, vaultId, localConfigId),
        masterKey,
      );
      keyring.release(kek);
      const subkeys = deriveMasterSubkeys(keyring, masterKey);
      const { state, held } = load(keyring, records, vaultId, subkeys);
      const [corrupt] = state.corrupt;
      if (corrupt) throw new RestoreRejectedError(corrupt);
      const identity = generateDeviceIdentity(keyring);
      const start = HlcClock.create(identity.deviceId, now).state;
      const clock = HlcClock.resume(identity.deviceId, start, held, now);
      const phraseId = state.recovery?.content.get('phraseId');
      // D53: every restored device is seen, every retired one seen as retired, without a notice.
      const devices = [...state.devices.values()];
      const retired = devices.filter((d) => d.device.value.retired);
      const session = new VaultSession({
        store,
        keyring,
        subkeys,
        identity,
        cleartext: {
          vaultId,
          localConfigId,
          kek: { salt, opslimit: kdfParams.opslimit, memlimit: kdfParams.memlimit, mkWrap },
          ...(replacesVaultId ? { replacesVaultId: replacesVaultId.slice() } : {}),
        },
        localState: {
          preferences: DEFAULT_PREFERENCES,
          hlc: clock.state,
          ...(phraseId instanceof Uint8Array ? { lastPhraseId: phraseId } : {}),
          ...(devices.length > 0 ? { seenDevices: sortedIds(devices.map(deviceIdOf)) } : {}),
          ...(retired.length > 0 ? { seenRetiredDevices: sortedIds(retired.map(deviceIdOf)) } : {}),
        },
        clock,
        state,
        now,
      });
      // Not through the operation queue: the session is not returned until this commit lands.
      const localConfig = session.#localConfig();
      await store.commit({ put: records, delete: [], localConfig: localConfig.bytes });
      session.#localState = localConfig.localState;
      // The restore has committed: a failed purge pass leaves it as it is, as on the timer.
      await session.#run(() => session.#maintenance()).catch(() => undefined);
      session.#startMaintenance();
      return session;
    } catch (error) {
      keyring.wipeAll();
      throw error;
    }
  }

  /**
   * Unlocks with the KEK derived from the local password or the passkey's PRF output. A KEK that
   * does not open the Master Key wrap throws `UnlockRejectedError`; an encrypted part that does not
   * open or read throws `ContentInvalidError` (corrupt Local Config). Runs the purge before
   * returning.
   */
  static async unlock(options: UnlockOptions): Promise<VaultSession> {
    const { store, localConfig, keyring, kek, method } = options;
    const now = options.now ?? Date.now;
    const { vaultId, localConfigId } = localConfig;
    try {
      const wrap = method === 'password' ? localConfig.kek.mkWrap : localConfig.prf?.mkWrap;
      if (!wrap) throw new UnlockRejectedError();
      const purpose =
        method === 'password' ? LocalPurpose.mkWrapDeviceKek : LocalPurpose.mkWrapPrfKek;
      let masterKey: SymmetricKey;
      try {
        masterKey = unwrapKey(keyring, kek, localAad(purpose, vaultId, localConfigId), wrap);
      } catch (error) {
        if (error instanceof DecryptionError) throw new UnlockRejectedError();
        throw error;
      }
      keyring.release(kek);
      const subkeys = deriveMasterSubkeys(keyring, masterKey);
      let identity: DeviceIdentity;
      let localState: LocalConfigState;
      try {
        const opened = openLocalConfigPart(
          keyring,
          subkeys.localConfig,
          localAad(LocalPurpose.localConfig, vaultId, localConfigId),
          localConfig.encrypted,
        );
        identity = opened.identity;
        localState = readLocalConfigState(opened.content);
      } catch (error) {
        if (error instanceof CryptoError) throw new ContentInvalidError('local config');
        throw error;
      }
      const { state, held } = load(keyring, await store.records(), vaultId, subkeys);
      const session = new VaultSession({
        store,
        keyring,
        subkeys,
        identity,
        cleartext: {
          vaultId,
          localConfigId,
          kek: localConfig.kek,
          ...(localConfig.prf ? { prf: localConfig.prf } : {}),
          ...(localConfig.replacesVaultId ? { replacesVaultId: localConfig.replacesVaultId } : {}),
        },
        localState,
        clock: HlcClock.resume(identity.deviceId, localState.hlc, held, now),
        state,
        now,
      });
      await session.#run(() => session.#maintenance());
      session.#startMaintenance();
      return session;
    } catch (error) {
      keyring.wipeAll();
      throw error;
    }
  }

  /**
   * Resets a forgotten local password with the Recovery Phrase (§14, D173, D184), the vault locked.
   * The phrase opens the `mk` of the Recovery Envelope this device holds; the Master Key it yields
   * is proved by opening the encrypted part of this device's Local Config, then every record is
   * read as at unlock. Only Local Config is written: the Master Key wrapped under `kek`, with its
   * salt and calibrated parameters; the PRF wrap is kept. No HLC is issued, so it runs while the
   * vault is read-only for a clock gone back (D73). `PasswordResetRejectedError` writes nothing.
   */
  static async resetPassword(options: ResetPasswordOptions): Promise<VaultSession> {
    const { store, localConfig, keyring, entropy, kek, salt, kdfParams } = options;
    const now = options.now ?? Date.now;
    const { vaultId, localConfigId } = localConfig;
    try {
      checkKdfParams(kdfParams);
      if (salt.length !== SALT_LENGTH) throw new RangeError('salt is 16 bytes');
      const records = await store.records();
      const envelopeId = recoveryEnvelopeRecordId(vaultId);
      const held = records.find(
        (r) => r.recordType === RecordType.recoveryEnvelope && sameBytes(r.recordId, envelopeId),
      );
      if (!held) throw new PasswordResetRejectedError('no-envelope');
      const recovery = deriveRecoveryKeys(keyring, entropy);
      keyring.release(entropy);
      keyring.release(recovery.keyslotPrivateKey);
      let masterKey: SymmetricKey;
      try {
        masterKey = openRecoveryEnvelope(keyring, held.envelope, vaultId, recovery.envelopeKey);
      } catch (error) {
        if (error instanceof DecryptionError) throw new PasswordResetRejectedError('wrong-phrase');
        throw error;
      } finally {
        keyring.release(recovery.envelopeKey);
      }
      const mkWrap = wrapKey(
        kek,
        localAad(LocalPurpose.mkWrapDeviceKek, vaultId, localConfigId),
        masterKey,
      );
      keyring.release(kek);
      const subkeys = deriveMasterSubkeys(keyring, masterKey);
      keyring.release(masterKey);
      let identity: DeviceIdentity;
      let localState: LocalConfigState;
      try {
        const opened = openLocalConfigPart(
          keyring,
          subkeys.localConfig,
          localAad(LocalPurpose.localConfig, vaultId, localConfigId),
          localConfig.encrypted,
        );
        identity = opened.identity;
        localState = readLocalConfigState(opened.content);
      } catch (error) {
        // An envelope only a Master Key holder could write, or a damaged Local Config (D184).
        if (error instanceof CryptoError)
          throw new PasswordResetRejectedError('master-key-mismatch');
        throw error;
      }
      const { state, held: heldHlcs } = load(keyring, records, vaultId, subkeys);
      const cleartext: Cleartext = {
        vaultId,
        localConfigId,
        kek: localConfig.kek,
        ...(localConfig.prf ? { prf: localConfig.prf } : {}),
        ...(localConfig.replacesVaultId ? { replacesVaultId: localConfig.replacesVaultId } : {}),
      };
      const session = new VaultSession({
        store,
        keyring,
        subkeys,
        identity,
        cleartext,
        localState,
        clock: HlcClock.resume(identity.deviceId, localState.hlc, heldHlcs, now),
        state,
        now,
      });
      const next = { salt: salt.slice(), ...kdfParams, mkWrap };
      try {
        await session.#run(() => ({
          writes: [],
          deletes: [],
          result: undefined,
          cleartext: { ...cleartext, kek: next },
        }));
      } catch (error) {
        session.lock();
        throw error;
      }
      // The reset has committed: a failed purge pass leaves it as it is, as on the timer.
      await session.#run(() => session.#maintenance()).catch(() => undefined);
      session.#startMaintenance();
      return session;
    } catch (error) {
      keyring.wipeAll();
      throw error;
    }
  }

  // --- local settings ----------------------------------------------------------------------------

  /**
   * Changes the local password (D168). `current` must open the Master Key wrap, so a holder of the
   * unlocked device cannot set a password of their own (`UnlockRejectedError` otherwise); the
   * Master Key is then re-wrapped under `next`, with its new salt and calibrated parameters. Only
   * Local Config is written: no record changes, no HLC is issued. The caller wipes both KEKs.
   */
  async changePassword(options: {
    readonly current: SymmetricKey;
    readonly next: SymmetricKey;
    readonly salt: Uint8Array;
    readonly kdfParams: KdfParams;
  }): Promise<void> {
    const { current, next, salt, kdfParams } = options;
    checkKdfParams(kdfParams);
    if (salt.length !== SALT_LENGTH) throw new RangeError('salt is 16 bytes');
    await this.#run(() => {
      const { vaultId, localConfigId } = this.#cleartext;
      const aad = localAad(LocalPurpose.mkWrapDeviceKek, vaultId, localConfigId);
      let masterKey: SymmetricKey;
      try {
        masterKey = unwrapKey(this.#keyring, current, aad, this.#cleartext.kek.mkWrap);
      } catch (error) {
        if (error instanceof DecryptionError) throw new UnlockRejectedError();
        throw error;
      }
      let mkWrap: Sealed;
      try {
        mkWrap = wrapKey(next, aad, masterKey);
      } finally {
        this.#keyring.release(masterKey);
      }
      const kek = { salt: salt.slice(), ...kdfParams, mkWrap };
      return { writes: [], deletes: [], result: undefined, cleartext: { ...this.#cleartext, kek } };
    });
  }

  /**
   * Sets up passkey unlock (§5.5, D172): `current`, the Device KEK of the local password, must open
   * the Master Key wrap (`UnlockRejectedError` otherwise), so a holder of the unlocked device cannot
   * add a passkey of their own; the Master Key is then wrapped under `prfKek`, the PRF KEK of an
   * assertion with user verification (D75). Replaces a passkey set up before. Only Local Config is
   * written. The caller wipes both KEKs.
   */
  async setPasskey(options: {
    readonly current: SymmetricKey;
    readonly prfKek: SymmetricKey;
    readonly credentialId: Uint8Array;
    readonly prfInput: Uint8Array;
  }): Promise<void> {
    const { current, prfKek, credentialId, prfInput } = options;
    if (credentialId.length === 0) throw new RangeError('credential ID is empty');
    if (prfInput.length !== PRF_INPUT_LENGTH) throw new RangeError('PRF input is 32 bytes');
    await this.#run(() => {
      const { vaultId, localConfigId } = this.#cleartext;
      let masterKey: SymmetricKey;
      try {
        masterKey = unwrapKey(
          this.#keyring,
          current,
          localAad(LocalPurpose.mkWrapDeviceKek, vaultId, localConfigId),
          this.#cleartext.kek.mkWrap,
        );
      } catch (error) {
        if (error instanceof DecryptionError) throw new UnlockRejectedError();
        throw error;
      }
      let mkWrap: Sealed;
      try {
        mkWrap = wrapKey(
          prfKek,
          localAad(LocalPurpose.mkWrapPrfKek, vaultId, localConfigId),
          masterKey,
        );
      } finally {
        this.#keyring.release(masterKey);
      }
      const prf = { credentialId: credentialId.slice(), prfInput: prfInput.slice(), mkWrap };
      return { writes: [], deletes: [], result: undefined, cleartext: { ...this.#cleartext, prf } };
    });
  }

  /** Removes passkey unlock: deletes the PRF wrap, not the credential (D120). */
  async removePasskey(): Promise<void> {
    await this.#run(() => {
      const { prf, ...cleartext } = this.#cleartext;
      return { writes: [], deletes: [], result: undefined, ...(prf ? { cleartext } : {}) };
    });
  }

  /**
   * Drops the replaced `vaultId` from the cleartext part of Local Config, once the caller deleted
   * that vault's database (D89, D96). Nothing to drop writes nothing.
   */
  async forgetReplacedVault(): Promise<void> {
    await this.#run(() => {
      const { replacesVaultId, ...cleartext } = this.#cleartext;
      return {
        writes: [],
        deletes: [],
        result: undefined,
        ...(replacesVaultId ? { cleartext } : {}),
      };
    });
  }

  /**
   * Sets the security preferences (D151). A value outside its range is refused with
   * `RangeError`, never clamped; unchanged preferences write nothing.
   */
  async setPreferences(preferences: Preferences): Promise<void> {
    const next: Preferences = {
      autoLockMinutes: preferences.autoLockMinutes,
      hiddenLockSeconds: preferences.hiddenLockSeconds,
      clipboardClearSeconds: preferences.clipboardClearSeconds,
    };
    if (!preferencesValid(next)) throw new RangeError('preference outside its range');
    await this.#run(() => {
      const held = this.#localState.preferences;
      const same = (Object.keys(next) as (keyof Preferences)[]).every((k) => next[k] === held[k]);
      return { writes: [], deletes: [], result: undefined, ...(same ? {} : { preferences: next }) };
    });
  }

  // --- lock ------------------------------------------------------------------------------------

  get locked(): boolean {
    return this.#locked;
  }

  /**
   * Wipes every key and drops the decrypted state (overview §7, CRYPTO-INV-010). An operation in
   * progress is aborted: its promise rejects with `VaultLockedError`, though a commit already
   * handed to the store may still land.
   */
  lock(): void {
    if (this.#locked) return;
    this.#locked = true;
    clearInterval(this.#timer);
    this.#timer = undefined;
    this.#keyring.wipeAll();
    this.#state = emptyState();
  }

  #unlocked(): void {
    if (this.#locked) throw new VaultLockedError();
  }

  // --- reading ---------------------------------------------------------------------------------

  get vaultId(): Uint8Array {
    this.#unlocked();
    return this.#cleartext.vaultId.slice();
  }

  get deviceId(): Uint8Array {
    this.#unlocked();
    return this.#identity.deviceId.slice();
  }

  get preferences(): Preferences {
    this.#unlocked();
    return this.#localState.preferences;
  }

  /** The current Recovery Phrase, or `undefined` for a vault without a Recovery Envelope (D179). */
  get recovery(): RecoveryView | undefined {
    this.#unlocked();
    const held = this.#state.recovery;
    if (!held) return undefined;
    const { content } = held;
    return {
      keyslotPublicKey: (content.get('keyslotPublicKey') as Uint8Array).slice(),
      phraseId: (content.get('phraseId') as Uint8Array).slice(),
      phraseCreatedAt: content.get('phraseCreatedAt') as number,
    };
  }

  /**
   * Check Recovery Phrase (§5.4, D24, D180): whether `input`, the phrase as typed, opens the held
   * Recovery Envelope to this vault's Master Key and derives its recovery keyslot public key, so
   * backups open with it. Input that is not a phrase throws `PhraseRejectedError`. Writes nothing,
   * migrates nothing (only one `recordFormatVersion` exists, D38) and keeps no key it derived.
   */
  checkRecoveryPhrase(input: string): RecoveryCheck {
    this.#unlocked();
    const held = this.#state.recovery;
    if (!held) {
      const corrupt = this.#state.corrupt.some((k) => k.recordType === RecordType.recoveryEnvelope);
      return corrupt ? 'corrupt-envelope' : 'no-envelope';
    }
    const typed = new Keyring();
    try {
      return checkRecoveryEnvelope(
        held.envelope,
        this.#cleartext.vaultId,
        parseRecoveryPhrase(typed, input),
        this.#subkeys,
        held.content.get('keyslotPublicKey') as Uint8Array,
      );
    } finally {
      typed.wipeAll();
    }
  }

  /** Why Recovery Phrase regeneration is blocked now, or `undefined` when it is possible (D185). */
  get regenerationBlock(): RegenerationBlock | undefined {
    this.#unlocked();
    const held = this.#state.recovery;
    if (!held) {
      // An envelope kept aside as corrupt is replaced by regeneration (D185).
      const corrupt = this.#state.corrupt.some((k) => k.recordType === RecordType.recoveryEnvelope);
      if (!corrupt) return { reason: 'no-envelope' };
    }
    const writableAt = this.#clock.writableAt;
    if (writableAt !== null) return { reason: 'read-only', until: writableAt };
    if (!held) return undefined;
    // Verification checked the three known keys: any other is from a newer app version (D98).
    if (held.content.size !== RECOVERY_METADATA_KEYS) return { reason: 'newer-content' };
    if (this.#clock.beyondBound(held.header.hlc)) {
      return { reason: 'future-clock', until: held.header.hlc.physicalMs - FUTURE_CLOCK_BOUND_MS };
    }
    return undefined;
  }

  /**
   * Regenerates the Recovery Phrase (§5.4, D2, D185): `kek` must open the Master Key wrap of
   * `method` (`UnlockRejectedError` otherwise), since the session holds no Master Key. One commit
   * writes a new Recovery Envelope for `entropy`, with a new `phraseId`, under an HLC above the held
   * envelope's, and records the new `phraseId` as the last one seen (D43); no other record changes.
   * A block throws `RegenerationBlockedError` before anything is opened. The Master Key and the
   * phrase-derived keys live in a keyring of their own, wiped before this returns.
   */
  regenerateRecoveryPhrase(options: RegenerateOptions): Promise<RecoveryView> {
    const { kek, method, entropy } = options;
    return this.#run(() => {
      const block = this.regenerationBlock;
      if (block) throw new RegenerationBlockedError(block);
      const scratch = new Keyring();
      try {
        const masterKey = this.#openMasterKey(scratch, kek, method);
        const recovery = deriveRecoveryKeys(scratch, entropy);
        const phraseId = randomId();
        const phraseCreatedAt = Math.floor(this.#now());
        const metadata = new Map<CborValue, CborValue>([
          ['keyslotPublicKey', recovery.keyslotPublicKey],
          ['phraseCreatedAt', phraseCreatedAt],
          ['phraseId', phraseId],
        ]);
        const { vaultId } = this.#cleartext;
        // A corrupt envelope's header is not trusted: only the HLC state bounds the new one.
        const hlc = this.#clock.issue(this.#state.recovery?.header.hlc);
        const h = header(
          RecordType.recoveryEnvelope,
          recoveryEnvelopeRecordId(vaultId),
          hlc,
          false,
          this.#epoch(),
        );
        const envelope = sealRecoveryEnvelope(
          h,
          vaultId,
          this.#vaultKey(h.keyEpoch),
          recovery.envelopeKey,
          masterKey,
          metadata,
        );
        return {
          writes: [{ header: h, content: metadata, envelope }],
          deletes: [],
          result: {
            keyslotPublicKey: recovery.keyslotPublicKey.slice(),
            phraseId: phraseId.slice(),
            phraseCreatedAt,
          },
          seen: { lastPhraseId: phraseId },
        };
      } finally {
        scratch.wipeAll();
      }
    });
  }

  /** The `phraseId` of the last Recovery Envelope this device has seen (D43, D48). */
  get lastPhraseId(): Uint8Array | undefined {
    this.#unlocked();
    return this.#localState.lastPhraseId?.slice();
  }

  /** The last backup made on this device (Unix ms), as Local Config records it (§13.4). */
  get lastBackupAt(): number | undefined {
    this.#unlocked();
    const at = this.#localState.lastBackupAt;
    return at === undefined ? undefined : Number(at);
  }

  /** Local Config lists peers whose records this device rejected: a backup may lack them (D115). */
  get backupMayBeIncomplete(): boolean {
    this.#unlocked();
    return (this.#localState.rejectedPeers?.length ?? 0) > 0;
  }

  // --- backup ----------------------------------------------------------------------------------

  /**
   * Makes a `.bvault` file (backup-format.md §8, D181). `kek` must open the Master Key wrap of
   * `method` (`UnlockRejectedError` otherwise), since the session holds no Master Key. Every stored
   * record is read again and verified as on receipt; one that fails, or one kept aside at unlock,
   * throws `ExportRejectedError` naming it (D64). The Master Key, the file key and the export KEK
   * live in a keyring of their own, wiped before this returns. Records the date of the last backup
   * in Local Config; writes no record and issues no HLC.
   */
  exportBackup(options: BackupOptions): Promise<BackupFile> {
    const { kek, method, exportPassword } = options;
    return this.#run(async () => {
      const scratch = new Keyring();
      // The worker terminates itself once it answers; one never asked is terminated here.
      let derived = false;
      try {
        const [corrupt] = this.#state.corrupt;
        if (corrupt) throw new ExportRejectedError('corrupt-record', copyKey(corrupt));
        const recovery = this.recovery;
        if (!recovery) throw new ExportRejectedError('no-envelope');
        const masterKey = this.#openMasterKey(scratch, kek, method);
        const stored = await this.#store.records();
        this.#unlocked();
        this.#verifyAll(scratch, stored);
        const fileKey = generateKey(scratch);
        const recoverySlot = createRecoveryKeyslot(fileKey, recovery.keyslotPublicKey);
        let keyslots: Keyslots = [recoverySlot];
        if (exportPassword) {
          derived = true;
          const { password, port } = exportPassword;
          keyslots = [recoverySlot, await createPasswordKeyslot(scratch, port, fileKey, password)];
        }
        this.#unlocked();
        const exportedAt = Math.floor(this.#now());
        const bytes = sealBackup(
          fileKey,
          { phraseId: recovery.phraseId, phraseCreatedAt: recovery.phraseCreatedAt, keyslots },
          { vaultId: this.#cleartext.vaultId, exportedAt, masterKey },
          stored.map((s) => s.envelope),
        );
        return { writes: [], deletes: [], result: { bytes, exportedAt }, lastBackupAt: exportedAt };
      } finally {
        scratch.wipeAll();
        if (exportPassword) {
          exportPassword.password.fill(0);
          if (!derived) exportPassword.port.terminate();
        }
      }
    });
  }

  /** The Master Key, opened into `keyring` from the wrap of `method` (D181). */
  #openMasterKey(keyring: Keyring, kek: SymmetricKey, method: UnlockMethod): SymmetricKey {
    const { vaultId, localConfigId } = this.#cleartext;
    const wrap = method === 'password' ? this.#cleartext.kek.mkWrap : this.#cleartext.prf?.mkWrap;
    if (!wrap) throw new UnlockRejectedError();
    const purpose =
      method === 'password' ? LocalPurpose.mkWrapDeviceKek : LocalPurpose.mkWrapPrfKek;
    try {
      return unwrapKey(keyring, kek, localAad(purpose, vaultId, localConfigId), wrap);
    } catch (error) {
      if (error instanceof DecryptionError) throw new UnlockRejectedError();
      throw error;
    }
  }

  /** Verifies every stored record as `load` does (crypto-spec.md §9.5, D64); keys go to `keyring`. */
  #verifyAll(keyring: Keyring, stored: readonly StoredRecord[]): void {
    const keys = {
      vaultId: this.#cleartext.vaultId,
      vaultKey: (epoch: number) => this.#state.vaultKeys.get(epoch),
      vaultKeyWrapKey: this.#subkeys.vaultKeyWrap,
      versionIdKey: this.#subkeys.versionId,
    };
    for (const s of stored) {
      const refuse = () => new ExportRejectedError('corrupt-record', copyKey(s));
      let header: RecordHeader;
      try {
        header = verifyRecord(keyring, s.envelope, keys).envelope.header;
      } catch (error) {
        if (error instanceof CryptoError) throw refuse();
        throw error;
      }
      if (header.recordType !== s.recordType || !sameBytes(header.recordId, s.recordId)) {
        throw refuse();
      }
    }
  }

  // --- backup merge ----------------------------------------------------------------------------

  /**
   * A backup merge (overview §10, sync-protocol.md §1, D13, D57, D182): the backup's records, verified
   * under this vault's keys as on receipt, merged by the rules of sync and written with the Local
   * Config in one commit. Another vault, another Master Key, a record that fails verification or the
   * content checks, one beyond the future-clock bound or one that breaks the immutability of D42 or
   * D44 throws `MergeRejectedError` and writes nothing. Asks for no local password and issues no HLC,
   * so it runs while the vault is read-only for a clock gone back (D73). The caller wipes the
   * backup's keyring.
   */
  mergeBackup(backup: BackupRecords): Promise<MergeResult> {
    return this.#run(() => this.#merge(backup));
  }

  #merge(backup: BackupRecords): Plan<MergeResult> {
    const { vaultId } = this.#cleartext;
    if (!sameBytes(backup.vaultId, vaultId)) throw new MergeRejectedError('different-vault');
    if (!isMasterKeyOf(backup.masterKey, this.#subkeys)) {
      throw new MergeRejectedError('master-key-mismatch');
    }
    const incoming = load(
      this.#keyring,
      backup.records,
      vaultId,
      this.#subkeys,
      this.#state.vaultKeys,
    );
    let planned = false;
    try {
      const [corrupt] = incoming.state.corrupt;
      if (corrupt) throw new MergeRejectedError('corrupt-record', copyKey(corrupt));
      const beyond = incoming.held.filter((h) => this.#clock.beyondBound(h));
      if (beyond.length > 0) {
        const latest = Math.max(...beyond.map((h) => h.physicalMs));
        throw new MergeRejectedError('future-clock', undefined, latest - FUTURE_CLOCK_BOUND_MS);
      }
      this.#checkImmutable(incoming.state);
      const plan = this.#mergePlan(incoming.state, backup.records);
      for (const hlc of incoming.held) this.#clock.receive(hlc);
      planned = true;
      return plan;
    } finally {
      // A held epoch keeps its own key; a new one's key is kept only if the merge goes ahead.
      for (const [epoch, key] of incoming.state.vaultKeys) {
        if (!planned || this.#state.vaultKeys.has(epoch)) this.#keyring.release(key);
      }
    }
  }

  /** sync-protocol.md §1.3: a held Vault Key epoch, or a held `phraseId`, may not change (D42, D44). */
  #checkImmutable(incoming: State): void {
    for (const [epoch, header] of incoming.vaultKeyHeaders) {
      const held = this.#state.vaultKeyHeaders.get(epoch);
      const heldKey = this.#state.vaultKeys.get(epoch);
      const key = incoming.vaultKeys.get(epoch);
      if (!held || !heldKey || !key) continue;
      if (compareHlc(held.hlc, header.hlc) !== 0 || !sameKey(key, heldKey)) {
        throw new MergeRejectedError('immutable-record', headerKey(header));
      }
    }
    const envelope = incoming.recovery;
    const held = this.#state.recovery;
    if (!envelope || !held) return;
    if (!sameBytes(phraseIdOf(envelope), phraseIdOf(held))) return;
    if (
      compareHlc(envelope.header.hlc, held.header.hlc) !== 0 ||
      !sameContent(envelope.content, held.content)
    ) {
      throw new MergeRejectedError('immutable-record', headerKey(envelope.header));
    }
  }

  /** The writes of a merge that passed every check (sync-protocol.md §1.2 to §1.6). */
  #mergePlan(incoming: State, records: readonly StoredRecord[]): Plan<MergeResult> {
    const envelopes = new Map(records.map((r) => [recordKeyOf(r), r.envelope]));
    const corrupt = new Set(this.#state.corrupt.map(recordKeyOf));
    const writes: Write[] = [];
    const deletes: RecordKey[] = [];
    let added = 0;
    let replaced = 0;
    const now = this.#now();
    const due = (h: RecordHeader) => h.deleted && now >= h.hlc.physicalMs + PURGE_DELAY_MS;
    const vaultKeyOf = (epoch: number) =>
      this.#state.vaultKeys.get(epoch) ?? incoming.vaultKeys.get(epoch);
    /** The backup's record as it came, or purged on arrival when it is a tombstone past its date. */
    const take = (header: RecordHeader, content: CborMap | null, held: boolean): Write => {
      const key = recordKeyOf(header);
      if (held || corrupt.has(key)) replaced += 1;
      else added += 1;
      const write: Write =
        content && due(header)
          ? {
              header,
              content: null,
              envelope: sealPurgedTombstone(
                header,
                this.#cleartext.vaultId,
                present(vaultKeyOf(header.keyEpoch)),
              ),
            }
          : { header, content, envelope: present(envelopes.get(key)) };
      writes.push(write);
      return write;
    };

    // Vault Keys of an epoch not held (§1.3); a held one was checked unchanged.
    for (const [epoch, header] of incoming.vaultKeyHeaders) {
      if (this.#state.vaultKeyHeaders.has(epoch)) continue;
      const write = take(header, null, false);
      writes[writes.length - 1] = {
        ...write,
        vaultKey: present(incoming.vaultKeys.get(epoch)),
      };
    }

    // Items, then their history (§1.3, §1.4).
    const finalItems = new Map<string, HeldItem>();
    const history = new Map<string, { itemId: Uint8Array; versions: Map<string, Candidate> }>();
    const candidates = (itemId: Uint8Array) => {
      const itemKey = idKey(itemId);
      let entry = history.get(itemKey);
      if (!entry) {
        const versions = new Map<string, Candidate>();
        for (const v of this.#state.versions.get(itemKey)?.values() ?? []) {
          versions.set(idKey(v.header.recordId), { header: v.header, held: true });
        }
        entry = { itemId, versions };
        history.set(itemKey, entry);
      }
      return entry.versions;
    };
    for (const [key, item] of incoming.items) {
      const local = this.#state.items.get(key);
      let loser: HeldItem | undefined;
      if (local) {
        if (sameVersion(local.header, item.header)) continue;
        const wins = incomingWins(local.header, item.header);
        // The same state in another format is a migration: it makes no version (D38).
        const migration = compareHlc(local.header.hlc, item.header.hlc) === 0;
        loser = migration ? undefined : wins ? local : item;
        if (!wins) {
          this.#addLoser(candidates(item.header.recordId), loser);
          continue;
        }
      }
      const write = take(item.header, item.content, local !== undefined);
      finalItems.set(key, {
        header: item.header,
        content: write.content,
        reading: write.content ? item.reading : null,
      });
      this.#addLoser(candidates(item.header.recordId), loser);
    }
    for (const versions of incoming.versions.values()) {
      for (const [versionKey, version] of versions) {
        const map = candidates(version.itemId);
        if (map.has(versionKey)) continue;
        const key = recordKeyOf(version.header);
        if (corrupt.has(key)) replaced += 1;
        map.set(versionKey, {
          header: version.header,
          held: false,
          write: {
            header: version.header,
            content: version.content,
            envelope: present(envelopes.get(key)),
          },
        });
      }
    }
    let versionsWritten = 0;
    const droppedLosers: { itemId: Uint8Array; title: string }[] = [];
    for (const [itemKey, { itemId, versions }] of history) {
      const item = finalItems.get(itemKey) ?? this.#state.items.get(itemKey);
      const ranked = [...versions.values()].sort((a, b) => newestFirst(a.header, b.header));
      // A purged item keeps no history once the whole transfer is merged (D137).
      const cut = item && !item.content ? 0 : HISTORY_LIMIT;
      for (const [i, c] of ranked.entries()) {
        if (i < cut) {
          if (c.write) {
            writes.push(c.write);
            versionsWritten += 1;
          }
          continue;
        }
        if (c.held)
          deletes.push({ recordType: RecordType.itemVersion, recordId: c.header.recordId });
        if (c.loser && sameBytes(c.loser.deviceId, this.#identity.deviceId)) {
          droppedLosers.push({ itemId: itemId.slice(), title: c.loser.title });
        }
      }
    }

    // Folders: the loser is dropped (§1.3).
    for (const [key, folder] of incoming.folders) {
      const local = this.#state.folders.get(key);
      if (
        local &&
        (sameVersion(local.header, folder.header) || !incomingWins(local.header, folder.header))
      ) {
        continue;
      }
      take(folder.header, folder.folder?.content ?? null, local !== undefined);
    }

    // Devices: retirement wins (D31), and the notices of D47 and D48.
    const own = idKey(this.#identity.deviceId);
    const seen = new Map<string, Uint8Array>();
    const seenRetired = new Map<string, Uint8Array>();
    for (const id of this.#localState.seenDevices ?? []) seen.set(idKey(id), id);
    for (const id of this.#localState.seenRetiredDevices ?? []) seenRetired.set(idKey(id), id);
    for (const [key, d] of this.#state.devices) {
      seen.set(key, d.header.recordId);
      if (d.device.value.retired) seenRetired.set(key, d.header.recordId);
    }
    const heldNone = this.#state.devices.size === 0;
    const newDevices: DeviceView[] = [];
    const retiredDevices: DeviceView[] = [];
    for (const [key, device] of incoming.devices) {
      const local = this.#state.devices.get(key);
      if (local) {
        const before = { header: local.header, retired: local.device.value.retired };
        const after = { header: device.header, retired: device.device.value.retired };
        if (sameVersion(local.header, device.header) || !incomingDeviceWins(before, after))
          continue;
      }
      take(device.header, device.device.content, local !== undefined);
      if (key !== own && !heldNone) {
        if (!seen.has(key)) newDevices.push(deviceView(device));
        else if (device.device.value.retired && !seenRetired.has(key)) {
          retiredDevices.push(deviceView(device));
        }
      }
    }
    for (const device of incoming.devices.values()) {
      const id = device.header.recordId;
      seen.set(idKey(id), id);
      if (device.device.value.retired) seenRetired.set(idKey(id), id);
    }

    // The Recovery Envelope: another phraseId merges by last-write-wins (§1.3, D43).
    const envelope = incoming.recovery;
    const heldEnvelope = this.#state.recovery;
    let current = heldEnvelope;
    let phraseSuperseded: PhraseName | undefined;
    if (
      envelope &&
      (!heldEnvelope ||
        (!sameBytes(phraseIdOf(envelope), phraseIdOf(heldEnvelope)) &&
          incomingWins(heldEnvelope.header, envelope.header)))
    ) {
      take(envelope.header, envelope.content, heldEnvelope !== null);
      current = envelope;
      // The envelope replaced was this device's own: its phrase is superseded (D145, D185).
      if (heldEnvelope && sameBytes(heldEnvelope.header.hlc.deviceId, this.#identity.deviceId)) {
        phraseSuperseded = {
          phraseId: phraseIdOf(heldEnvelope).slice(),
          phraseCreatedAt: heldEnvelope.content.get('phraseCreatedAt') as number,
        };
      }
    }
    const lastPhraseId = current ? phraseIdOf(current) : this.#localState.lastPhraseId;
    const previous = this.#localState.lastPhraseId;
    const phraseChanged =
      !phraseSuperseded &&
      previous !== undefined &&
      lastPhraseId !== undefined &&
      !sameBytes(previous, lastPhraseId);

    const next: Seen = {
      ...(seen.size > 0 ? { seenDevices: sortedIds([...seen.values()]) } : {}),
      ...(seenRetired.size > 0 ? { seenRetiredDevices: sortedIds([...seenRetired.values()]) } : {}),
      ...(lastPhraseId ? { lastPhraseId } : {}),
    };
    const state = this.#localState;
    const unchanged =
      sameIds(state.seenDevices, next.seenDevices) &&
      sameIds(state.seenRetiredDevices, next.seenRetiredDevices) &&
      sameIds(state.lastPhraseId && [state.lastPhraseId], next.lastPhraseId && [next.lastPhraseId]);
    return {
      writes,
      deletes,
      result: {
        added,
        replaced,
        versions: versionsWritten,
        phraseChanged,
        ...(phraseSuperseded ? { phraseSuperseded } : {}),
        newDevices,
        retiredDevices,
        droppedLosers,
      },
      ...(unchanged ? {} : { seen: next }),
    };
  }

  /** A conflict loser as an Item Version of its own `hlc` (D6, D56); a purged tombstone adds none. */
  #addLoser(map: Map<string, Candidate>, loser: HeldItem | undefined): void {
    if (!loser?.content) return;
    const itemId = loser.header.recordId;
    const vid = versionId(this.#subkeys.versionId, itemId, loser.header.hlc);
    if (map.has(idKey(vid))) return;
    const content: CborMap = new Map<CborValue, CborValue>([
      ['item', loser.content],
      ['itemId', itemId],
    ]);
    const write = this.#seal(RecordType.itemVersion, vid, loser.header.hlc, false, content);
    const title = loser.content.get('title');
    map.set(idKey(vid), {
      header: write.header,
      held: false,
      write,
      loser: { deviceId: loser.header.hlc.deviceId, title: typeof title === 'string' ? title : '' },
    });
  }

  /** The credential ID of the passkey set up on this device, if any (§5.5). */
  get passkeyCredentialId(): Uint8Array | undefined {
    this.#unlocked();
    return this.#cleartext.prf?.credentialId.slice();
  }

  /** False while the HLC state is beyond the future-clock cap: nothing but purge writes (D73). */
  get writable(): boolean {
    this.#unlocked();
    return this.#clock.writable;
  }

  /** When writing resumes (Unix ms), or `null` when writable now. */
  get writableAt(): number | null {
    this.#unlocked();
    return this.#clock.writableAt;
  }

  /** Every item but purged tombstones, in the trash or not. */
  items(): ItemView[] {
    this.#unlocked();
    const out: ItemView[] = [];
    for (const held of this.#state.items.values()) {
      const view = this.#itemView(held);
      if (view) out.push(view);
    }
    return out;
  }

  item(id: Uint8Array): ItemView | undefined {
    this.#unlocked();
    const held = this.#state.items.get(idKey(id));
    return held ? this.#itemView(held) : undefined;
  }

  /** The item's history, newest first. */
  versions(itemId: Uint8Array): VersionView[] {
    this.#unlocked();
    const versions = [...(this.#state.versions.get(idKey(itemId))?.values() ?? [])];
    return versions
      .sort((a, b) => newestFirst(a.header, b.header))
      .map((v) => ({
        versionId: v.header.recordId.slice(),
        hlc: copyHlc(v.header.hlc),
        ...readOnlyOf(v.reading, this.#clock.beyondBound(v.header.hlc)),
      }));
  }

  devices(): DeviceView[] {
    this.#unlocked();
    return [...this.#state.devices.values()].map(deviceView);
  }

  /** Whether this device's own Device record is retired: the persistent D41 notice. */
  get retired(): boolean {
    this.#unlocked();
    return this.#state.devices.get(idKey(this.#identity.deviceId))?.device.value.retired === true;
  }

  /** Every folder but purged tombstones, in the trash or not. */
  folders(): FolderView[] {
    this.#unlocked();
    const out: FolderView[] = [];
    for (const held of this.#state.folders.values()) {
      if (held.folder) out.push(this.#folderView(held as LiveFolder));
    }
    return out;
  }

  folder(id: Uint8Array): FolderView | undefined {
    this.#unlocked();
    const held = this.#state.folders.get(idKey(id));
    return held?.folder ? this.#folderView(held as LiveFolder) : undefined;
  }

  /**
   * The tree of folders and items not in the trash, derived at read time (D14). Siblings sort by
   * `compare` on the name, the UI's collation, then by ID.
   */
  tree(compare: (a: string, b: string) => number = new Intl.Collator().compare): FolderTree {
    this.#unlocked();
    const folders = this.folders().filter((f) => !f.inTrash);
    const items: TreeItem[] = [];
    for (const held of this.#state.items.values()) {
      const view = this.#itemView(held);
      if (!view || view.inTrash || !held.content) continue;
      const title = held.content.get('title');
      const folderId = held.content.get('folderId');
      items.push({
        ...view,
        name: typeof title === 'string' ? title : '',
        ...(isId(folderId) ? { folderId: folderId.slice() } : {}),
      });
    }
    return buildTree(folders, items, compare);
  }

  #folderView(held: LiveFolder): FolderView {
    const { header } = held;
    const { value, unknownKeys } = held.folder;
    return {
      id: header.recordId.slice(),
      hlc: copyHlc(header.hlc),
      name: value.name,
      ...(value.parentId ? { parentId: value.parentId.slice() } : {}),
      inTrash: header.deleted,
      ...(value.trashOperationId ? { trashOperationId: value.trashOperationId.slice() } : {}),
      ...(header.deleted ? { purgeAt: header.hlc.physicalMs + PURGE_DELAY_MS } : {}),
      unknownKeys,
      ...(this.#clock.beyondBound(header.hlc) ? { readOnly: 'future-clock' as const } : {}),
    };
  }

  /** Records that failed verification at unlock: shown as corrupt, never written. */
  corrupt(): RecordKey[] {
    this.#unlocked();
    return this.#state.corrupt.map((k) => ({ recordType: k.recordType, recordId: k.recordId }));
  }

  #itemView(held: HeldItem): ItemView | undefined {
    if (!held.reading) return undefined;
    const { header } = held;
    return {
      id: header.recordId.slice(),
      hlc: copyHlc(header.hlc),
      inTrash: header.deleted,
      ...(header.deleted ? { purgeAt: header.hlc.physicalMs + PURGE_DELAY_MS } : {}),
      ...readOnlyOf(held.reading, this.#clock.beyondBound(header.hlc)),
    };
  }

  // --- item operations -------------------------------------------------------------------------

  /** A new item at the given folder or the vault root; returns its ID. No history. */
  createItem(input: ItemInput): Promise<Uint8Array> {
    return this.#run(() => {
      if (input.folderId) this.#target(input.folderId);
      const content = itemToCbor(liveItem(input, input.folderId), false);
      checkCap(content);
      const id = randomId();
      const write = this.#seal(RecordType.item, id, this.#clock.issue(), false, content);
      return { writes: [write], deletes: [], result: id.slice() };
    });
  }

  /**
   * A new item with item `id`'s current content, a new ID and no history (D135), its title
   * followed by `suffix`, the localized " (copy)" (D169). It goes in the folder where the original
   * is displayed: the vault root when the orphan rule applies (D156). Blocked for content from a
   * newer app version and for an item in the trash; allowed beyond the future-clock bound, since
   * the copy takes a fresh HLC (D140). Refused when the suffix takes the title or the item past
   * its cap.
   */
  duplicateItem(id: Uint8Array, suffix: string): Promise<Uint8Array> {
    return this.#run(() => {
      const held = this.#state.items.get(idKey(id));
      if (!held) throw new RecordNotFoundError();
      if (!held.content || !held.reading) throw new RecordBlockedError('purged');
      if (held.reading.readOnly) throw new RecordBlockedError('newer-content');
      if (held.header.deleted) throw new RecordBlockedError('in-trash');
      const { item } = (held as LiveItem).reading;
      const title = `${item.title}${suffix}`;
      if (codePointLength(title) > TITLE_MAX) throw new ContentInvalidError('title');
      // As the tree places it (overview §9.3): in its folder only while that folder is live here.
      const parent = item.folderId ? this.#state.folders.get(idKey(item.folderId)) : undefined;
      const folderId = parent?.folder && !parent.header.deleted ? item.folderId : undefined;
      const content = itemToCbor(liveItem({ ...item, title }, folderId), false);
      checkCap(content);
      const copy = randomId();
      const write = this.#seal(RecordType.item, copy, this.#clock.issue(), false, content);
      return { writes: [write], deletes: [], result: copy.slice() };
    });
  }

  /**
   * Edits or moves an item: its previous state becomes an Item Version (D6). Unchanged content
   * writes nothing and returns false (D165).
   */
  updateItem(id: Uint8Array, input: ItemInput): Promise<boolean> {
    return this.#run(() => {
      const held = this.#editable(id, false);
      const current = held.reading.item.folderId;
      if (input.folderId && !(current && sameBytes(current, input.folderId))) {
        this.#target(input.folderId);
      }
      const content = itemToCbor(liveItem(input, input.folderId), false);
      if (sameContent(content, held.content)) return { writes: [], deletes: [], result: false };
      return { ...this.#replace(held, content, false), result: true };
    });
  }

  /** Moves an item to the trash under a new `trashOperationId` (D14, D27). */
  trashItem(id: Uint8Array): Promise<void> {
    return this.#run(() => {
      const held = this.#editable(id, false);
      const trashed: Item = { ...held.reading.item, trashOperationId: randomId() };
      return { ...this.#replace(held, itemToCbor(trashed, true), true), result: undefined };
    });
  }

  /**
   * Restores an item from the trash, dropping `trashOperationId`. Under a parent folder in the
   * trash it moves to the vault root (D112).
   */
  restoreItem(id: Uint8Array): Promise<void> {
    return this.#run(() => {
      const held = this.#editable(id, true);
      const { item } = held.reading;
      const parent = item.folderId ? this.#state.folders.get(idKey(item.folderId)) : undefined;
      const folderId = parent?.header.deleted ? undefined : item.folderId;
      const content = itemToCbor(liveItem(item, folderId), false);
      return { ...this.#replace(held, content, false), result: undefined };
    });
  }

  /**
   * Writes a version's content as the item's new state (D111), without its `trashOperationId`
   * (D143). Blocked while the item is in the trash or either is read-only. Returns false when the
   * content equals the current one.
   */
  restoreVersion(itemId: Uint8Array, versionIdOf: Uint8Array): Promise<boolean> {
    return this.#run(() => {
      const held = this.#editable(itemId, false);
      const version = this.#state.versions.get(idKey(itemId))?.get(idKey(versionIdOf));
      if (!version) throw new RecordNotFoundError();
      if (version.reading.readOnly) throw new RecordBlockedError('newer-content');
      if (this.#clock.beyondBound(version.header.hlc)) {
        throw new RecordBlockedError('future-clock');
      }
      const content = itemToCbor(
        liveItem(version.reading.item, version.reading.item.folderId),
        false,
      );
      if (sameContent(content, held.content)) return { writes: [], deletes: [], result: false };
      return { ...this.#replace(held, content, false), result: true };
    });
  }

  /** The held item, if it may be written: not purged, not read-only, in the trash or not. */
  #editable(id: Uint8Array, inTrash: boolean): LiveItem {
    const held = this.#state.items.get(idKey(id));
    if (!held) throw new RecordNotFoundError();
    if (!held.content || !held.reading) throw new RecordBlockedError('purged');
    if (held.reading.readOnly) throw new RecordBlockedError('newer-content');
    if (this.#clock.beyondBound(held.header.hlc)) throw new RecordBlockedError('future-clock');
    if (held.header.deleted !== inTrash) {
      throw new RecordBlockedError(inTrash ? 'not-in-trash' : 'in-trash');
    }
    return held as LiveItem;
  }

  /** The writes replacing `held` with `content`: its Item Version, the cut, the new state. */
  #replace(held: LiveItem, content: CborMap, deleted: boolean): Omit<Plan<never>, 'result'> {
    checkCap(content);
    const hlc = this.#clock.issue(held.header.hlc);
    const history = this.#snapshot(held);
    const write = this.#seal(RecordType.item, held.header.recordId, hlc, deleted, content);
    return { writes: [...history.writes, write], deletes: history.deletes };
  }

  /** `held` as an Item Version with its own `hlc` (D6), and the versions the cut drops. */
  #snapshot(held: LiveItem): Omit<Plan<never>, 'result'> {
    const itemId = held.header.recordId;
    const vid = versionId(this.#subkeys.versionId, itemId, held.header.hlc);
    const existing = [...(this.#state.versions.get(idKey(itemId))?.values() ?? [])];
    if (existing.some((v) => sameBytes(v.header.recordId, vid))) {
      return { writes: [], deletes: [] };
    }
    const content: CborMap = new Map<CborValue, CborValue>([
      ['item', held.content],
      ['itemId', itemId],
    ]);
    const write = this.#seal(RecordType.itemVersion, vid, held.header.hlc, false, content);
    const ranked = [...existing.map((v) => v.header), write.header].sort(newestFirst);
    const dropped = ranked.slice(HISTORY_LIMIT);
    return {
      writes: dropped.includes(write.header) ? [] : [write],
      deletes: dropped
        .filter((h) => h !== write.header)
        .map((h) => ({ recordType: RecordType.itemVersion, recordId: h.recordId })),
    };
  }

  // --- folder operations -----------------------------------------------------------------------

  /** A new folder under `parentId`, a folder not in the trash, or at the vault root. */
  createFolder(name: string, parentId?: Uint8Array): Promise<Uint8Array> {
    return this.#run(() => {
      if (parentId) this.#target(parentId);
      const content = folderToCbor({ name, ...(parentId ? { parentId } : {}) }, false);
      const id = randomId();
      const write = this.#seal(RecordType.folder, id, this.#clock.issue(), false, content);
      return { writes: [write], deletes: [], result: id.slice() };
    });
  }

  /** Renames a folder, keeping its unknown keys (D59). An unchanged name writes nothing. */
  renameFolder(id: Uint8Array, name: string): Promise<boolean> {
    return this.#run(() => {
      const held = this.#editableFolder(id, false);
      if (held.folder.value.name === name) return { writes: [], deletes: [], result: false };
      const write = this.#folderWrite(held, { ...held.folder.value, name }, false);
      return { writes: [write], deletes: [], result: true };
    });
  }

  /**
   * Moves a folder under `parentId` or to the vault root. Refused into a folder in the trash or
   * into its own subtree as shown (D171). An unchanged parent writes nothing.
   */
  moveFolder(id: Uint8Array, parentId?: Uint8Array): Promise<boolean> {
    return this.#run(() => {
      const held = this.#editableFolder(id, false);
      const { parentId: current, ...rest } = held.folder.value;
      if (parentId && current ? sameBytes(parentId, current) : parentId === current) {
        return { writes: [], deletes: [], result: false };
      }
      if (parentId) {
        this.#target(parentId);
        if (isWithin(this.#parents(), idKey(parentId), idKey(id))) {
          throw new RecordBlockedError('cycle');
        }
      }
      const write = this.#folderWrite(held, { ...rest, ...(parentId ? { parentId } : {}) }, false);
      return { writes: [write], deletes: [], result: true };
    });
  }

  /**
   * Sends a folder, its subfolders and their items, as the tree shows them, to the trash under one
   * new `trashOperationId`, each with its own tombstone (D14). Records already in the trash keep
   * their own. Refused as a whole if any of them is read-only (D52, D74).
   */
  trashFolder(id: Uint8Array): Promise<void> {
    return this.#run(() => {
      const top = this.#editableFolder(id, false);
      const parents = this.#parents();
      const topKey = idKey(top.header.recordId);
      const folders = [...this.#state.folders.entries()].filter(
        ([key, f]) => !f.header.deleted && f.folder && isWithin(parents, key, topKey),
      );
      const inside = new Set(folders.map(([key]) => key));
      const items = [...this.#state.items.values()].filter((held) => {
        if (held.header.deleted || !held.content) return false;
        const folderId = held.content.get('folderId');
        return isId(folderId) && inside.has(idKey(folderId));
      });
      this.#refuseBlocked(
        folders.map(([, f]) => f),
        items,
      );
      const op = randomId();
      const writes: Write[] = [];
      const deletes: RecordKey[] = [];
      for (const [, f] of folders) {
        const live = f as LiveFolder;
        writes.push(this.#folderWrite(live, { ...live.folder.value, trashOperationId: op }, true));
      }
      for (const held of items) {
        const live = held as LiveItem;
        const trashed = itemToCbor({ ...live.reading.item, trashOperationId: op }, true);
        const plan = this.#replace(live, trashed, true);
        writes.push(...plan.writes);
        deletes.push(...plan.deletes);
      }
      return { writes, deletes, result: undefined };
    });
  }

  /**
   * Restores a folder from the trash with the records of its trash operation inside it: for the
   * folder that operation trashed first, exactly that operation (D14, D171). A restored record
   * whose parent stays in the trash moves to the vault root (D112). Refused as a whole if any of
   * them is read-only.
   */
  restoreFolder(id: Uint8Array): Promise<void> {
    return this.#run(() => {
      const top = this.#editableFolder(id, true);
      // A folder in the trash always holds its trashOperationId (record-content.md §6).
      const op = top.folder.value.trashOperationId ?? new Uint8Array(0);
      const ofOp = (tid: CborValue | undefined) => isId(tid) && sameBytes(tid, op);
      const inside = new Set([idKey(top.header.recordId)]);
      const folders: HeldFolder[] = [top];
      for (let grew = true; grew;) {
        grew = false;
        for (const [key, f] of this.#state.folders) {
          const value = f.folder?.value;
          if (inside.has(key) || !f.header.deleted || !value?.parentId) continue;
          if (ofOp(value.trashOperationId) && inside.has(idKey(value.parentId))) {
            inside.add(key);
            folders.push(f);
            grew = true;
          }
        }
      }
      const items = [...this.#state.items.values()].filter((held) => {
        if (!held.header.deleted || !held.content) return false;
        const folderId = held.content.get('folderId');
        return (
          ofOp(held.content.get('trashOperationId')) &&
          isId(folderId) &&
          inside.has(idKey(folderId))
        );
      });
      this.#refuseBlocked(folders, items);
      // A parent outside what this restores, still in the trash, sends the record to the root.
      const keep = (parentId: Uint8Array | undefined) => {
        if (!parentId || inside.has(idKey(parentId))) return parentId;
        return this.#state.folders.get(idKey(parentId))?.header.deleted ? undefined : parentId;
      };
      const writes: Write[] = [];
      const deletes: RecordKey[] = [];
      for (const f of folders) {
        const live = f as LiveFolder;
        const { name } = live.folder.value;
        const parentId = keep(live.folder.value.parentId);
        writes.push(this.#folderWrite(live, { name, ...(parentId ? { parentId } : {}) }, false));
      }
      for (const held of items) {
        const live = held as LiveItem;
        const { item } = live.reading;
        const content = itemToCbor(liveItem(item, keep(item.folderId)), false);
        const plan = this.#replace(live, content, false);
        writes.push(...plan.writes);
        deletes.push(...plan.deletes);
      }
      return { writes, deletes, result: undefined };
    });
  }

  /** The displayed parent of every folder not in the trash (D14). */
  #parents(): Map<string, string | null> {
    const live: { id: Uint8Array; parentId?: Uint8Array; hlc: Hlc }[] = [];
    for (const f of this.#state.folders.values()) {
      if (f.header.deleted || !f.folder) continue;
      const { parentId } = f.folder.value;
      live.push({ id: f.header.recordId, ...(parentId ? { parentId } : {}), hlc: f.header.hlc });
    }
    return displayedParents(live);
  }

  /** A folder something may be placed in: held, and not in the trash. */
  #target(folderId: Uint8Array): void {
    const held = this.#state.folders.get(idKey(folderId));
    if (!held?.folder) throw new RecordNotFoundError();
    if (held.header.deleted) throw new RecordBlockedError('in-trash');
  }

  /** The held folder, if it may be written: not purged, within the bound, in the trash or not. */
  #editableFolder(id: Uint8Array, inTrash: boolean): LiveFolder {
    const held = this.#state.folders.get(idKey(id));
    if (!held) throw new RecordNotFoundError();
    if (!held.folder) throw new RecordBlockedError('purged');
    if (this.#clock.beyondBound(held.header.hlc)) throw new RecordBlockedError('future-clock');
    if (held.header.deleted !== inTrash) {
      throw new RecordBlockedError(inTrash ? 'not-in-trash' : 'in-trash');
    }
    return held as LiveFolder;
  }

  /** Throws `SubtreeBlockedError` listing every read-only record of a folder action. */
  #refuseBlocked(folders: readonly HeldFolder[], items: readonly HeldItem[]): void {
    const blocked: BlockedRecord[] = [];
    const add = (recordType: number, h: RecordHeader, reason: BlockedRecord['reason']) => {
      blocked.push({ recordType, recordId: h.recordId.slice(), reason });
    };
    for (const f of folders) {
      if (this.#clock.beyondBound(f.header.hlc)) add(RecordType.folder, f.header, 'future-clock');
    }
    for (const held of items) {
      if (held.reading?.readOnly) add(RecordType.item, held.header, 'newer-content');
      else if (this.#clock.beyondBound(held.header.hlc)) {
        add(RecordType.item, held.header, 'future-clock');
      }
    }
    if (blocked.length > 0) throw new SubtreeBlockedError(blocked);
  }

  /** A Folder write over `held`, keeping its unknown keys (D59), with a new HLC above it. */
  #folderWrite(held: LiveFolder, folder: Folder, deleted: boolean): Write {
    const content = folderToCbor(folder, deleted, held.folder.content);
    const hlc = this.#clock.issue(held.header.hlc);
    return this.#seal(RecordType.folder, held.header.recordId, hlc, deleted, content);
  }

  // --- creation --------------------------------------------------------------------------------

  #founding(
    displayName: string,
    recovery: {
      readonly masterKey: SymmetricKey;
      readonly envelopeKey: SymmetricKey;
      readonly metadata: CborMap;
    },
  ): Plan<undefined> {
    const vaultKey = this.#vaultKey(FIRST_EPOCH);
    const vaultKeyHeader = header(
      RecordType.vaultKey,
      vaultKeyRecordId(FIRST_EPOCH),
      this.#clock.issue(),
      false,
    );
    const vaultKeyWrite: Write = {
      header: vaultKeyHeader,
      content: null,
      envelope: sealVaultKeyRecord(
        vaultKeyHeader,
        this.#cleartext.vaultId,
        this.#subkeys.vaultKeyWrap,
        vaultKey,
      ),
    };
    const envelopeHeader = header(
      RecordType.recoveryEnvelope,
      recoveryEnvelopeRecordId(this.#cleartext.vaultId),
      this.#clock.issue(),
      false,
    );
    const envelopeWrite: Write = {
      header: envelopeHeader,
      content: recovery.metadata,
      envelope: sealRecoveryEnvelope(
        envelopeHeader,
        this.#cleartext.vaultId,
        vaultKey,
        recovery.envelopeKey,
        recovery.masterKey,
        recovery.metadata,
      ),
    };
    const device = deviceToCbor({
      publicKey: this.#identity.publicKey,
      displayName,
      retired: false,
      registeredAt: Math.floor(this.#now()),
    });
    const deviceWrite = this.#seal(
      RecordType.device,
      this.#identity.deviceId,
      this.#clock.issue(),
      false,
      device,
    );
    return {
      writes: [vaultKeyWrite, envelopeWrite, deviceWrite],
      deletes: [],
      result: undefined,
    };
  }

  // --- purge and the history cut ---------------------------------------------------------------

  #startMaintenance(): void {
    this.#timer = setInterval(() => {
      // A failed pass leaves everything as it was; the next one retries.
      this.#run(() => this.#maintenance()).catch(() => undefined);
    }, MAINTENANCE_INTERVAL_MS);
  }

  /**
   * The automatic purge (D7, D27, D94): every tombstone whose purge date has passed is re-sealed
   * with empty content under its unchanged header, and its item's history is dropped. Also drops
   * versions beyond the history cut. Issues no HLC, so it runs while the vault is read-only.
   */
  #maintenance(): Plan<number> {
    const now = this.#now();
    const writes: Write[] = [];
    const purgedItems = new Set<string>();
    const due = (h: RecordHeader) => h.deleted && now >= h.hlc.physicalMs + PURGE_DELAY_MS;
    for (const [key, held] of this.#state.items) {
      if (!held.content) purgedItems.add(key);
      else if (due(held.header)) {
        writes.push(this.#purged(held.header));
        purgedItems.add(key);
      }
    }
    for (const held of this.#state.folders.values()) {
      if (held.folder && due(held.header)) writes.push(this.#purged(held.header));
    }
    const deletes: RecordKey[] = [];
    for (const [itemKey, versions] of this.#state.versions) {
      const ranked = [...versions.values()].map((v) => v.header).sort(newestFirst);
      const dropped = purgedItems.has(itemKey) ? ranked : ranked.slice(HISTORY_LIMIT);
      for (const h of dropped) {
        deletes.push({ recordType: RecordType.itemVersion, recordId: h.recordId });
      }
    }
    return { writes, deletes, result: writes.length };
  }

  #purged(h: RecordHeader): Write {
    return {
      header: h,
      content: null,
      envelope: sealPurgedTombstone(h, this.#cleartext.vaultId, this.#vaultKey(h.keyEpoch)),
    };
  }

  // --- writing ---------------------------------------------------------------------------------

  #vaultKey(epoch: number): SymmetricKey {
    const key = this.#state.vaultKeys.get(epoch);
    if (!key) throw new VaultLockedError();
    return key;
  }

  /** The epoch new records are sealed under: the greatest held (only 1 in v1, D11). */
  #epoch(): number {
    return Math.max(...this.#state.vaultKeys.keys());
  }

  #seal(
    type: RecordType,
    recordId: Uint8Array,
    hlc: Hlc,
    deleted: boolean,
    content: CborMap,
  ): Write {
    const h = header(type, recordId, hlc, deleted, this.#epoch());
    const envelope = sealRecord(
      h,
      { vaultId: this.#cleartext.vaultId, versionIdKey: this.#subkeys.versionId },
      this.#vaultKey(h.keyEpoch),
      content,
    );
    return { header: h, content, envelope };
  }

  /** The whole Local Config with the encrypted part re-sealed around the current HLC state. */
  #localConfig(
    cleartext: Cleartext = this.#cleartext,
    preferences: Preferences = this.#localState.preferences,
    lastBackupAt: number | bigint | undefined = this.#localState.lastBackupAt,
    seen: Seen = {},
  ): { bytes: Uint8Array; localState: LocalConfigState } {
    const localState: LocalConfigState = {
      ...this.#localState,
      ...seen,
      preferences,
      hlc: this.#clock.state,
      ...(lastBackupAt !== undefined ? { lastBackupAt } : {}),
    };
    const { vaultId, localConfigId } = cleartext;
    const encrypted = sealLocalConfigPart(
      this.#subkeys.localConfig,
      localAad(LocalPurpose.localConfig, vaultId, localConfigId),
      localConfigStateToCbor(localState),
      this.#identity,
    );
    const bytes = encodeCbor(localConfigToCbor({ ...cleartext, encrypted }));
    return { bytes, localState };
  }

  /**
   * Runs one operation after the previous ones: builds its writes from the current state, commits
   * them with the Local Config in one transaction (D62), and applies them to memory only once the
   * commit succeeds. An operation that writes nothing commits nothing.
   */
  #run<T>(build: () => Plan<T> | Promise<Plan<T>>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#unlocked();
      let plan: Plan<T>;
      try {
        plan = await build();
      } catch (error) {
        // A lock during an asynchronous build wiped the keys it was using (D105).
        if (this.#locked) throw new VaultLockedError();
        throw error;
      }
      this.#unlocked();
      const local =
        plan.cleartext !== undefined ||
        plan.preferences !== undefined ||
        plan.lastBackupAt !== undefined ||
        plan.seen !== undefined;
      if (plan.writes.length === 0 && plan.deletes.length === 0 && !local) return plan.result;
      const localConfig = this.#localConfig(
        plan.cleartext,
        plan.preferences,
        plan.lastBackupAt,
        plan.seen,
      );
      await this.#store.commit({
        put: plan.writes.map((w) => ({
          recordType: w.header.recordType as RecordType,
          recordId: w.header.recordId,
          envelope: w.envelope,
        })),
        delete: plan.deletes,
        localConfig: localConfig.bytes,
      });
      this.#unlocked();
      this.#localState = localConfig.localState;
      if (plan.cleartext) this.#cleartext = plan.cleartext;
      for (const d of plan.deletes) this.#forget(d);
      for (const w of plan.writes) this.#apply(w);
      return plan.result;
    });
    this.#queue = task.catch(() => undefined);
    return task;
  }

  #apply(w: Write): void {
    const { header: h, content } = w;
    const key = idKey(h.recordId);
    // A record kept aside as corrupt is repaired by a merged copy (D182).
    const corrupt = this.#state.corrupt.findIndex(
      (k) => k.recordType === h.recordType && sameBytes(k.recordId, h.recordId),
    );
    if (corrupt >= 0) this.#state.corrupt.splice(corrupt, 1);
    switch (h.recordType) {
      case RecordType.item:
        this.#state.items.set(key, {
          header: h,
          content,
          reading: content ? readItem(content, h.deleted) : null,
        });
        break;
      case RecordType.itemVersion:
        addVersion(this.#state, versionOf(h, content));
        break;
      case RecordType.folder:
        this.#state.folders.set(key, {
          header: h,
          folder: content ? readFolder(content, h.deleted) : null,
        });
        break;
      case RecordType.device:
        this.#state.devices.set(key, { header: h, device: readDevice(content) });
        break;
      case RecordType.recoveryEnvelope:
        if (content) this.#state.recovery = { header: h, content, envelope: w.envelope };
        break;
      case RecordType.vaultKey:
        // A created vault's Vault Key is already held: it was generated before its record.
        this.#state.vaultKeyHeaders.set(h.keyEpoch, h);
        if (w.vaultKey) this.#state.vaultKeys.set(h.keyEpoch, w.vaultKey);
        break;
      default:
        break;
    }
  }

  #forget(k: RecordKey): void {
    // Only Item Versions are deleted: pruned and purged versions leave no tombstone (D6).
    for (const [itemKey, versions] of this.#state.versions) {
      if (versions.delete(idKey(k.recordId)) && versions.size === 0) {
        this.#state.versions.delete(itemKey);
      }
    }
  }
}

function header(
  recordType: RecordType,
  recordId: Uint8Array,
  hlc: Hlc,
  deleted: boolean,
  keyEpoch: number = FIRST_EPOCH,
): RecordHeader {
  return {
    recordFormatVersion: RECORD_FORMAT_VERSION,
    recordType,
    recordId: recordId.slice(),
    keyEpoch,
    hlc,
    deleted,
  };
}

/** The identity of a verified header, whose `recordType` is a known one. */
function headerKey(h: RecordHeader): RecordKey {
  return { recordType: h.recordType as RecordType, recordId: h.recordId.slice() };
}

function copyKey(k: RecordKey): RecordKey {
  return { recordType: k.recordType, recordId: k.recordId.slice() };
}

/** The item cap (D139): refused before any HLC is issued. */
function checkCap(content: CborMap): void {
  if (itemContentLength(content) > ITEM_CAP) throw new ContentInvalidError('item cap');
}

function deviceView(d: HeldDevice): DeviceView {
  return {
    deviceId: d.header.recordId.slice(),
    hlc: copyHlc(d.header.hlc),
    device: d.device.value,
    unknownKeys: d.device.unknownKeys,
  };
}

function deviceIdOf(d: HeldDevice): Uint8Array {
  return d.header.recordId;
}

function phraseIdOf(held: HeldRecovery): Uint8Array {
  // Verification checked the metadata's three fields (crypto-spec.md §9.5 step 8).
  return held.content.get('phraseId') as Uint8Array;
}

/** Distinct IDs in ascending byte order, as Local Config stores them (record-content.md §9). */
function sortedIds(ids: readonly Uint8Array[]): Uint8Array[] {
  const unique = new Map(ids.map((id) => [idKey(id), id.slice()]));
  return [...unique.values()].sort(compareBytes);
}

function sameIds(
  a: readonly Uint8Array[] | undefined,
  b: readonly Uint8Array[] | undefined,
): boolean {
  if (!a || !b) return a === b;
  return (
    a.length === b.length &&
    a.every((id, i) => {
      const other = b[i];
      return other !== undefined && sameBytes(id, other);
    })
  );
}

/** A record's identity as a map key (D158). */
function recordKeyOf(k: { readonly recordType: number; readonly recordId: Uint8Array }): string {
  return `${String(k.recordType)}:${idKey(k.recordId)}`;
}

/** A value the merge put there itself: every record and key it looks up comes from the backup. */
function present<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('merge: missing record');
  return value;
}
