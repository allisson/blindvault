// The unlocked vault session (D163): key handles, the HLC, the decrypted state loaded at unlock
// and every domain operation, written through a `RecordStore`. Locking wipes it (CRYPTO-INV-010).

import {
  type CborMap,
  type CborValue,
  CryptoError,
  DecryptionError,
  type DeviceIdentity,
  type Hlc,
  ITEM_CAP,
  type KdfParams,
  Keyring,
  LocalPurpose,
  type MasterSubkeys,
  RECORD_FORMAT_VERSION,
  type RecordEnvelope,
  type RecordHeader,
  RecordType,
  type SymmetricKey,
  checkKdfParams,
  deriveMasterSubkeys,
  encodeCbor,
  generateDeviceIdentity,
  generateKey,
  itemContentLength,
  localAad,
  openLocalConfigPart,
  randomId,
  sealLocalConfigPart,
  sealPurgedTombstone,
  sealRecord,
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
  RecordBlockedError,
  RecordNotFoundError,
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
import { HlcClock, compareHlc } from './hlc';
import { idKey, sameBytes } from './ids';
import { type Item, type ItemReading, type ReadOnlyRule, itemToCbor, readItem } from './item';
import {
  DEFAULT_PREFERENCES,
  type LocalConfigCleartext,
  type LocalConfigState,
  type Preferences,
  localConfigStateToCbor,
  localConfigToCbor,
  readLocalConfigState,
} from './local-config';
import { type RecordKey, type RecordStore, type StoredRecord } from './store';
import { compareBytes, isId } from './text';
import { type TreeNode, buildTree, displayedParents, isWithin } from './tree';

/** Item Versions kept per item: the 20 greatest `(hlc, versionId)` (D6). */
export const HISTORY_LIMIT = 20;
/** A tombstone's content is purged 30 days after the physical time of its HLC (D7, D27). */
export const PURGE_DELAY_MS = 30 * 24 * 60 * 60 * 1000;
/** While unlocked, the automatic purge and the history cut run this often (D94). */
export const MAINTENANCE_INTERVAL_MS = 60 * 60 * 1000;

const FIRST_EPOCH = 1;

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

export interface CreateOptions {
  readonly store: RecordStore;
  /** A new keyring holding only `kek`; the session owns it from now on. */
  readonly keyring: Keyring;
  /** The Device KEK of the new local password; released once the Master Key is wrapped. */
  readonly kek: SymmetricKey;
  readonly salt: Uint8Array;
  readonly kdfParams: KdfParams;
  /** This device's Device record name (D30). */
  readonly displayName: string;
  readonly now?: () => number;
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

interface Write {
  readonly header: RecordHeader;
  /** The content written; `null` for a purged tombstone and for a Vault Key record. */
  readonly content: CborMap | null;
  readonly envelope: RecordEnvelope;
}

interface Plan<T> {
  readonly writes: readonly Write[];
  readonly deletes: readonly RecordKey[];
  readonly result: T;
}

/** The records held, decrypted at unlock. */
interface State {
  readonly vaultKeys: Map<number, SymmetricKey>;
  readonly items: Map<string, HeldItem>;
  /** By `itemId`, then by `versionId`. */
  readonly versions: Map<string, Map<string, HeldVersion>>;
  readonly folders: Map<string, HeldFolder>;
  readonly devices: Map<string, HeldDevice>;
  readonly corrupt: RecordKey[];
}

function emptyState(): State {
  return {
    vaultKeys: new Map(),
    items: new Map(),
    versions: new Map(),
    folders: new Map(),
    devices: new Map(),
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
  return { header, itemId, reading: versionReading(content) };
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
 * is kept aside as corrupt: never shown and never written.
 */
function load(
  keyring: Keyring,
  stored: readonly StoredRecord[],
  vaultId: Uint8Array,
  subkeys: MasterSubkeys,
): { state: State; held: Hlc[] } {
  const state = emptyState();
  const held: Hlc[] = [];
  const keys = {
    vaultId,
    vaultKey: (epoch: number) => state.vaultKeys.get(epoch),
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
        default:
          // The Recovery Envelope arrives in Phase 2; it is kept in storage as received.
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
  readonly #cleartext: Omit<LocalConfigCleartext, 'encrypted'>;
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
   * Creates a vault (Phase 1: no Recovery Envelope). One commit writes the Vault Key record, this
   * device's Device record (D30) and the Local Config.
   */
  static async create(options: CreateOptions): Promise<VaultSession> {
    const { store, keyring, kek, salt, kdfParams, displayName } = options;
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
        localState: { preferences: DEFAULT_PREFERENCES, hlc: clock.state },
        clock,
        state,
        now,
      });
      await session.#run(() => session.#founding(displayName));
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
    return [...this.#state.devices.values()].map((d) => ({
      deviceId: d.header.recordId.slice(),
      hlc: copyHlc(d.header.hlc),
      device: d.device.value,
      unknownKeys: d.device.unknownKeys,
    }));
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

  #founding(displayName: string): Plan<undefined> {
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
    return { writes: [vaultKeyWrite, deviceWrite], deletes: [], result: undefined };
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
  #localConfig(): { bytes: Uint8Array; localState: LocalConfigState } {
    const localState = { ...this.#localState, hlc: this.#clock.state };
    const { vaultId, localConfigId } = this.#cleartext;
    const encrypted = sealLocalConfigPart(
      this.#subkeys.localConfig,
      localAad(LocalPurpose.localConfig, vaultId, localConfigId),
      localConfigStateToCbor(localState),
      this.#identity,
    );
    const bytes = encodeCbor(localConfigToCbor({ ...this.#cleartext, encrypted }));
    return { bytes, localState };
  }

  /**
   * Runs one operation after the previous ones: builds its writes from the current state, commits
   * them with the Local Config in one transaction (D62), and applies them to memory only once the
   * commit succeeds. An operation that writes nothing commits nothing.
   */
  #run<T>(build: () => Plan<T>): Promise<T> {
    const task = this.#queue.then(async () => {
      this.#unlocked();
      const plan = build();
      if (plan.writes.length === 0 && plan.deletes.length === 0) return plan.result;
      const localConfig = this.#localConfig();
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
      default:
        // The Vault Key is already held: it was generated before its record was written.
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

/** The item cap (D139): refused before any HLC is issued. */
function checkCap(content: CborMap): void {
  if (itemContentLength(content) > ITEM_CAP) throw new ContentInvalidError('item cap');
}
