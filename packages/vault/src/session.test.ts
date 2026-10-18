import {
  type CborMap,
  type CborValue,
  type Hlc,
  ITEM_CAP,
  type KdfPort,
  type KdfRequest,
  KdfParamsRejectedError,
  KeyWipedError,
  PhraseRejectedError,
  Keyring,
  LocalPurpose,
  MEMLIMIT,
  type MasterSubkeys,
  RECORD_FORMAT_VERSION,
  type RecordEnvelope,
  type RecordHeader,
  RecordType,
  type SymmetricKey,
  decodeEnvelope,
  decodeCbor,
  deriveMasterSubkeys,
  derivePrfKek,
  deriveRecoveryKeys,
  deviceId,
  encodeCbor,
  exportTransferKey,
  generateDeviceIdentity,
  generateRecoveryPhrase,
  importTransferKey,
  initCrypto,
  itemContentLength,
  localAad,
  normalizePassword,
  openLocalConfigPart,
  openRecoveryEnvelope,
  generateKey,
  parseRecoveryPhrase,
  randomId,
  recoveryEnvelopeRecordId,
  sealLocalConfigPart,
  sealRecord,
  sealRecoveryEnvelope,
  sameKey,
  sealVaultKeyRecord,
  unwrapKey,
  vaultKeyRecordId,
  verifyRecord,
  versionId,
  wrapKey,
} from '@blindvault/crypto';
import {
  EXPORT_KDF,
  openBackup,
  openPasswordKeyslot,
  openRecoveryKeyslot,
  parseBackup,
  restoreWithPhrase,
} from '@blindvault/backup';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import vectors from '../test-vectors/content-v1.json' with { type: 'json' };

import {
  ContentInvalidError,
  ExportRejectedError,
  HlcReadOnlyError,
  JoinRejectedError,
  MergeRejectedError,
  PairingRefusedError,
  PasswordResetRejectedError,
  RecordBlockedError,
  RecordNotFoundError,
  RestoreRejectedError,
  RetirementRefusedError,
  SubtreeBlockedError,
  SyncRefusedError,
  SyncRejectedError,
  UnlockRejectedError,
  VaultLockedError,
} from './errors';
import { deviceToCbor } from './folder';
import { FUTURE_CLOCK_BOUND_MS, compareHlc } from './hlc';
import { idKey } from './ids';
import { TITLE_MAX, itemToCbor } from './item';
import {
  DEFAULT_PREFERENCES,
  localConfigStateToCbor,
  localConfigToCbor,
  parseLocalConfig,
  readLocalConfigState,
} from './local-config';
import { MemoryStore } from './memory-store';
import {
  HISTORY_LIMIT,
  type ItemInput,
  MAINTENANCE_INTERVAL_MS,
  PURGE_DELAY_MS,
  type UnlockMethod,
  VaultSession,
} from './session';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const DAY = 24 * 60 * 60 * 1000;
const SALT = new Uint8Array(16).fill(7);
const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };

/** A reproducible KEK: the PRF KEK of a fixed output, standing in for Argon2id in these tests. */
function kek(keyring: Keyring, seed = 1): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

class Clock {
  constructor(public t: number = T0) {}
  readonly now = () => this.t;
}

const open: VaultSession[] = [];

afterEach(() => {
  for (const s of open.splice(0)) s.lock();
  vi.useRealTimers();
});

async function create(clock = new Clock(), store = new MemoryStore()) {
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const session = await VaultSession.create({
    store,
    keyring,
    kek: kek(keyring),
    recoveryEntropy: phrase.entropy,
    salt: SALT,
    kdfParams: PARAMS,
    displayName: 'Chrome on macOS',
    now: clock.now,
  });
  open.push(session);
  // The session releases the entropy: the words are the only way back to it, as for a user.
  return { session, store, clock, keyring, words: phrase.words, entropy: phrase.entropy };
}

/**
 * What a stored phrase would contain: the whole phrase and every pair of neighbouring words, with
 * or without a space. Single words are not enough: BIP39 words such as "salt" or "local" also
 * appear in Local Config's own keys.
 */
function phraseTraces(words: string): string[] {
  const list = words.split(' ');
  const out = [words];
  for (let i = 0; i + 1 < list.length; i++) {
    out.push(`${list[i] ?? ''} ${list[i + 1] ?? ''}`, `${list[i] ?? ''}${list[i + 1] ?? ''}`);
  }
  return out;
}

/** The recovery keys of a typed phrase, in a keyring of their own. */
function typed(words: string) {
  const keyring = new Keyring();
  return { keyring, ...deriveRecoveryKeys(keyring, parseRecoveryPhrase(keyring, words)) };
}

async function unlock(
  store: MemoryStore,
  clock = new Clock(),
  seed = 1,
  method: UnlockMethod = 'password',
) {
  const keyring = new Keyring();
  const session = await VaultSession.unlock({
    store,
    localConfig: parseLocalConfig(store.localConfig),
    keyring,
    kek: kek(keyring, seed),
    method,
    now: clock.now,
  });
  open.push(session);
  return session;
}

function login(title = 'Example', password = 'correct horse battery staple'): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [
      { type: 'text', role: 'username', value: 'alice' },
      { type: 'secret', role: 'password', value: password },
    ],
    tags: [],
  };
}

interface Keys {
  readonly vaultId: Uint8Array;
  readonly masterKey: SymmetricKey;
  readonly subkeys: MasterSubkeys;
  readonly vaultKey: SymmetricKey;
}

/** The vault's keys, opened from the store the way another device of the vault holds them. */
function keysOf(store: MemoryStore, seed = 1): Keys {
  const keyring = new Keyring();
  const config = parseLocalConfig(store.localConfig);
  const masterKey = unwrapKey(
    keyring,
    kek(keyring, seed),
    localAad(LocalPurpose.mkWrapDeviceKek, config.vaultId, config.localConfigId),
    config.kek.mkWrap,
  );
  const subkeys = deriveMasterSubkeys(keyring, masterKey);
  const [record] = store.ofType(RecordType.vaultKey);
  const { vaultKey } = verifyRecord(keyring, (record as { envelope: Uint8Array }).envelope, {
    vaultId: config.vaultId,
    vaultKey: () => undefined,
    vaultKeyWrapKey: subkeys.vaultKeyWrap,
    versionIdKey: subkeys.versionId,
  });
  return { vaultId: config.vaultId, masterKey, subkeys, vaultKey: must(vaultKey) };
}

function hlcAt(physicalMs: number, counter = 0): Hlc {
  return { physicalMs, counter, deviceId: new Uint8Array(16).fill(0x99) };
}

/** Writes a record straight into the store, as a sync from another device would. */
function plant(
  store: MemoryStore,
  keys: Keys,
  recordType: RecordType,
  recordId: Uint8Array,
  hlc: Hlc,
  deleted: boolean,
  content: CborMap,
): RecordHeader {
  const header: RecordHeader = {
    recordFormatVersion: RECORD_FORMAT_VERSION,
    recordType,
    recordId,
    keyEpoch: 1,
    hlc,
    deleted,
  };
  store.put({
    recordType,
    recordId,
    envelope: sealRecord(
      header,
      { vaultId: keys.vaultId, versionIdKey: keys.subkeys.versionId },
      keys.vaultKey,
      content,
    ),
  });
  return header;
}

function utf8(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

/** IDs sorted as Local Config stores them. */
function sortedHex(ids: readonly Uint8Array[]): Uint8Array[] {
  return [...ids].sort((x, y) =>
    Buffer.from(x).toString('hex').localeCompare(Buffer.from(y).toString('hex')),
  );
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.length <= haystack.length; i++) {
    for (let j = 0; j < needle.length; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

describe('vault creation and unlock (D163)', () => {
  it('creates a vault in one commit: Vault Key, Recovery Envelope, Device record and Local Config', async () => {
    const { session, store } = await create();
    expect(store.commits).toHaveLength(1);
    const [commit] = store.commits;
    expect(commit?.put.map((p) => p.recordType)).toEqual([
      RecordType.vaultKey,
      RecordType.recoveryEnvelope,
      RecordType.device,
    ]);
    expect(commit?.delete).toEqual([]);
    const config = parseLocalConfig(store.localConfig);
    expect(config.vaultId).toEqual(session.vaultId);
    expect(config.kek).toMatchObject({ salt: SALT, ...PARAMS });

    const again = await unlock(store);
    expect(again.deviceId).toEqual(session.deviceId);
    expect(again.devices()).toEqual([
      {
        deviceId: session.deviceId,
        hlc: expect.anything() as Hlc,
        device: {
          publicKey: expect.any(Uint8Array) as Uint8Array,
          displayName: 'Chrome on macOS',
          retired: false,
          registeredAt: T0,
        },
        unknownKeys: [],
      },
    ]);
    expect(again.preferences).toEqual({
      autoLockMinutes: 5,
      hiddenLockSeconds: 60,
      clipboardClearSeconds: 30,
    });
    expect(again.corrupt()).toEqual([]);
  });

  it('persists no plaintext content (CRYPTO-INV-001)', async () => {
    const { session, store } = await create();
    const id = await session.createItem({
      ...login('Bank of Somewhere', 'hunter2-very-secret'),
      tags: ['finance'],
      notes: 'PIN is in the drawer',
    });
    await session.updateItem(id, login('Bank of Somewhere', 'rotated-very-secret'));
    const persisted = [store.localConfig, ...[...store.held.values()].map((r) => r.envelope)];
    for (const text of [
      'Bank of Somewhere',
      'hunter2-very-secret',
      'rotated-very-secret',
      'finance',
      'PIN is in the drawer',
      'alice',
      'Chrome on macOS',
    ]) {
      expect(persisted.some((bytes) => contains(bytes, utf8(text)))).toBe(false);
    }
  });

  it('rejects a wrong KEK without saying why, and wipes the keyring', async () => {
    const { store } = await create();
    const keyring = new Keyring();
    await expect(
      VaultSession.unlock({
        store,
        localConfig: parseLocalConfig(store.localConfig),
        keyring,
        kek: kek(keyring, 2),
        method: 'password',
      }),
    ).rejects.toThrow(UnlockRejectedError);
    expect(keyring.wiped).toBe(true);
  });

  it('fails a wrong KEK exactly as a tampered wrap, reading no record and writing nothing (Gate A)', async () => {
    const { session, store } = await create();
    await session.createItem(login());
    session.lock();
    const bytes = store.localConfig;
    const commits = store.commits.length;
    const config = parseLocalConfig(bytes);
    const flip = (part: 'n' | 'c', at: number) => {
      const sealed = config.kek.mkWrap;
      const changed = sealed[part].slice();
      const i = at < 0 ? changed.length + at : at;
      changed[i] = must(changed[i]) ^ 1;
      return { ...config, kek: { ...config.kek, mkWrap: { ...sealed, [part]: changed } } };
    };
    const attempts = [
      { localConfig: config, seed: 2 },
      { localConfig: config, seed: 200 },
      { localConfig: flip('c', 0), seed: 1 },
      { localConfig: flip('c', -1), seed: 1 },
      { localConfig: flip('n', 0), seed: 1 },
    ];
    const reads = vi.spyOn(store, 'records');
    const errors: unknown[] = [];
    for (const { localConfig, seed } of attempts) {
      const keyring = new Keyring();
      errors.push(
        await VaultSession.unlock({
          store,
          localConfig,
          keyring,
          kek: kek(keyring, seed),
          method: 'password',
        }).catch((error: unknown) => error),
      );
      expect(keyring.wiped).toBe(true);
    }
    // One error, whatever failed: no class, message or cause tells a near miss from tampering.
    for (const error of errors) {
      expect(error).toBeInstanceOf(UnlockRejectedError);
      expect(error).toEqual(new UnlockRejectedError());
      expect((error as Error).cause).toBeUndefined();
    }
    // The Master Key wrap is the first thing opened: no record is read before it opens.
    expect(reads).not.toHaveBeenCalled();
    // No attempt counter or other trace is stored.
    expect(store.commits).toHaveLength(commits);
    expect(store.localConfig).toBe(bytes);
    expect((await unlock(store)).items()).toHaveLength(1);
  });

  it('rejects a passkey unlock while no PRF wrap is set up', async () => {
    const { store } = await create();
    const keyring = new Keyring();
    await expect(
      VaultSession.unlock({
        store,
        localConfig: parseLocalConfig(store.localConfig),
        keyring,
        kek: kek(keyring),
        method: 'passkey',
      }),
    ).rejects.toThrow(UnlockRejectedError);
    expect(keyring.wiped).toBe(true);
  });

  it('refuses the encrypted part of another vault’s Local Config as corrupt', async () => {
    const { store } = await create();
    const { store: other } = await create();
    const config = parseLocalConfig(store.localConfig);
    const keyring = new Keyring();
    await expect(
      VaultSession.unlock({
        store,
        localConfig: { ...config, encrypted: parseLocalConfig(other.localConfig).encrypted },
        keyring,
        kek: kek(keyring),
        method: 'password',
      }),
    ).rejects.toThrow(ContentInvalidError);
    expect(keyring.wiped).toBe(true);
  });

  it('unlocks with a passkey and keeps the PRF wrap and replaced vaultId on every write', async () => {
    const { store } = await create();
    const keys = keysOf(store);
    const config = parseLocalConfig(store.localConfig);
    const keyring = new Keyring();
    const prf = {
      credentialId: new Uint8Array([1, 2, 3]),
      prfInput: new Uint8Array(32).fill(5),
      mkWrap: wrapKey(
        kek(keyring, 3),
        localAad(LocalPurpose.mkWrapPrfKek, config.vaultId, config.localConfigId),
        keys.masterKey,
      ),
    };
    const replacesVaultId = randomId();
    store.localConfig = encodeCbor(localConfigToCbor({ ...config, prf, replacesVaultId }));
    const session = await unlock(store, new Clock(), 3, 'passkey');
    await session.createItem(login());
    expect(parseLocalConfig(store.localConfig)).toMatchObject({ prf, replacesVaultId });
    await expect(unlock(store, new Clock(), 1, 'passkey')).rejects.toThrow(UnlockRejectedError);
    await expect(unlock(store, new Clock(), 3, 'password')).rejects.toThrow(UnlockRejectedError);
  });

  it('refuses an encrypted part that opens but holds invalid content', async () => {
    const { store } = await create();
    const keys = keysOf(store);
    const config = parseLocalConfig(store.localConfig);
    const encrypted = sealLocalConfigPart(
      keys.subkeys.localConfig,
      localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
      new Map<CborValue, CborValue>([
        ['preferences', new Map()],
        ['hlc', [T0, 0, new Uint8Array(16)]],
      ]),
      generateDeviceIdentity(new Keyring()),
    );
    store.localConfig = encodeCbor(localConfigToCbor({ ...config, encrypted }));
    await expect(unlock(store)).rejects.toThrow(new ContentInvalidError('preferences'));
  });

  it('passes through a KEK that is no longer usable, wiping the keyring', async () => {
    const { store } = await create();
    const stale = new Keyring();
    const staleKek = kek(stale);
    stale.wipeAll();
    const keyring = new Keyring();
    await expect(
      VaultSession.unlock({
        store,
        localConfig: parseLocalConfig(store.localConfig),
        keyring,
        kek: staleKek,
        method: 'password',
      }),
    ).rejects.toThrow(KeyWipedError);
    expect(keyring.wiped).toBe(true);
  });

  it('refuses parameters outside the accepted range and an invalid device name', async () => {
    for (const [kdfParams, displayName, error] of [
      [{ opslimit: 1, memlimit: MEMLIMIT }, 'Phone', KdfParamsRejectedError],
      [PARAMS, ' Phone', ContentInvalidError],
    ] as const) {
      const keyring = new Keyring();
      const store = new MemoryStore();
      await expect(
        VaultSession.create({
          store,
          keyring,
          kek: kek(keyring),
          recoveryEntropy: generateRecoveryPhrase(keyring).entropy,
          salt: SALT,
          kdfParams,
          displayName,
        }),
      ).rejects.toThrow(error);
      expect(keyring.wiped).toBe(true);
      expect(store.commits).toEqual([]);
    }
  });
});

describe('Recovery Envelope (§5.4, D2, D16, D24, D179)', () => {
  function envelopeOf(store: MemoryStore): RecordEnvelope {
    const held = [...store.held.values()].find((r) => r.recordType === RecordType.recoveryEnvelope);
    return must(held).envelope;
  }

  it('writes an envelope that the phrase opens to the vault Master Key', async () => {
    const { session, store, words } = await create();
    const phrase = typed(words);
    const envelope = envelopeOf(store);
    expect(decodeEnvelope(envelope).header.recordId).toEqual(
      recoveryEnvelopeRecordId(session.vaultId),
    );
    const masterKey = openRecoveryEnvelope(
      phrase.keyring,
      envelope,
      session.vaultId,
      phrase.envelopeKey,
    );
    // The Master Key it holds opens this vault's Vault Key record.
    const subkeys = deriveMasterSubkeys(phrase.keyring, masterKey);
    const vaultKeyRecord = must(
      [...store.held.values()].find((r) => r.recordType === RecordType.vaultKey),
    );
    const verified = verifyRecord(phrase.keyring, vaultKeyRecord.envelope, {
      vaultId: session.vaultId,
      vaultKey: () => undefined,
      vaultKeyWrapKey: subkeys.vaultKeyWrap,
      versionIdKey: subkeys.versionId,
    });
    expect(verified.vaultKey).toBeDefined();
  });

  it('carries the keyslot public key derived from the phrase, a phraseId and its date', async () => {
    const { session, store, words, clock } = await create();
    const recovery = must(session.recovery);
    expect(recovery.keyslotPublicKey).toEqual(typed(words).keyslotPublicKey);
    expect(recovery.phraseId).toHaveLength(16);
    expect(recovery.phraseCreatedAt).toBe(clock.t);
    const again = await unlock(store);
    expect(again.recovery).toEqual(recovery);
    expect(again.corrupt()).toEqual([]);
  });

  it('gives every vault its own phrase and phraseId', async () => {
    const a = await create();
    const b = await create();
    expect(a.words).not.toBe(b.words);
    expect(must(a.session.recovery).phraseId).not.toEqual(must(b.session.recovery).phraseId);
  });

  it('releases the phrase entropy, keeping no recovery secret (CRYPTO-INV-006)', async () => {
    const { store, words, entropy } = await create();
    expect(() => deriveRecoveryKeys(new Keyring(), entropy)).toThrow(KeyWipedError);
    const persisted = [store.localConfig, ...[...store.held.values()].map((r) => r.envelope)];
    for (const text of phraseTraces(words)) {
      expect(persisted.some((bytes) => contains(bytes, utf8(text)))).toBe(false);
    }
    const { keyslotPublicKey } = typed(words);
    // The public key is in the metadata, encrypted: never in the clear.
    expect(persisted.some((bytes) => contains(bytes, keyslotPublicKey))).toBe(false);
  });

  it('records the phraseId as the last one seen (D43, D48)', async () => {
    const { session, store } = await create();
    const again = await unlock(store);
    expect(again.lastPhraseId).toEqual(must(session.recovery).phraseId);
  });

  it('unlocks a vault created without an envelope, with no Recovery Phrase (D177, D179)', async () => {
    const { store } = await create();
    for (const [key, r] of store.held) {
      if (r.recordType === RecordType.recoveryEnvelope) store.held.delete(key);
    }
    const again = await unlock(store);
    expect(again.recovery).toBeUndefined();
    expect(again.corrupt()).toEqual([]);
  });

  it('keeps an envelope that fails verification aside as corrupt', async () => {
    const { store } = await create();
    for (const [key, r] of store.held) {
      if (r.recordType !== RecordType.recoveryEnvelope) continue;
      const bytes = r.envelope.slice();
      bytes[bytes.length - 1] = must(bytes[bytes.length - 1]) ^ 1;
      store.held.set(key, { ...r, envelope: bytes as RecordEnvelope });
    }
    const again = await unlock(store);
    expect(again.recovery).toBeUndefined();
    expect(again.corrupt().map((k) => k.recordType)).toEqual([RecordType.recoveryEnvelope]);
  });
});

describe('Check Recovery Phrase (§5.4, D24, D179, D180)', () => {
  /** Replaces the envelope as another device of the vault would, with a later HLC. */
  function replaceEnvelope(
    store: MemoryStore,
    words: string,
    over: { masterKey?: SymmetricKey; publicKey?: Uint8Array },
  ) {
    const keys = keysOf(store);
    const phrase = typed(words);
    const metadata = new Map<CborValue, CborValue>([
      ['keyslotPublicKey', over.publicKey ?? phrase.keyslotPublicKey],
      ['phraseCreatedAt', T0],
      ['phraseId', randomId()],
    ]);
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.recoveryEnvelope,
      recordId: recoveryEnvelopeRecordId(keys.vaultId),
      keyEpoch: 1,
      hlc: hlcAt(T0 + 1000),
      deleted: false,
    };
    store.put({
      recordType: RecordType.recoveryEnvelope,
      recordId: header.recordId,
      envelope: sealRecoveryEnvelope(
        header,
        keys.vaultId,
        keys.vaultKey,
        phrase.envelopeKey,
        over.masterKey ?? keys.masterKey,
        metadata,
      ),
    });
  }

  it('confirms the phrase, as typed, opens the vault and its backups', async () => {
    const { session, store, words } = await create();
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
    expect(session.checkRecoveryPhrase(`\n${words.toUpperCase().split(' ').join('  ')}\n`)).toBe(
      'opens',
    );
    expect((await unlock(store)).checkRecoveryPhrase(words)).toBe('opens');
  });

  it('reports another valid phrase as not this vault one', async () => {
    const { session } = await create();
    const other = await create();
    expect(session.checkRecoveryPhrase(other.words)).toBe('wrong-phrase');
  });

  it('refuses input that is not a phrase, naming the position of an unknown word', async () => {
    const { session, words } = await create();
    const list = words.split(' ');
    expect(() => session.checkRecoveryPhrase(list.slice(1).join(' '))).toThrow(
      expect.objectContaining({ reason: 'word-count' }),
    );
    list[3] = 'notaword';
    expect(() => session.checkRecoveryPhrase(list.join(' '))).toThrow(
      expect.objectContaining({ reason: 'unknown-word', position: 4 }),
    );
    expect(() => session.checkRecoveryPhrase('')).toThrow(PhraseRejectedError);
  });

  it('reports an envelope whose keyslot public key the phrase does not derive (D24)', async () => {
    const { store, words } = await create();
    replaceEnvelope(store, words, { publicKey: typed((await create()).words).keyslotPublicKey });
    expect((await unlock(store)).checkRecoveryPhrase(words)).toBe('public-key-mismatch');
  });

  it('reports an envelope that opens to another Master Key (D180)', async () => {
    const { store, words } = await create();
    replaceEnvelope(store, words, { masterKey: generateKey(new Keyring()) });
    expect((await unlock(store)).checkRecoveryPhrase(words)).toBe('master-key-mismatch');
  });

  it('reports a vault without an envelope, and a corrupt envelope, before reading the input', async () => {
    const { store, words } = await create();
    const [key, record] = must(
      [...store.held].find(([, r]) => r.recordType === RecordType.recoveryEnvelope),
    );
    store.held.delete(key);
    const none = await unlock(store);
    expect(none.checkRecoveryPhrase(words)).toBe('no-envelope');
    expect(none.checkRecoveryPhrase('')).toBe('no-envelope');
    const bytes = record.envelope.slice();
    bytes[bytes.length - 1] = must(bytes[bytes.length - 1]) ^ 1;
    store.held.set(key, { ...record, envelope: bytes as RecordEnvelope });
    expect((await unlock(store)).checkRecoveryPhrase(words)).toBe('corrupt-envelope');
  });

  it('writes nothing and keeps no key it derived (CRYPTO-INV-006)', async () => {
    const { session, store, keyring, words } = await create();
    const commits = store.commits.length;
    const size = keyring.size;
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
    expect(session.checkRecoveryPhrase((await create()).words)).toBe('wrong-phrase');
    expect(store.commits).toHaveLength(commits);
    expect(keyring.size).toBe(size);
  });
});

describe('backup export (§10, D36, D64, D115, D181)', () => {
  const EXPORT_PASSWORD = 'orbit-tulip-granite-ferry-cedar-pixel';

  /**
   * A stand-in for the Argon2id worker: a key made of the password's bytes, so another password
   * gives another key. Argon2id itself is tested in `packages/crypto`.
   */
  function fakeKdf(onDerive?: () => void) {
    const requests: { readonly op: string; readonly params?: unknown }[] = [];
    const sent: Uint8Array[] = [];
    let terminated = 0;
    const port = (): KdfPort => {
      const p: KdfPort = {
        onmessage: null,
        onerror: null,
        postMessage(message: KdfRequest) {
          requests.push({
            op: message.op,
            ...('params' in message ? { params: message.params } : {}),
          });
          sent.push(message.password);
          onDerive?.();
          const key = new Uint8Array(32);
          key.set(message.password.subarray(0, 32));
          const params = 'params' in message ? message.params : PARAMS;
          queueMicrotask(() => p.onmessage?.({ data: { ok: true, key, params } }));
        },
        terminate() {
          terminated += 1;
        },
      };
      return p;
    };
    return { port, requests, sent, terminated: () => terminated };
  }

  function sorted(records: readonly Uint8Array[]): string[] {
    return records.map((r) => Buffer.from(r).toString('hex')).sort();
  }

  /** Opens a backup with the typed phrase, as a restore would (backup-format.md §8, steps 1–5). */
  function openWithPhrase(file: Uint8Array, words: string) {
    const keyring = new Keyring();
    const parsed = parseBackup(file);
    const phrase = typed(words);
    const fileKey = openRecoveryKeyslot(keyring, parsed.header, phrase);
    phrase.keyring.wipeAll();
    return { parsed, payload: openBackup(keyring, fileKey, parsed), keyring };
  }

  /** Whether `masterKey` is this vault's: it opens the Vault Key record of `store`. */
  function opensVaultKey(keyring: Keyring, masterKey: SymmetricKey, store: MemoryStore): boolean {
    const subkeys = deriveMasterSubkeys(keyring, masterKey);
    const [record] = store.ofType(RecordType.vaultKey);
    const { vaultId } = parseLocalConfig(store.localConfig);
    return (
      verifyRecord(keyring, must(record).envelope, {
        vaultId,
        vaultKey: () => undefined,
        vaultKeyWrapKey: subkeys.vaultKeyWrap,
        versionIdKey: subkeys.versionId,
      }).vaultKey !== undefined
    );
  }

  function corruptOne(store: MemoryStore, recordType: RecordType) {
    const [key, record] = must([...store.held].find(([, r]) => r.recordType === recordType));
    const bytes = record.envelope.slice();
    bytes[bytes.length - 1] = must(bytes[bytes.length - 1]) ^ 1;
    store.held.set(key, { ...record, envelope: bytes as RecordEnvelope });
    return { key, record };
  }

  it('exports every stored record under the recovery keyslot, opened by the phrase (§8, D16)', async () => {
    const { session, store, clock, keyring, words } = await create();
    const id = await session.createItem(login());
    await session.updateItem(id, login('Renamed'));
    await session.createFolder('Work');
    clock.t += 5000;
    const stored = await store.records();
    const file = await session.exportBackup({ kek: kek(keyring), method: 'password' });

    expect(file.exportedAt).toBe(T0 + 5000);
    const { parsed, payload, keyring: opened } = openWithPhrase(file.bytes, words);
    expect(parsed.header.keyslots.map((k) => k.type)).toEqual(['recovery']);
    expect(parsed.header.phraseId).toEqual(session.recovery?.phraseId);
    expect(parsed.header.phraseCreatedAt).toBe(session.recovery?.phraseCreatedAt);
    expect(payload.vaultId).toEqual(session.vaultId);
    expect(payload.exportedAt).toBe(T0 + 5000);
    // Items, the Item Version, the Folder, the Vault Key, the Recovery Envelope and the Device.
    expect(stored).toHaveLength(6);
    expect(sorted(payload.records)).toEqual(sorted(stored.map((r) => r.envelope)));
    expect(opensVaultKey(opened, payload.masterKey, store)).toBe(true);
    // Another vault's phrase does not open it.
    const other = (await create()).words;
    expect(() => openWithPhrase(file.bytes, other)).toThrow(
      expect.objectContaining({ reason: 'wrong-secret' }),
    );
    opened.wipeAll();
  });

  it('adds a password keyslot at the export parameters, opened by that password (D36)', async () => {
    const { session, store, keyring, words } = await create();
    const kdf = fakeKdf();
    const password = normalizePassword(EXPORT_PASSWORD);
    const file = await session.exportBackup({
      kek: kek(keyring),
      method: 'password',
      exportPassword: { password, port: kdf.port() },
    });
    expect(kdf.requests).toEqual([{ op: 'derive', params: EXPORT_KDF }]);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(kdf.terminated()).toBe(1);

    const parsed = parseBackup(file.bytes);
    expect(parsed.header.keyslots.map((k) => k.type)).toEqual(['recovery', 'password']);
    const opened = new Keyring();
    const fileKey = await openPasswordKeyslot(
      opened,
      fakeKdf().port(),
      parsed.header,
      normalizePassword(EXPORT_PASSWORD),
    );
    const payload = openBackup(opened, fileKey, parsed);
    expect(opensVaultKey(opened, payload.masterKey, store)).toBe(true);
    await expect(
      openPasswordKeyslot(opened, fakeKdf().port(), parsed.header, normalizePassword('other')),
    ).rejects.toThrow(expect.objectContaining({ reason: 'wrong-secret' }));
    // The phrase still opens it.
    expect(sorted(openWithPhrase(file.bytes, words).payload.records)).toEqual(
      sorted(payload.records),
    );
    opened.wipeAll();
  });

  it('opens the Master Key with a passkey KEK as well (D181, §14)', async () => {
    const { session, store, keyring, words } = await create();
    await session.setPasskey({
      current: kek(keyring),
      prfKek: kek(keyring, 3),
      credentialId: new Uint8Array([9, 8, 7]),
      prfInput: new Uint8Array(32).fill(4),
    });
    const file = await session.exportBackup({ kek: kek(keyring, 3), method: 'passkey' });
    const { payload, keyring: opened } = openWithPhrase(file.bytes, words);
    expect(opensVaultKey(opened, payload.masterKey, store)).toBe(true);
    opened.wipeAll();
  });

  it('refuses a KEK that does not open the wrap, writing nothing and wiping the export password (D181)', async () => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    for (const [seed, method] of [
      [2, 'password'],
      [1, 'passkey'],
    ] as const) {
      const kdf = fakeKdf();
      const password = normalizePassword(EXPORT_PASSWORD);
      await expect(
        session.exportBackup({
          kek: kek(keyring, seed),
          method,
          exportPassword: { password, port: kdf.port() },
        }),
      ).rejects.toThrow(UnlockRejectedError);
      expect(password.every((b) => b === 0)).toBe(true);
      expect(kdf.requests).toEqual([]);
      expect(kdf.terminated()).toBe(1);
    }
    expect(store.commits).toHaveLength(commits);
    expect(session.lastBackupAt).toBeUndefined();
  });

  it('aborts on a stored record that no longer verifies, naming it and writing nothing (D64)', async () => {
    const { session, store, keyring } = await create();
    const id = await session.createItem(login());
    const commits = store.commits.length;
    corruptOne(store, RecordType.item);
    const kdf = fakeKdf();
    const password = normalizePassword(EXPORT_PASSWORD);
    const refused = session.exportBackup({
      kek: kek(keyring),
      method: 'password',
      exportPassword: { password, port: kdf.port() },
    });
    await expect(refused).rejects.toThrow(ExportRejectedError);
    await expect(refused).rejects.toMatchObject({
      reason: 'corrupt-record',
      record: { recordType: RecordType.item, recordId: id },
    });
    expect(kdf.requests).toEqual([]);
    expect(password.every((b) => b === 0)).toBe(true);
    expect(store.commits).toHaveLength(commits);
  });

  it('aborts on a record kept aside as corrupt at unlock, even once the store holds it again (D64)', async () => {
    const { store } = await create();
    const { key, record } = corruptOne(store, RecordType.device);
    const session = await unlock(store);
    store.held.set(key, record);
    const caller = new Keyring();
    await expect(
      session.exportBackup({ kek: kek(caller), method: 'password' }),
    ).rejects.toMatchObject({
      reason: 'corrupt-record',
      record: { recordType: RecordType.device, recordId: record.recordId },
    });
    caller.wipeAll();
  });

  it('refuses a vault without a Recovery Envelope (D179)', async () => {
    const { store } = await create();
    const [key] = must(
      [...store.held].find(([, r]) => r.recordType === RecordType.recoveryEnvelope),
    );
    store.held.delete(key);
    const session = await unlock(store);
    const caller = new Keyring();
    await expect(
      session.exportBackup({ kek: kek(caller), method: 'password' }),
    ).rejects.toMatchObject({ reason: 'no-envelope' });
    caller.wipeAll();
  });

  it('records the date of the last backup in Local Config, and nothing else (§13.4)', async () => {
    const { session, store, clock, keyring } = await create();
    expect(session.lastBackupAt).toBeUndefined();
    const records = new Map(store.held);
    const commits = store.commits.length;
    clock.t += 1234;
    await session.exportBackup({ kek: kek(keyring), method: 'password' });
    expect(store.commits).toHaveLength(commits + 1);
    expect(store.commits.at(-1)?.put).toEqual([]);
    expect(store.commits.at(-1)?.delete).toEqual([]);
    expect(store.held).toEqual(records);
    expect(session.lastBackupAt).toBe(T0 + 1234);
    expect((await unlock(store, clock)).lastBackupAt).toBe(T0 + 1234);
  });

  it('says the backup may be incomplete while Local Config lists rejected peers (D115)', async () => {
    const { session, store } = await create();
    expect(session.backupMayBeIncomplete).toBe(false);
    session.lock();
    const keys = keysOf(store);
    const config = parseLocalConfig(store.localConfig);
    const encrypted = sealLocalConfigPart(
      keys.subkeys.localConfig,
      localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
      localConfigStateToCbor({
        preferences: DEFAULT_PREFERENCES,
        hlc: hlcAt(T0),
        rejectedPeers: [randomId()],
      }),
      generateDeviceIdentity(new Keyring()),
    );
    store.localConfig = encodeCbor(localConfigToCbor({ ...config, encrypted }));
    expect((await unlock(store)).backupMayBeIncomplete).toBe(true);
  });

  it('rejects and writes nothing when the vault locks during the export password derivation (CRYPTO-INV-010)', async () => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    const caller = new Keyring();
    const kdf = fakeKdf(() => {
      session.lock();
    });
    await expect(
      session.exportBackup({
        kek: kek(caller),
        method: 'password',
        exportPassword: { password: normalizePassword(EXPORT_PASSWORD), port: kdf.port() },
      }),
    ).rejects.toThrow(VaultLockedError);
    expect(store.commits).toHaveLength(commits);
    expect(keyring.wiped).toBe(true);
    caller.wipeAll();
  });

  it('keeps no key it used, and leaves the caller KEK to the caller (D181)', async () => {
    const { session, keyring } = await create();
    const caller = new Keyring();
    const callerKek = kek(caller);
    const size = keyring.size;
    await session.exportBackup({
      kek: callerKek,
      method: 'password',
      exportPassword: { password: normalizePassword(EXPORT_PASSWORD), port: fakeKdf().port() },
    });
    expect(keyring.size).toBe(size);
    expect(caller.size).toBe(1);
    caller.wipeAll();
  });

  it('exports while the vault is read-only beyond the future-clock cap, issuing no HLC (D73)', async () => {
    const { session, store, clock, words } = await create();
    session.lock();
    clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
    const behind = await unlock(store, clock);
    expect(behind.writable).toBe(false);
    const caller = new Keyring();
    const file = await behind.exportBackup({ kek: kek(caller), method: 'password' });
    expect(openWithPhrase(file.bytes, words).payload.records).toHaveLength(3);
    expect(behind.lastBackupAt).toBe(clock.t);
    caller.wipeAll();
  });
});

describe('Recovery Phrase regeneration (§5.4, D2, D73, D74, D98, D185)', () => {
  /** A new phrase, as the controller holds it once confirmed: its words and its entropy. */
  function newPhrase() {
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    return { keyring, words: phrase.words, entropy: phrase.entropy };
  }

  async function regenerate(session: VaultSession, seed = 1, method: UnlockMethod = 'password') {
    const phrase = newPhrase();
    const caller = new Keyring();
    try {
      const recovery = await session.regenerateRecoveryPhrase({
        kek: kek(caller, seed),
        method,
        entropy: phrase.entropy,
      });
      return { recovery, words: phrase.words };
    } finally {
      caller.wipeAll();
      phrase.keyring.wipeAll();
    }
  }

  function envelopeKeyOf(store: MemoryStore): string {
    return must([...store.held].find(([, r]) => r.recordType === RecordType.recoveryEnvelope))[0];
  }

  function plantMetadata(store: MemoryStore, hlc: Hlc, extra: [string, CborValue][] = []) {
    const keys = keysOf(store);
    const phrase = newPhrase();
    const recovery = deriveRecoveryKeys(phrase.keyring, phrase.entropy);
    const metadata = new Map<CborValue, CborValue>([
      ['keyslotPublicKey', recovery.keyslotPublicKey],
      ['phraseCreatedAt', hlc.physicalMs],
      ['phraseId', randomId()],
      ...extra,
    ]);
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.recoveryEnvelope,
      recordId: recoveryEnvelopeRecordId(keys.vaultId),
      keyEpoch: 1,
      hlc,
      deleted: false,
    };
    store.put({
      recordType: RecordType.recoveryEnvelope,
      recordId: header.recordId,
      envelope: sealRecoveryEnvelope(
        header,
        keys.vaultId,
        keys.vaultKey,
        recovery.envelopeKey,
        keys.masterKey,
        metadata,
      ),
    });
    return { words: phrase.words, header };
  }

  /** Whether `words` open the backup `file` to this vault (backup-format.md §8, steps 1 to 8). */
  function restores(file: Uint8Array, words: string, vaultId: Uint8Array): boolean {
    const keyring = new Keyring();
    try {
      return sameId(restoreWithPhrase(keyring, parseBackup(file), words).vaultId, vaultId);
    } catch {
      return false;
    } finally {
      keyring.wipeAll();
    }
  }

  function sameId(a: Uint8Array, b: Uint8Array): boolean {
    return idKey(a) === idKey(b);
  }

  it('replaces only the envelope, in one commit with the new phraseId as the last seen (Gate B)', async () => {
    const { session, store, clock, words } = await create();
    const id = await session.createItem(login());
    await session.updateItem(id, login('Renamed'));
    await session.createFolder('Work');
    const before = must(session.recovery);
    const envelopeKey = envelopeKeyOf(store);
    const oldEnvelope = must(store.held.get(envelopeKey));
    const others = new Map([...store.held].filter(([key]) => key !== envelopeKey));
    const commits = store.commits.length;
    clock.t += 5000;

    const { recovery, words: next } = await regenerate(session);

    expect(store.commits).toHaveLength(commits + 1);
    expect(store.commits.at(-1)?.put.map((r) => r.recordType)).toEqual([
      RecordType.recoveryEnvelope,
    ]);
    expect(store.commits.at(-1)?.delete).toEqual([]);
    expect(new Map([...store.held].filter(([key]) => key !== envelopeKey))).toEqual(others);
    const header = decodeEnvelope(must(store.held.get(envelopeKey)).envelope).header;
    expect(compareHlc(header.hlc, decodeEnvelope(oldEnvelope.envelope).header.hlc)).toBe(1);
    expect(header.hlc.deviceId).toEqual(session.deviceId);
    expect(recovery.phraseId).not.toEqual(before.phraseId);
    expect(recovery.phraseCreatedAt).toBe(T0 + 5000);
    expect(recovery.keyslotPublicKey).toEqual(typed(next).keyslotPublicKey);
    expect(session.recovery).toEqual(recovery);
    expect(session.lastPhraseId).toEqual(recovery.phraseId);
    expect(session.checkRecoveryPhrase(next)).toBe('opens');
    expect(session.checkRecoveryPhrase(words)).toBe('wrong-phrase');
    const again = await unlock(store, clock);
    expect(again.recovery).toEqual(recovery);
    expect(again.lastPhraseId).toEqual(recovery.phraseId);
    expect(again.items().map((i) => i.item?.title)).toEqual(['Renamed']);
  });

  it('makes the next backup open with the new phrase only (Gate B)', async () => {
    const { session, keyring, words } = await create();
    await session.createItem(login());
    const old = await session.exportBackup({ kek: kek(keyring), method: 'password' });
    const { recovery, words: next } = await regenerate(session);
    const file = await session.exportBackup({ kek: kek(keyring), method: 'password' });
    expect(parseBackup(file.bytes).header.phraseId).toEqual(recovery.phraseId);
    expect(restores(file.bytes, next, session.vaultId)).toBe(true);
    expect(restores(file.bytes, words, session.vaultId)).toBe(false);
    // An earlier backup still opens with the old phrase only (§5.4, documented limitation).
    expect(restores(old.bytes, words, session.vaultId)).toBe(true);
    expect(restores(old.bytes, next, session.vaultId)).toBe(false);
  });

  it('opens the Master Key with a passkey KEK as well (D181, D185)', async () => {
    const { session, keyring } = await create();
    await session.setPasskey({
      current: kek(keyring),
      prfKek: kek(keyring, 3),
      credentialId: new Uint8Array([9, 8, 7]),
      prfInput: new Uint8Array(32).fill(4),
    });
    const { words } = await regenerate(session, 3, 'passkey');
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
  });

  it('refuses a KEK that does not open the wrap, writing nothing (D185)', async () => {
    const { session, store, words } = await create();
    const before = session.recovery;
    const commits = store.commits.length;
    await expect(regenerate(session, 2)).rejects.toThrow(UnlockRejectedError);
    await expect(regenerate(session, 1, 'passkey')).rejects.toThrow(UnlockRejectedError);
    expect(store.commits).toHaveLength(commits);
    expect(session.recovery).toEqual(before);
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
  });

  it('keeps no key it derived, and leaves the KEK and the entropy to the caller (CRYPTO-INV-006)', async () => {
    const { session, store, keyring } = await create();
    const size = keyring.size;
    const phrase = newPhrase();
    const caller = new Keyring();
    await session.regenerateRecoveryPhrase({
      kek: kek(caller),
      method: 'password',
      entropy: phrase.entropy,
    });
    expect(keyring.size).toBe(size);
    expect(caller.size).toBe(1);
    expect(phrase.keyring.size).toBe(1);
    const persisted = [store.localConfig, ...[...store.held.values()].map((r) => r.envelope)];
    for (const text of phraseTraces(phrase.words)) {
      expect(persisted.some((bytes) => contains(bytes, utf8(text)))).toBe(false);
    }
    caller.wipeAll();
    phrase.keyring.wipeAll();
  });

  it('is blocked for a vault without an envelope (D179)', async () => {
    const { store } = await create();
    store.held.delete(envelopeKeyOf(store));
    const session = await unlock(store);
    expect(session.regenerationBlock).toEqual({ reason: 'no-envelope' });
    const commits = store.commits.length;
    await expect(regenerate(session)).rejects.toMatchObject({
      name: 'RegenerationBlockedError',
      block: { reason: 'no-envelope' },
    });
    expect(store.commits).toHaveLength(commits);
  });

  it('is blocked while the envelope metadata holds a key from a newer app version (D98)', async () => {
    const { session, store } = await create();
    expect(session.regenerationBlock).toBeUndefined();
    const { words, header } = plantMetadata(store, hlcAt(T0 + 1000), [['hint', 'newer']]);
    const newer = await unlock(store);
    // Kept as received: Check Recovery Phrase still verifies it.
    expect(newer.corrupt()).toEqual([]);
    expect(newer.checkRecoveryPhrase(words)).toBe('opens');
    expect(newer.regenerationBlock).toEqual({ reason: 'newer-content' });
    const commits = store.commits.length;
    await expect(regenerate(newer)).rejects.toMatchObject({
      block: { reason: 'newer-content' },
    });
    expect(store.commits).toHaveLength(commits);
    expect(decodeEnvelope(must(store.held.get(envelopeKeyOf(store))).envelope).header).toEqual(
      header,
    );
  });

  it('is blocked while the held envelope is beyond the future-clock bound, until within it (D74)', async () => {
    const { store, clock } = await create();
    const at = T0 + FUTURE_CLOCK_BOUND_MS + DAY;
    const { header } = plantMetadata(store, hlcAt(at));
    const session = await unlock(store, clock);
    expect(session.writable).toBe(true);
    expect(session.regenerationBlock).toEqual({
      reason: 'future-clock',
      until: at - FUTURE_CLOCK_BOUND_MS,
    });
    const commits = store.commits.length;
    await expect(regenerate(session)).rejects.toMatchObject({
      block: { reason: 'future-clock', until: at - FUTURE_CLOCK_BOUND_MS },
    });
    expect(store.commits).toHaveLength(commits);
    clock.t = at - FUTURE_CLOCK_BOUND_MS;
    expect(session.regenerationBlock).toBeUndefined();
    await regenerate(session);
    const written = decodeEnvelope(must(store.held.get(envelopeKeyOf(store))).envelope).header;
    expect(compareHlc(written.hlc, header.hlc)).toBe(1);
  });

  it('is blocked while the vault is read-only because the clock went back (D73)', async () => {
    const { session, store, clock } = await create();
    session.lock();
    clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
    const behind = await unlock(store, clock);
    expect(behind.regenerationBlock).toEqual({ reason: 'read-only', until: behind.writableAt });
    const commits = store.commits.length;
    await expect(regenerate(behind)).rejects.toMatchObject({ block: { reason: 'read-only' } });
    expect(store.commits).toHaveLength(commits);
  });

  it('replaces an envelope kept aside as corrupt at unlock (D185)', async () => {
    const { store, clock } = await create();
    const key = envelopeKeyOf(store);
    const record = must(store.held.get(key));
    const bytes = record.envelope.slice();
    bytes[bytes.length - 1] = must(bytes[bytes.length - 1]) ^ 1;
    store.held.set(key, { ...record, envelope: bytes as RecordEnvelope });
    const session = await unlock(store, clock);
    expect(session.corrupt().map((k) => k.recordType)).toEqual([RecordType.recoveryEnvelope]);
    expect(session.regenerationBlock).toBeUndefined();

    const { recovery, words } = await regenerate(session);
    expect(session.corrupt()).toEqual([]);
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
    const again = await unlock(store, clock);
    expect(again.corrupt()).toEqual([]);
    expect(again.recovery).toEqual(recovery);
  });

  it('refuses once locked, writing nothing (CRYPTO-INV-010)', async () => {
    const { session, store } = await create();
    const commits = store.commits.length;
    session.lock();
    await expect(regenerate(session)).rejects.toThrow(VaultLockedError);
    expect(store.commits).toHaveLength(commits);
  });
});

describe('fresh restore (§10, D30, D33, D39, D59, D61, D64)', () => {
  /** A vault with an item, its history and a folder, and its backup made by the phrase only. */
  async function backedUp(clock = new Clock()) {
    const vault = await create(clock);
    const id = await vault.session.createItem(login());
    await vault.session.updateItem(id, login('Renamed'));
    await vault.session.createFolder('Work');
    const file = await vault.session.exportBackup({ kek: kek(vault.keyring), method: 'password' });
    return { ...vault, id, file };
  }

  /** Validates `file` with the phrase, as `packages/backup` does, then restores it into `store`. */
  async function restore(
    file: Uint8Array,
    words: string,
    clock = new Clock(),
    store = new MemoryStore(),
    kdfParams = PARAMS,
  ) {
    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(file), words);
    const session = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams,
      backup,
      now: clock.now,
    });
    open.push(session);
    return { session, store, keyring, backup };
  }

  function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
    return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
  }

  it('writes every record of the backup and the Local Config in one commit (D33)', async () => {
    const source = await backedUp();
    const restored = await restore(source.file.bytes, source.words);
    expect(restored.store.commits).toHaveLength(1);
    const [commit] = restored.store.commits;
    expect(commit?.delete).toEqual([]);
    expect(hexes(commit?.put ?? [])).toEqual(hexes(restored.backup.records));
    expect(hexes(await restored.store.records())).toEqual(hexes(await source.store.records()));
  });

  it('opens the same vault, readable by the new local password only', async () => {
    const source = await backedUp();
    const { session, store } = await restore(source.file.bytes, source.words);
    expect(session.vaultId).toEqual(source.session.vaultId);
    expect(session.items().map((i) => i.item?.title)).toEqual(['Renamed']);
    expect(session.versions(source.id)).toHaveLength(source.session.versions(source.id).length);
    expect(session.folders().map((f) => f.name)).toEqual(['Work']);
    expect(session.recovery).toEqual(source.session.recovery);
    session.lock();
    const again = await unlock(store, new Clock(), 2);
    expect(again.items().map((i) => i.item?.title)).toEqual(['Renamed']);
    await expect(unlock(store, new Clock(), 1)).rejects.toThrow(UnlockRejectedError);
  });

  it('is a new, unregistered device: new identity and Local Config, no Device record (D30)', async () => {
    const source = await backedUp();
    const { session, store } = await restore(source.file.bytes, source.words);
    expect(session.deviceId).not.toEqual(source.session.deviceId);
    expect(session.devices().map((d) => d.deviceId)).toEqual([source.session.deviceId]);
    expect(store.ofType(RecordType.device)).toHaveLength(1);
    const config = parseLocalConfig(store.localConfig);
    const sourceConfig = parseLocalConfig(source.store.localConfig);
    expect(config.vaultId).toEqual(sourceConfig.vaultId);
    expect(config.localConfigId).not.toEqual(sourceConfig.localConfigId);
    expect(config.kek).toMatchObject({ salt: SALT, ...PARAMS });
    expect(config.prf).toBeUndefined();
    expect(config.replacesVaultId).toBeUndefined();
  });

  it('keeps the default preferences, no backup date and the restored phrase as the last seen (§13.4)', async () => {
    const source = await backedUp();
    await source.session.setPreferences({ ...DEFAULT_PREFERENCES, autoLockMinutes: 1 });
    const { session } = await restore(source.file.bytes, source.words);
    expect(session.preferences).toEqual(DEFAULT_PREFERENCES);
    expect(session.lastBackupAt).toBeUndefined();
    expect(source.session.lastBackupAt).toBe(T0);
    expect(session.lastPhraseId).toEqual(source.session.recovery?.phraseId);
  });

  it('accepts records beyond the future-clock bound, read-only until within it (D39)', async () => {
    const clock = new Clock();
    const source = await create(clock);
    const ahead = randomId();
    const at = T0 + 3 * DAY;
    plant(
      source.store,
      keysOf(source.store),
      RecordType.item,
      ahead,
      hlcAt(at),
      false,
      itemToCbor(login('Ahead'), false),
    );
    const file = await source.session.exportBackup({
      kek: kek(source.keyring),
      method: 'password',
    });

    const restoredClock = new Clock();
    const { session, store } = await restore(file.bytes, source.words, restoredClock);
    expect(session.item(ahead)?.readOnly).toBe('future-clock');
    expect(session.item(ahead)?.item?.title).toBe('Ahead');
    await expect(session.updateItem(ahead, login('Edited'))).rejects.toThrow(
      new RecordBlockedError('future-clock'),
    );
    // The record does not advance the HLC (D109): the vault itself stays writable.
    expect(session.writable).toBe(true);
    expect(session.writableAt).toBeNull();
    await session.createItem(login('New'));
    session.lock();

    restoredClock.t = at - FUTURE_CLOCK_BOUND_MS;
    const later = await unlock(store, restoredClock, 2);
    expect(later.item(ahead)?.readOnly).toBeUndefined();
    await later.updateItem(ahead, login('Edited'));
    expect(later.item(ahead)?.item?.title).toBe('Edited');
  });

  it('rejects the whole restore for a record that fails the content checks, naming it (D59, D64)', async () => {
    const source = await create();
    const keys = keysOf(source.store);
    const folderId = randomId();
    // A Folder whose name is not text: valid on receipt, invalid as content (D59).
    plant(
      source.store,
      keys,
      RecordType.folder,
      folderId,
      hlcAt(T0),
      false,
      new Map<CborValue, CborValue>([['name', 7]]),
    );
    const keyring = new Keyring();
    const store = new MemoryStore();
    const error = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: {
        vaultId: keys.vaultId,
        masterKey: keys.masterKey,
        records: await source.store.records(),
      },
      now: new Clock().now,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RestoreRejectedError);
    expect((error as RestoreRejectedError).record).toEqual({
      recordType: RecordType.folder,
      recordId: folderId,
    });
    expect((error as RestoreRejectedError).message).toBe(
      'restore rejected: a record does not verify',
    );
    expect(store.commits).toEqual([]);
    expect(store.localConfig).toHaveLength(0);
    expect(keyring.wiped).toBe(true);
  });

  it('writes nothing and keeps no key when the commit fails (D33, D104)', async () => {
    const source = await backedUp();
    const store = new MemoryStore();
    store.failNext = true;
    const keyring = new Keyring();
    const backup = restoreWithPhrase(keyring, parseBackup(source.file.bytes), source.words);
    await expect(
      VaultSession.restore({
        store,
        keyring,
        kek: kek(keyring, 2),
        salt: SALT,
        kdfParams: PARAMS,
        backup,
      }),
    ).rejects.toThrow('storage failure');
    expect(store.held.size).toBe(0);
    expect(store.localConfig).toHaveLength(0);
    expect(keyring.wiped).toBe(true);
    expect(keyring.size).toBe(0);
  });

  it('records the vault it replaces in the cleartext part until told it is gone (D89, D96)', async () => {
    const source = await backedUp();
    const replaced = randomId();
    const keyring = new Keyring();
    const store = new MemoryStore();
    const session = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(source.file.bytes), source.words),
      replacesVaultId: replaced,
      now: new Clock().now,
    });
    open.push(session);
    expect(store.commits).toHaveLength(1);
    expect(parseLocalConfig(store.localConfig).replacesVaultId).toEqual(replaced);
    // A write before the old database is gone keeps it, so the startup cleanup still finds it.
    await session.createItem(login('Before'));
    expect(parseLocalConfig(store.localConfig).replacesVaultId).toEqual(replaced);

    await session.forgetReplacedVault();
    const commits = store.commits.length;
    expect(parseLocalConfig(store.localConfig).replacesVaultId).toBeUndefined();
    expect(store.commits.at(-1)).toMatchObject({ put: [], delete: [] });
    await session.createItem(login('After'));
    expect(parseLocalConfig(store.localConfig).replacesVaultId).toBeUndefined();
    // Nothing more to forget: no write.
    await session.forgetReplacedVault();
    expect(store.commits).toHaveLength(commits + 1);
  });

  it('refuses a replaced vaultId that is not an ID, writing nothing', async () => {
    const source = await backedUp();
    const keyring = new Keyring();
    const store = new MemoryStore();
    await expect(
      VaultSession.restore({
        store,
        keyring,
        kek: kek(keyring, 2),
        salt: SALT,
        kdfParams: PARAMS,
        backup: restoreWithPhrase(keyring, parseBackup(source.file.bytes), source.words),
        replacesVaultId: new Uint8Array(15),
      }),
    ).rejects.toThrow(RangeError);
    expect(store.commits).toEqual([]);
    expect(keyring.wiped).toBe(true);
  });

  it('refuses to replace the vault it restores: the same vaultId commits in place (D153)', async () => {
    const source = await backedUp();
    const keyring = new Keyring();
    const store = new MemoryStore();
    await expect(
      VaultSession.restore({
        store,
        keyring,
        kek: kek(keyring, 2),
        salt: SALT,
        kdfParams: PARAMS,
        backup: restoreWithPhrase(keyring, parseBackup(source.file.bytes), source.words),
        replacesVaultId: source.session.vaultId,
      }),
    ).rejects.toThrow(RangeError);
    expect(store.commits).toEqual([]);
  });

  it('refuses KDF parameters outside the accepted range before deriving anything', async () => {
    const source = await backedUp();
    await expect(
      restore(source.file.bytes, source.words, new Clock(), new MemoryStore(), {
        opslimit: 1,
        memlimit: MEMLIMIT,
      }),
    ).rejects.toThrow(KdfParamsRejectedError);
  });

  it('persists no plaintext and no phrase (CRYPTO-INV-001, CRYPTO-INV-006)', async () => {
    const source = await backedUp();
    const { store } = await restore(source.file.bytes, source.words);
    const bytes = [store.localConfig, ...(await store.records()).map((r) => r.envelope)];
    for (const needle of [
      'Renamed',
      'correct horse battery staple',
      'Work',
      ...phraseTraces(source.words),
    ]) {
      expect(bytes.some((b) => contains(b, utf8(needle)))).toBe(false);
    }
  });
});

describe('forgotten password reset with the Recovery Phrase (§5.4, §14, D173, D184)', () => {
  /** Resets the local password of the vault in `store` with `words`, to the KEK of `seed`. */
  async function reset(store: MemoryStore, words: string, clock = new Clock(), seed = 2) {
    const keyring = new Keyring();
    const session = await VaultSession.resetPassword({
      store,
      localConfig: parseLocalConfig(store.localConfig),
      keyring,
      entropy: parseRecoveryPhrase(keyring, words),
      kek: kek(keyring, seed),
      salt: new Uint8Array(16).fill(8),
      kdfParams: PARAMS,
      now: clock.now,
    });
    open.push(session);
    return { session, keyring };
  }

  async function rejection(promise: Promise<unknown>) {
    const error = await promise.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PasswordResetRejectedError);
    return (error as PasswordResetRejectedError).reason;
  }

  function hexes(records: readonly { readonly envelope: Uint8Array }[]): string[] {
    return records.map((r) => Buffer.from(r.envelope).toString('hex')).sort();
  }

  /** Replaces the held Recovery Envelope with one whose `mk` wraps `masterKey` under `words`. */
  function plantEnvelope(store: MemoryStore, words: string, masterKey: SymmetricKey) {
    const keys = keysOf(store);
    const [held] = store.ofType(RecordType.recoveryEnvelope);
    const { header } = decodeEnvelope(must(held).envelope);
    const scratch = new Keyring();
    const recovery = deriveRecoveryKeys(scratch, parseRecoveryPhrase(scratch, words));
    const envelope = sealRecoveryEnvelope(
      header,
      keys.vaultId,
      keys.vaultKey,
      recovery.envelopeKey,
      masterKey,
      new Map<CborValue, CborValue>([
        ['keyslotPublicKey', recovery.keyslotPublicKey],
        ['phraseId', randomId()],
        ['phraseCreatedAt', T0],
      ]),
    );
    store.put({ recordType: RecordType.recoveryEnvelope, recordId: header.recordId, envelope });
    scratch.wipeAll();
  }

  it('sets a new local password with the phrase, writing only Local Config (D173)', async () => {
    const { session, store, words } = await create();
    const id = await session.createItem(login('Only here'));
    const before = hexes(await store.records());
    const config = parseLocalConfig(store.localConfig);
    const deviceId = session.deviceId;
    session.lock();
    const commits = store.commits.length;

    const { session: again, keyring } = await reset(store, words);
    expect(again.item(id)?.item?.title).toBe('Only here');
    expect(store.commits).toHaveLength(commits + 1);
    expect(store.commits.at(-1)).toMatchObject({ put: [], delete: [] });
    expect(hexes(await store.records())).toEqual(before);
    const after = parseLocalConfig(store.localConfig);
    expect(after.vaultId).toEqual(config.vaultId);
    expect(after.localConfigId).toEqual(config.localConfigId);
    expect(after.kek).toMatchObject({ salt: new Uint8Array(16).fill(8), ...PARAMS });
    // The same device: its identity is kept.
    expect(again.deviceId).toEqual(deviceId);
    // The session keeps no Master Key and no recovery key: only what an unlock holds.
    again.lock();
    expect(keyring.size).toBe(0);

    await expect(unlock(store, new Clock(), 1)).rejects.toThrow(UnlockRejectedError);
    const unlocked = await unlock(store, new Clock(), 2);
    expect(unlocked.item(id)?.item?.title).toBe('Only here');
  });

  it('refuses a phrase that does not open the held envelope, writing nothing', async () => {
    const { session, store } = await create();
    const vaultId = session.vaultId;
    session.lock();
    const commits = store.commits.length;
    const config = store.localConfig;
    const other = await create();
    const keyring = new Keyring();
    expect(
      await rejection(
        VaultSession.resetPassword({
          store,
          localConfig: parseLocalConfig(config),
          keyring,
          entropy: parseRecoveryPhrase(keyring, other.words),
          kek: kek(keyring, 2),
          salt: SALT,
          kdfParams: PARAMS,
        }),
      ),
    ).toBe('wrong-phrase');
    expect(store.commits).toHaveLength(commits);
    expect(store.localConfig).toEqual(config);
    expect(keyring.wiped).toBe(true);
    expect(keyring.size).toBe(0);
    expect((await unlock(store, new Clock(), 1)).vaultId).toEqual(vaultId);
  });

  it('refuses an envelope that opens to another Master Key, and a vault without one (D179)', async () => {
    const { session, store, words } = await create();
    session.lock();
    const scratch = new Keyring();
    plantEnvelope(store, words, generateKey(scratch));
    const commits = store.commits.length;
    expect(await rejection(reset(store, words))).toBe('master-key-mismatch');
    expect(store.commits).toHaveLength(commits);

    store.held.delete(
      [...store.held.entries()].find(
        ([, r]) => r.recordType === RecordType.recoveryEnvelope,
      )?.[0] ?? '',
    );
    expect(await rejection(reset(store, words))).toBe('no-envelope');
    expect(store.commits).toHaveLength(commits);
    scratch.wipeAll();
  });

  it('refuses a tampered Local Config as a Master Key mismatch, writing nothing', async () => {
    const { session, store, words } = await create();
    session.lock();
    const config = parseLocalConfig(store.localConfig);
    const encrypted = { ...config.encrypted, c: config.encrypted.c.slice() };
    encrypted.c[0] = (encrypted.c[0] ?? 0) ^ 1;
    store.localConfig = encodeCbor(localConfigToCbor({ ...config, encrypted }));
    const commits = store.commits.length;
    expect(await rejection(reset(store, words))).toBe('master-key-mismatch');
    expect(store.commits).toHaveLength(commits);
  });

  it('resets while the vault is read-only because the clock went back (D73)', async () => {
    const clock = new Clock();
    clock.t = T0 + 3 * DAY;
    const { session, store, words } = await create(clock);
    await session.createItem(login());
    session.lock();
    clock.t = T0;
    const { session: again } = await reset(store, words, clock);
    expect(again.writable).toBe(false);
    again.lock();
    expect((await unlock(store, clock, 2)).writable).toBe(false);
  });

  it('keeps the passkey, which wraps the same Master Key (D172, D184)', async () => {
    const { session, store, keyring, words } = await create();
    await session.setPasskey({
      current: kek(keyring),
      prfKek: kek(keyring, 3),
      credentialId: new Uint8Array([1]),
      prfInput: new Uint8Array(32).fill(5),
    });
    const vaultId = session.vaultId;
    session.lock();
    await reset(store, words);
    expect(parseLocalConfig(store.localConfig).prf?.credentialId).toEqual(new Uint8Array([1]));
    expect((await unlock(store, new Clock(), 3, 'passkey')).vaultId).toEqual(vaultId);
  });

  it('refuses KDF parameters or a salt out of range before opening anything', async () => {
    const { session, store, words } = await create();
    session.lock();
    const keyring = new Keyring();
    await expect(
      VaultSession.resetPassword({
        store,
        localConfig: parseLocalConfig(store.localConfig),
        keyring,
        entropy: parseRecoveryPhrase(keyring, words),
        kek: kek(keyring, 2),
        salt: new Uint8Array(15),
        kdfParams: PARAMS,
      }),
    ).rejects.toThrow(RangeError);
    expect(keyring.wiped).toBe(true);
    const other = new Keyring();
    await expect(
      VaultSession.resetPassword({
        store,
        localConfig: parseLocalConfig(store.localConfig),
        keyring: other,
        entropy: parseRecoveryPhrase(other, words),
        kek: kek(other, 2),
        salt: SALT,
        kdfParams: { opslimit: 1, memlimit: MEMLIMIT },
      }),
    ).rejects.toThrow(KdfParamsRejectedError);
  });

  it('persists no phrase and no key (CRYPTO-INV-006)', async () => {
    const { session, store, words } = await create();
    session.lock();
    await reset(store, words);
    const bytes = [store.localConfig, ...(await store.records()).map((r) => r.envelope)];
    for (const needle of phraseTraces(words)) {
      expect(bytes.some((b) => contains(b, utf8(needle)))).toBe(false);
    }
  });
});

describe('backup merge (§10, D13, D57, D64, D182)', () => {
  /** A vault created at T0 with one item, and a second device of it made by a fresh restore. */
  async function twoDevices() {
    const clockA = new Clock();
    const a = await create(clockA);
    const id = await a.session.createItem(login('Original'));
    const file = await a.session.exportBackup({ kek: kek(a.keyring), method: 'password' });
    const clockB = new Clock();
    const keyring = new Keyring();
    const store = new MemoryStore();
    const session = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(file.bytes), a.words),
      now: clockB.now,
    });
    open.push(session);
    return { a, clockA, b: { session, store, keyring, clock: clockB }, id };
  }

  /** A backup of `session`, validated with the phrase as `packages/backup` does. */
  async function backupOf(session: VaultSession, seed: number, words: string) {
    const keyring = new Keyring();
    const file = await session.exportBackup({ kek: kek(keyring, seed), method: 'password' });
    return restoreWithPhrase(keyring, parseBackup(file.bytes), words);
  }

  /** The records of `store` as a validated backup would hold them, with the vault's Master Key. */
  async function rawBackup(store: MemoryStore, seed = 1) {
    const keys = keysOf(store, seed);
    return { vaultId: keys.vaultId, masterKey: keys.masterKey, records: await store.records() };
  }

  function plantEnvelope(
    store: MemoryStore,
    keys: Keys,
    hlc: Hlc,
    envelopeKey: SymmetricKey,
    metadata: CborMap,
  ): void {
    const recordId = recoveryEnvelopeRecordId(keys.vaultId);
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.recoveryEnvelope,
      recordId,
      keyEpoch: 1,
      hlc,
      deleted: false,
    };
    store.put({
      recordType: RecordType.recoveryEnvelope,
      recordId,
      envelope: sealRecoveryEnvelope(
        header,
        keys.vaultId,
        keys.vaultKey,
        envelopeKey,
        keys.masterKey,
        metadata,
      ),
    });
  }

  function titles(session: VaultSession, id: Uint8Array) {
    return session.versions(id).map((v) => v.item?.title);
  }

  it('takes a newer edit from the backup and keeps the local one in history (Gate B)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    clockA.t = T0 + 1000;
    await a.session.updateItem(id, login('Edited on A'));
    b.clock.t = T0 + 2000;
    await b.session.updateItem(id, login('Edited on B'));
    const backup = await backupOf(b.session, 2, a.words);
    const commits = a.store.commits.length;

    const result = await a.session.mergeBackup(backup);
    expect(result).toMatchObject({ added: 0, replaced: 1, versions: 1, phraseChanged: false });
    expect(a.session.item(id)?.item?.title).toBe('Edited on B');
    expect(titles(a.session, id)).toEqual(['Edited on A', 'Original']);
    expect(a.store.commits).toHaveLength(commits + 1);

    a.session.lock();
    const again = await unlock(a.store, clockA);
    expect(again.item(id)?.item?.title).toBe('Edited on B');
    expect(titles(again, id)).toEqual(['Edited on A', 'Original']);
    // The receive rule (D109): a write after the merge takes an HLC above every merged one.
    const next = await again.createItem(login('After'));
    expect(must(again.item(next)).hlc.physicalMs).toBe(T0 + 2000);
    expect(must(again.item(next)).hlc.counter).toBeGreaterThan(0);
  });

  it('keeps a newer local edit and stores the backup’s older one as an Item Version (D6)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    b.clock.t = T0 + 1000;
    await b.session.updateItem(id, login('Edited on B'));
    clockA.t = T0 + 2000;
    await a.session.updateItem(id, login('Edited on A'));
    const loser = must(b.session.item(id)).hlc;

    const result = await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(result).toMatchObject({ added: 0, replaced: 0, versions: 1 });
    expect(a.session.item(id)?.item?.title).toBe('Edited on A');
    expect(titles(a.session, id)).toEqual(['Edited on B', 'Original']);
    expect(a.session.versions(id)[0]?.hlc).toEqual(loser);
  });

  it('stores a losing tombstone as an Item Version of its content, not deleted (D56)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    b.clock.t = T0 + 1000;
    await b.session.trashItem(id);
    clockA.t = T0 + 2000;
    await a.session.updateItem(id, login('Edited on A'));

    await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(a.session.item(id)?.inTrash).toBe(false);
    const [version] = a.session.versions(id);
    expect(version?.hlc).toEqual(must(b.session.item(id)).hlc);
    expect(version?.item?.trashOperationId).toBeDefined();
    const stored = a.store.get({
      recordType: RecordType.itemVersion,
      recordId: must(version).versionId,
    });
    expect(decodeEnvelope((stored as { envelope: Uint8Array }).envelope).header.deleted).toBe(
      false,
    );
  });

  it('purges a winning tombstone past its purge date on arrival, with its history, naming the own loser (D7, D70, D137)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    clockA.t = T0 + 500;
    await a.session.updateItem(id, login('Edited on A'));
    b.clock.t = T0 + 1000;
    await b.session.trashItem(id);
    const backup = await backupOf(b.session, 2, a.words);

    clockA.t = T0 + 1000 + PURGE_DELAY_MS + 1;
    const result = await a.session.mergeBackup(backup);
    expect(result.droppedLosers).toEqual([{ itemId: id, title: 'Edited on A' }]);
    expect(a.session.item(id)).toBeUndefined();
    expect(a.session.versions(id)).toEqual([]);
    const stored = must(a.store.get({ recordType: RecordType.item, recordId: id }));
    const { header } = decodeEnvelope(stored.envelope);
    expect(header.deleted).toBe(true);
    expect(header.hlc).toEqual(must(b.session.item(id)).hlc);
    expect(a.store.ofType(RecordType.itemVersion)).toEqual([]);
  });

  it('keeps the versions of a restore from the trash at a device that purged the item (D137)', async () => {
    vi.useFakeTimers();
    const { a, clockA, b, id } = await twoDevices();
    clockA.t = T0 + 1000;
    await a.session.updateItem(id, login('Edited on A'));
    await a.session.trashItem(id);
    await b.session.mergeBackup(await backupOf(a.session, 1, a.words));
    clockA.t = T0 + 29 * DAY;
    await a.session.restoreItem(id);
    b.clock.t = T0 + 31 * DAY;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
    expect(b.session.item(id)).toBeUndefined();
    expect(b.store.ofType(RecordType.itemVersion)).toEqual([]);

    const result = await b.session.mergeBackup(await backupOf(a.session, 1, a.words));
    expect(result.droppedLosers).toEqual([]);
    expect(b.session.item(id)).toMatchObject({ inTrash: false, item: { title: 'Edited on A' } });
    const history = (s: VaultSession) => s.versions(id).map((v) => [v.hlc, v.item?.title]);
    expect(a.session.versions(id)).toHaveLength(3);
    expect(history(b.session)).toEqual(history(a.session));
  });

  it('applies the history cut across held, received and losing versions, naming an own loser cut (D6, D70)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    clockA.t = T0 + 1;
    await a.session.updateItem(id, login('Edited on A'));
    for (let i = 0; i <= HISTORY_LIMIT; i++) {
      b.clock.t = T0 + 100 + i;
      await b.session.updateItem(id, login(`B ${String(i)}`));
    }
    const result = await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(result.droppedLosers).toEqual([{ itemId: id, title: 'Edited on A' }]);
    expect(a.session.versions(id)).toHaveLength(HISTORY_LIMIT);
    expect(titles(a.session, id)).not.toContain('Edited on A');
    expect(titles(a.session, id)).not.toContain('Original');
    expect(a.store.ofType(RecordType.itemVersion)).toHaveLength(HISTORY_LIMIT);
  });

  it('reports no loser written by another device when the cut drops it (D70)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    b.clock.t = T0 + 1;
    await b.session.updateItem(id, login('Edited on B'));
    for (let i = 0; i <= HISTORY_LIMIT; i++) {
      clockA.t = T0 + 100 + i;
      await a.session.updateItem(id, login(`A ${String(i)}`));
    }
    const result = await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(result.droppedLosers).toEqual([]);
    expect(titles(a.session, id)).not.toContain('Edited on B');
    expect(a.session.versions(id)).toHaveLength(HISTORY_LIMIT);
  });

  it('merges folders by last-write-wins and adds what only the backup holds', async () => {
    const { a, clockA, b } = await twoDevices();
    const folder = await a.session.createFolder('Work');
    const older = await backupOf(a.session, 1, a.words);
    await b.session.mergeBackup(older);
    clockA.t = T0 + 1000;
    await a.session.renameFolder(folder, 'A name');
    b.clock.t = T0 + 2000;
    await b.session.renameFolder(folder, 'B name');
    const added = await b.session.createItem(login('Only on B'));

    const result = await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(result).toMatchObject({ added: 1, replaced: 1, versions: 0 });
    expect(a.session.folder(folder)?.name).toBe('B name');
    expect(a.session.item(added)?.item?.title).toBe('Only on B');
    expect(a.store.ofType(RecordType.itemVersion)).toHaveLength(0);
    // An older copy loses, and is dropped: folders have no history.
    expect(await a.session.mergeBackup(older)).toMatchObject({
      added: 0,
      replaced: 0,
      versions: 0,
    });
    expect(a.session.folder(folder)?.name).toBe('B name');
  });

  it('lets a retired Device record win whatever its HLC, and reports new and retired devices (D31, D47, D48, D53)', async () => {
    const { a, b } = await twoDevices();
    const keys = keysOf(a.store);
    const keyring = new Keyring();
    const fresh = generateDeviceIdentity(keyring);
    const gone = generateDeviceIdentity(keyring);
    const device = (publicKey: Uint8Array, displayName: string, retired: boolean) =>
      deviceToCbor({ publicKey, displayName, retired, registeredAt: T0 });
    plant(
      a.store,
      keys,
      RecordType.device,
      fresh.deviceId,
      hlcAt(T0 + 10),
      false,
      device(fresh.publicKey, 'Phone', false),
    );
    plant(
      a.store,
      keys,
      RecordType.device,
      gone.deviceId,
      hlcAt(T0 + 11),
      false,
      device(gone.publicKey, 'Old laptop', true),
    );
    // An older retired copy of A's own record: retirement wins anyway (D31).
    plant(
      a.store,
      keys,
      RecordType.device,
      a.session.deviceId,
      hlcAt(T0 - 1),
      false,
      device(must(a.session.devices()[0]).device.publicKey, 'Chrome on macOS', true),
    );

    const result = await b.session.mergeBackup(await rawBackup(a.store));
    expect(result.newDevices.map((d) => [d.device.displayName, d.device.retired])).toEqual(
      expect.arrayContaining([
        ['Phone', false],
        ['Old laptop', true],
      ]),
    );
    expect(result.newDevices).toHaveLength(2);
    expect(result.retiredDevices.map((d) => d.deviceId)).toEqual([a.session.deviceId]);
    expect(b.session.retired).toBe(false);

    // The same backup again announces nothing: everything in it is now seen.
    const again = await b.session.mergeBackup(await rawBackup(a.store));
    expect(again).toMatchObject({ added: 0, replaced: 0, newDevices: [], retiredDevices: [] });

    // A's own record arrives retired: the D41 notice, not the D47 one.
    const own = await a.session.mergeBackup(await rawBackup(a.store));
    expect(own.retiredDevices).toEqual([]);
    expect(a.session.retired).toBe(true);
  });

  it('records every device as seen without a notice when none was held before (D48, D53)', async () => {
    const source = await create();
    const keyring = new Keyring();
    const store = new MemoryStore();
    const keys = keysOf(source.store);
    const session = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: {
        vaultId: keys.vaultId,
        masterKey: keys.masterKey,
        records: (await source.store.records()).filter((r) => r.recordType !== RecordType.device),
      },
      now: new Clock().now,
    });
    open.push(session);
    expect(session.devices()).toEqual([]);
    const result = await session.mergeBackup(await rawBackup(source.store));
    expect(result.newDevices).toEqual([]);
    expect(session.devices()).toHaveLength(1);
  });

  it('records seen devices and the last phraseId in Local Config: at fresh restore (D53) and at merge', async () => {
    const { a, b } = await twoDevices();
    const seen = (store: MemoryStore, seed: number) => {
      const keys = keysOf(store, seed);
      const config = parseLocalConfig(store.localConfig);
      const opened = openLocalConfigPart(
        new Keyring(),
        keys.subkeys.localConfig,
        localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
        config.encrypted,
      );
      return readLocalConfigState(opened.content);
    };
    expect(seen(b.store, 2).seenDevices).toEqual([a.session.deviceId]);
    expect(seen(b.store, 2).seenRetiredDevices).toBeUndefined();
    expect(seen(a.store, 1).seenDevices).toBeUndefined();
    await a.session.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(seen(a.store, 1).seenDevices).toEqual([a.session.deviceId]);
    expect(seen(a.store, 1).lastPhraseId).toEqual(a.session.recovery?.phraseId);
  });

  it('takes a newer Recovery Envelope with another phraseId and reports the change (D43)', async () => {
    const { a, b } = await twoDevices();
    const keys = keysOf(a.store);
    const keyring = new Keyring();
    const recovery = deriveRecoveryKeys(keyring, generateRecoveryPhrase(keyring).entropy);
    const phraseId = randomId();
    const metadata = new Map<CborValue, CborValue>([
      ['keyslotPublicKey', recovery.keyslotPublicKey],
      ['phraseCreatedAt', T0 + 5000],
      ['phraseId', phraseId],
    ]);
    plantEnvelope(a.store, keys, hlcAt(T0 + 5000), recovery.envelopeKey, metadata);

    const result = await b.session.mergeBackup(await rawBackup(a.store));
    expect(result.phraseChanged).toBe(true);
    expect(result.replaced).toBe(1);
    expect(b.session.recovery?.phraseId).toEqual(phraseId);
    expect(b.session.lastPhraseId).toEqual(phraseId);
    // The envelope replaced was written by A, not by this device: no D145 warning.
    expect(result.phraseSuperseded).toBeUndefined();
    expect((await b.session.mergeBackup(await rawBackup(a.store))).phraseChanged).toBe(false);
  });

  it('warns that the phrase this device wrote was superseded, in place of the D43 notice (D145, D185)', async () => {
    const { a, b } = await twoDevices();
    // A wrote the envelope at creation; B regenerates later, so B's envelope wins.
    const replaced = must(a.session.recovery);
    b.clock.t = T0 + 5000;
    const phrase = generateRecoveryPhrase(new Keyring());
    const caller = new Keyring();
    const next = await b.session.regenerateRecoveryPhrase({
      kek: kek(caller, 2),
      method: 'password',
      entropy: phrase.entropy,
    });
    caller.wipeAll();

    const result = await a.session.mergeBackup(await backupOf(b.session, 2, phrase.words));
    expect(result.phraseSuperseded).toEqual({
      phraseId: replaced.phraseId,
      phraseCreatedAt: replaced.phraseCreatedAt,
    });
    expect(result.phraseChanged).toBe(false);
    expect(a.session.recovery).toEqual(next);
    expect(a.session.lastPhraseId).toEqual(next.phraseId);
    // Once merged, the envelope held is B's: a second merge warns of nothing.
    const again = await a.session.mergeBackup(await backupOf(b.session, 2, phrase.words));
    expect(again.phraseSuperseded).toBeUndefined();
    expect(again.phraseChanged).toBe(false);
  });

  it('keeps the phrase this device wrote against an older envelope of another phraseId (D185)', async () => {
    const { a, b } = await twoDevices();
    b.clock.t = T0 + 5000;
    const phrase = generateRecoveryPhrase(new Keyring());
    const caller = new Keyring();
    const kept = await b.session.regenerateRecoveryPhrase({
      kek: kek(caller, 2),
      method: 'password',
      entropy: phrase.entropy,
    });
    caller.wipeAll();
    // A's envelope, from creation, is older: B keeps its own and is told nothing.
    const result = await b.session.mergeBackup(await backupOf(a.session, 1, a.words));
    expect(result.phraseSuperseded).toBeUndefined();
    expect(result.phraseChanged).toBe(false);
    expect(b.session.recovery).toEqual(kept);
  });

  it('rejects the whole merge for a Recovery Envelope changed under the held phraseId (D44)', async () => {
    const { a, b } = await twoDevices();
    const keys = keysOf(a.store);
    const held = must(a.session.recovery);
    const phrase = typed(a.words);
    const metadata = new Map<CborValue, CborValue>([
      ['keyslotPublicKey', held.keyslotPublicKey],
      ['phraseCreatedAt', held.phraseCreatedAt],
      ['phraseId', held.phraseId],
    ]);
    plantEnvelope(a.store, keys, hlcAt(T0 + 5000), phrase.envelopeKey, metadata);
    await b.session.createItem(login('Kept'));
    const commits = b.store.commits.length;

    const error = await b.session.mergeBackup(await rawBackup(a.store)).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(MergeRejectedError);
    expect(error).toMatchObject({
      reason: 'immutable-record',
      record: {
        recordType: RecordType.recoveryEnvelope,
        recordId: recoveryEnvelopeRecordId(keys.vaultId),
      },
    });
    expect(b.store.commits).toHaveLength(commits);
    expect(b.session.recovery).toEqual(held);
  });

  it('rejects the whole merge for another version of a held Vault Key record (D42)', async () => {
    const { a } = await twoDevices();
    const keys = keysOf(a.store);
    const keyring = new Keyring();
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.vaultKey,
      recordId: vaultKeyRecordId(1),
      keyEpoch: 1,
      hlc: hlcAt(T0 + 10),
      deleted: false,
    };
    const forged = {
      recordType: RecordType.vaultKey,
      recordId: vaultKeyRecordId(1),
      envelope: sealVaultKeyRecord(
        header,
        keys.vaultId,
        keys.subkeys.vaultKeyWrap,
        generateKey(keyring),
      ),
    };
    const size = a.keyring.size;
    const error = await a.session
      .mergeBackup({ vaultId: keys.vaultId, masterKey: keys.masterKey, records: [forged] })
      .catch((e: unknown) => e);
    expect(error).toMatchObject({
      reason: 'immutable-record',
      record: { recordType: RecordType.vaultKey, recordId: vaultKeyRecordId(1) },
    });
    // The Vault Key it carried is not kept (CRYPTO-INV-010).
    expect(a.keyring.size).toBe(size);
  });

  it('adds a Vault Key record of an epoch not held, and holds its key once committed (sync-protocol.md §1.3)', async () => {
    const { a, clockA } = await twoDevices();
    const keys = keysOf(a.store);
    const keyring = new Keyring();
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.vaultKey,
      recordId: vaultKeyRecordId(2),
      keyEpoch: 2,
      hlc: hlcAt(T0 + 10),
      deleted: false,
    };
    const record = {
      recordType: RecordType.vaultKey,
      recordId: vaultKeyRecordId(2),
      envelope: sealVaultKeyRecord(
        header,
        keys.vaultId,
        keys.subkeys.vaultKeyWrap,
        generateKey(keyring),
      ),
    };
    const result = await a.session.mergeBackup({
      vaultId: keys.vaultId,
      masterKey: keys.masterKey,
      records: [record],
    });
    expect(result).toMatchObject({ added: 1, replaced: 0 });
    expect(a.store.get({ recordType: RecordType.vaultKey, recordId: vaultKeyRecordId(2) })).toEqual(
      record,
    );
    // New records go under the greatest epoch held, and still open after a new unlock.
    const id = await a.session.createItem(login('Under epoch 2'));
    const stored = must(a.store.get({ recordType: RecordType.item, recordId: id }));
    expect(decodeEnvelope(stored.envelope).header.keyEpoch).toBe(2);
    a.session.lock();
    const again = await unlock(a.store, clockA);
    expect(again.item(id)?.item?.title).toBe('Under epoch 2');
  });

  it('rejects another vault’s backup and a backup with another Master Key, writing nothing (D13, D57)', async () => {
    const { a } = await twoDevices();
    const other = await create();
    const commits = a.store.commits.length;
    await expect(a.session.mergeBackup(await rawBackup(other.store))).rejects.toMatchObject({
      reason: 'different-vault',
    });
    const keyring = new Keyring();
    await expect(
      a.session.mergeBackup({
        vaultId: a.session.vaultId,
        masterKey: generateKey(keyring),
        records: await other.store.records(),
      }),
    ).rejects.toMatchObject({ reason: 'master-key-mismatch' });
    expect(a.store.commits).toHaveLength(commits);
    expect(new MergeRejectedError('different-vault').message).toBe(
      'merge rejected: different-vault',
    );
  });

  it('rejects the whole merge for a record that fails verification or the content checks, naming it (D59, D64)', async () => {
    const { a, b } = await twoDevices();
    const keys = keysOf(a.store);
    const folderId = randomId();
    plant(
      a.store,
      keys,
      RecordType.folder,
      folderId,
      hlcAt(T0),
      false,
      new Map<CborValue, CborValue>([['name', 7]]),
    );
    await expect(b.session.mergeBackup(await rawBackup(a.store))).rejects.toMatchObject({
      reason: 'corrupt-record',
      record: { recordType: RecordType.folder, recordId: folderId },
    });
    expect(b.session.folder(folderId)).toBeUndefined();
  });

  it('rejects the whole merge for a record beyond the future-clock bound, saying when to retry (D64, CRYPTO-INV-022)', async () => {
    const { a, b, id } = await twoDevices();
    const keys = keysOf(a.store);
    const ahead = randomId();
    plant(
      a.store,
      keys,
      RecordType.item,
      ahead,
      hlcAt(T0 + 3 * DAY),
      false,
      itemToCbor(login('Ahead'), false),
    );
    await b.session.updateItem(id, login('Kept on B'));
    const commits = b.store.commits.length;
    const error = await b.session.mergeBackup(await rawBackup(a.store)).catch((e: unknown) => e);
    expect(error).toMatchObject({
      reason: 'future-clock',
      retryAt: T0 + 3 * DAY - FUTURE_CLOCK_BOUND_MS,
    });
    expect(b.store.commits).toHaveLength(commits);
    expect(b.session.item(ahead)).toBeUndefined();
    expect(b.session.item(id)?.item?.title).toBe('Kept on B');
  });

  it('repairs a record kept aside as corrupt at unlock with the backup’s copy (D182)', async () => {
    const { a, clockA, id } = await twoDevices();
    clockA.t = T0 + 1000;
    await a.session.updateItem(id, login('Edited'));
    const backup = await backupOf(a.session, 1, a.words);
    const key = { recordType: RecordType.item, recordId: id };
    const versionKey = {
      recordType: RecordType.itemVersion,
      recordId: must(a.session.versions(id)[0]).versionId,
    };
    const stored = must(a.store.get(key));
    for (const k of [key, versionKey]) {
      const record = must(a.store.get(k));
      const tampered = record.envelope.slice();
      const last = tampered.length - 1;
      tampered[last] = (tampered[last] ?? 0) ^ 1;
      a.store.put({ ...record, envelope: tampered as typeof record.envelope });
    }
    a.session.lock();
    const damaged = await unlock(a.store, clockA);
    expect(damaged.corrupt()).toEqual(expect.arrayContaining([key, versionKey]));

    const result = await damaged.mergeBackup(backup);
    expect(result).toMatchObject({ added: 0, replaced: 2, versions: 1 });
    expect(damaged.corrupt()).toEqual([]);
    expect(damaged.item(id)?.item?.title).toBe('Edited');
    expect(titles(damaged, id)).toEqual(['Original']);
    expect(must(a.store.get(key)).envelope).toEqual(stored.envelope);
  });

  it('merges while the vault is read-only because the clock went back, issuing no HLC (D73)', async () => {
    const { a, clockA, b, id } = await twoDevices();
    b.clock.t = T0 + 1000;
    await b.session.updateItem(id, login('Edited on B'));
    clockA.t = T0 + 5 * DAY;
    await a.session.createItem(login('Written ahead'));
    clockA.t = T0 + 2000;
    a.session.lock();
    const behind = await unlock(a.store, clockA);
    expect(behind.writable).toBe(false);

    await behind.mergeBackup(await backupOf(b.session, 2, a.words));
    expect(behind.item(id)?.item?.title).toBe('Edited on B');
    expect(titles(behind, id)).toEqual(['Original']);
    expect(behind.writable).toBe(false);
  });

  it('changes no record when merging a backup of the same state', async () => {
    const { a } = await twoDevices();
    const result = await a.session.mergeBackup(await backupOf(a.session, 1, a.words));
    expect(result).toEqual({
      added: 0,
      replaced: 0,
      versions: 0,
      phraseChanged: false,
      newDevices: [],
      retiredDevices: [],
      droppedLosers: [],
    });
    expect(a.store.commits.at(-1)?.put).toEqual([]);
  });

  it('refuses a merge once locked, and leaves no Vault Key of the backup behind', async () => {
    const { a, b } = await twoDevices();
    const backup = await backupOf(b.session, 2, a.words);
    a.session.lock();
    await expect(a.session.mergeBackup(backup)).rejects.toThrow(VaultLockedError);
  });
});

describe('items and history (D6, D165)', () => {
  it('stores the previous state as an Item Version with its hlc and keyed versionId', async () => {
    const { session, store, clock } = await create();
    const id = await session.createItem(login());
    const before = session.item(id);
    clock.t += 1000;
    expect(await session.updateItem(id, login('Renamed'))).toBe(true);

    const after = await unlock(store, clock);
    expect(after.item(id)?.item?.title).toBe('Renamed');
    const [version, ...rest] = after.versions(id);
    expect(rest).toEqual([]);
    expect(version?.hlc).toEqual(before?.hlc);
    expect(version?.item?.title).toBe('Example');
    const keys = keysOf(store);
    expect(version?.versionId).toEqual(versionId(keys.subkeys.versionId, id, must(before).hlc));
    const stored = store.get({
      recordType: RecordType.itemVersion,
      recordId: must(version).versionId,
    });
    const { header } = decodeEnvelope((stored as { envelope: Uint8Array }).envelope);
    expect(header.hlc).toEqual(before?.hlc);
    expect(header.deleted).toBe(false);
    expect(after.item(id)?.hlc.physicalMs).toBe(T0 + 1000);
  });

  it('writes nothing and issues no HLC when the content is unchanged', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const hlc = session.item(id)?.hlc;
    const commits = store.commits.length;
    expect(await session.updateItem(id, login())).toBe(false);
    expect(store.commits).toHaveLength(commits);
    expect(session.item(id)?.hlc).toEqual(hlc);
    expect(session.versions(id)).toEqual([]);
  });

  it('treats a move as an edit that stores a version', async () => {
    const { session } = await create();
    const id = await session.createItem(login());
    const folderId = await session.createFolder('Work');
    expect(await session.updateItem(id, { ...login(), folderId })).toBe(true);
    expect(session.item(id)?.item?.folderId).toEqual(folderId);
    expect(session.versions(id)[0]?.item?.folderId).toBeUndefined();
    await session.updateItem(id, login());
    expect(session.item(id)?.item?.folderId).toBeUndefined();
    expect(session.versions(id)).toHaveLength(2);
  });

  it(`keeps the ${String(HISTORY_LIMIT)} greatest versions per item`, async () => {
    const { session, store } = await create();
    const id = await session.createItem(login('v0'));
    const hlcs: Hlc[] = [];
    for (let i = 1; i <= 25; i++) {
      hlcs.push(must(session.item(id)).hlc);
      await session.updateItem(id, login(`v${String(i)}`));
    }
    const versions = session.versions(id);
    expect(versions.map((v) => v.item?.title)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, i) => `v${String(24 - i)}`),
    );
    expect(versions.map((v) => v.hlc)).toEqual(hlcs.slice(5).reverse());
    expect(store.ofType(RecordType.itemVersion)).toHaveLength(HISTORY_LIMIT);
    expect((await unlock(store)).versions(id)).toHaveLength(HISTORY_LIMIT);
  });

  it('trashes under a trashOperationId and restores without it, storing both states', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    await session.trashItem(id);
    const trashed = session.item(id);
    expect(trashed?.inTrash).toBe(true);
    expect(trashed?.purgeAt).toBe((trashed?.hlc.physicalMs ?? 0) + PURGE_DELAY_MS);
    const trashOperationId = trashed?.item?.trashOperationId;
    expect(trashOperationId).toHaveLength(16);
    const record = store.get({ recordType: RecordType.item, recordId: id });
    expect(decodeEnvelope((record as { envelope: Uint8Array }).envelope).header.deleted).toBe(true);

    await expect(session.updateItem(id, login('Edited'))).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    await expect(session.trashItem(id)).rejects.toThrow(new RecordBlockedError('in-trash'));

    await session.restoreItem(id);
    const restored = session.item(id);
    expect(restored?.inTrash).toBe(false);
    expect(restored?.purgeAt).toBeUndefined();
    expect(restored?.item?.trashOperationId).toBeUndefined();
    const [ofTrashed, ofLive] = session.versions(id);
    expect(ofTrashed?.item?.trashOperationId).toEqual(trashOperationId);
    expect(ofLive?.item?.trashOperationId).toBeUndefined();
    await expect(session.restoreItem(id)).rejects.toThrow(new RecordBlockedError('not-in-trash'));
  });

  it('restores an item under a parent folder in the trash to the vault root (D112)', async () => {
    const { session } = await create();
    const old = await session.createFolder('Old');
    const work = await session.createFolder('Work');
    const a = await session.createItem({ ...login('a'), folderId: old });
    const b = await session.createItem({ ...login('b'), folderId: work });
    for (const id of [a, b]) await session.trashItem(id);
    await session.trashFolder(old);
    for (const id of [a, b]) await session.restoreItem(id);
    expect(session.item(a)?.item?.folderId).toBeUndefined();
    expect(session.item(b)?.item?.folderId).toEqual(work);
  });

  it('restores a version as a new state, dropping a trashed state’s trashOperationId', async () => {
    const { session } = await create();
    const id = await session.createItem(login('First'));
    await session.updateItem(id, login('Second'));
    const [first] = session.versions(id);
    expect(await session.restoreVersion(id, must(first).versionId)).toBe(true);
    expect(session.item(id)?.item?.title).toBe('First');
    expect(session.versions(id).map((v) => v.item?.title)).toEqual(['Second', 'First']);
    expect(await session.restoreVersion(id, must(first).versionId)).toBe(false);

    await session.trashItem(id);
    const [latest] = session.versions(id);
    await expect(session.restoreVersion(id, must(latest).versionId)).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    await session.restoreItem(id);
    const trashedState = session.versions(id).find((v) => v.item?.trashOperationId);
    expect(trashedState?.item?.title).toBe('First');
    await session.updateItem(id, login('Third'));
    expect(await session.restoreVersion(id, must(trashedState).versionId)).toBe(true);
    const current = session.item(id);
    expect(current?.item?.title).toBe('First');
    expect(current?.item?.trashOperationId).toBeUndefined();
    expect(current?.inTrash).toBe(false);
    await expect(session.restoreVersion(id, randomId())).rejects.toThrow(RecordNotFoundError);
  });

  it('refuses an item above the item cap and invalid content, issuing no HLC', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const hlc = session.item(id)?.hlc;
    const commits = store.commits.length;
    const huge = { ...login(), notes: 'x'.repeat(1_048_576) };
    await expect(session.createItem(huge)).rejects.toThrow(new ContentInvalidError('item cap'));
    await expect(session.updateItem(id, huge)).rejects.toThrow(new ContentInvalidError('item cap'));
    await expect(session.createItem(login(''))).rejects.toThrow(ContentInvalidError);
    await expect(session.updateItem(id, login(' padded'))).rejects.toThrow(ContentInvalidError);
    expect(store.commits).toHaveLength(commits);
    await session.updateItem(id, login('Next'));
    const next = session.item(id)?.hlc;
    expect(next?.physicalMs).toBe(hlc?.physicalMs);
    expect(next?.counter).toBe((hlc?.counter ?? 0) + 1);
  });

  it('reads an Item Version holding a key from a newer app version as read-only', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const keys = keysOf(store);
    const hlc = hlcAt(T0 - 5);
    plant(
      store,
      keys,
      RecordType.itemVersion,
      versionId(keys.subkeys.versionId, id, hlc),
      hlc,
      false,
      new Map<CborValue, CborValue>([
        ['item', itemToCbor(login(), false)],
        ['itemId', id],
        ['reason', 'conflict'],
      ]),
    );
    session.lock();
    const [version] = (await unlock(store)).versions(id);
    expect(version).toMatchObject({ readOnly: 'newer-content', readOnlyRule: 1 });
  });

  it('writes no second Item Version of a state already held', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const current = must(session.item(id)).hlc;
    const keys = keysOf(store);
    plant(
      store,
      keys,
      RecordType.itemVersion,
      versionId(keys.subkeys.versionId, id, current),
      current,
      false,
      new Map<CborValue, CborValue>([
        ['item', itemToCbor(login(), false)],
        ['itemId', id],
      ]),
    );
    session.lock();
    const s = await unlock(store);
    await s.updateItem(id, login('Next'));
    expect(must(store.commits.at(-1)).put.map((p) => p.recordType)).toEqual([RecordType.item]);
    expect(s.versions(id)).toHaveLength(1);
  });

  it('writes no Item Version that falls below the cut', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const keys = keysOf(store);
    for (let i = 1; i <= HISTORY_LIMIT; i++) {
      const hlc = hlcAt(T0 + i);
      plant(
        store,
        keys,
        RecordType.itemVersion,
        versionId(keys.subkeys.versionId, id, hlc),
        hlc,
        false,
        new Map<CborValue, CborValue>([
          ['item', itemToCbor(login(`v${String(i)}`), false)],
          ['itemId', id],
        ]),
      );
    }
    session.lock();
    const s = await unlock(store);
    const before = s.versions(id).map((v) => idKey(v.versionId));
    await s.updateItem(id, login('Next'));
    expect(must(store.commits.at(-1)).put.map((p) => p.recordType)).toEqual([RecordType.item]);
    expect(s.versions(id).map((v) => idKey(v.versionId))).toEqual(before);
  });

  it('refuses unknown items and versions', async () => {
    const { session } = await create();
    await expect(session.updateItem(randomId(), login())).rejects.toThrow(RecordNotFoundError);
    await expect(session.trashItem(randomId())).rejects.toThrow(RecordNotFoundError);
    expect(session.item(randomId())).toBeUndefined();
    expect(session.versions(randomId())).toEqual([]);
  });

  it('serializes concurrent operations', async () => {
    const { session } = await create();
    const id = await session.createItem(login('A'));
    await Promise.all([session.updateItem(id, login('B')), session.updateItem(id, login('C'))]);
    expect(session.item(id)?.item?.title).toBe('C');
    expect(session.versions(id).map((v) => v.item?.title)).toEqual(['B', 'A']);
  });

  it('leaves the state unchanged when a commit fails', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login('A'));
    store.failNext = true;
    await expect(session.updateItem(id, login('B'))).rejects.toThrow('storage failure');
    expect(session.item(id)?.item?.title).toBe('A');
    expect(session.versions(id)).toEqual([]);
    expect(await session.updateItem(id, login('B'))).toBe(true);
    expect((await unlock(store)).item(id)?.item?.title).toBe('B');
  });
});

function folder(name: string, trashed: boolean): CborMap {
  const map: CborMap = new Map<CborValue, CborValue>([['name', name]]);
  if (trashed) map.set('trashOperationId', randomId());
  return map;
}

describe('devices and retirement (§8.4, D30, D41, D74, D85, D186)', () => {
  /** A Device record of another device, planted as a sync would deliver it. */
  function plantDevice(
    store: MemoryStore,
    hlc: Hlc,
    options: { displayName?: string; retired?: boolean; extra?: boolean } = {},
  ) {
    const identity = generateDeviceIdentity(new Keyring());
    const content = deviceToCbor({
      publicKey: identity.publicKey,
      displayName: options.displayName ?? 'Phone',
      retired: options.retired ?? false,
      registeredAt: T0 - DAY,
    });
    if (options.extra) content.set('color', 'red');
    plant(store, keysOf(store), RecordType.device, identity.deviceId, hlc, false, content);
    return identity.deviceId;
  }

  /** The decrypted Local Config state of `store`, opened as its device does. */
  function localState(store: MemoryStore, seed = 1) {
    const keys = keysOf(store, seed);
    const config = parseLocalConfig(store.localConfig);
    const opened = openLocalConfigPart(
      new Keyring(),
      keys.subkeys.localConfig,
      localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
      config.encrypted,
    );
    return readLocalConfigState(opened.content);
  }

  function deviceOf(session: VaultSession, id: Uint8Array) {
    return session.devices().find((d) => idKey(d.deviceId) === idKey(id));
  }

  /** A fresh restore of `source`: an unregistered device (D30). */
  async function restored(source: Awaited<ReturnType<typeof create>>, clock = new Clock()) {
    const file = await source.session.exportBackup({
      kek: kek(source.keyring),
      method: 'password',
    });
    const keyring = new Keyring();
    const store = new MemoryStore();
    const session = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(file.bytes), source.words),
      now: clock.now,
    });
    open.push(session);
    return { session, store, clock };
  }

  it('is registered on the creator, not after a fresh restore (D30)', async () => {
    const source = await create();
    expect(source.session.registered).toBe(true);
    const { session } = await restored(source);
    expect(session.registered).toBe(false);
    expect(session.devices().map((d) => d.deviceId)).toEqual([source.session.deviceId]);
  });

  it('retires another device in one commit, keeping its name, date and unknown keys (D31, D59, D186)', async () => {
    const { store, clock } = await create();
    const phone = plantDevice(store, hlcAt(T0 + 10), { extra: true });
    const session = await unlock(store, clock);
    const commits = store.commits.length;
    const before = must(deviceOf(session, phone));

    await session.retireDevice(phone);
    expect(store.commits).toHaveLength(commits + 1);
    const [commit] = store.commits.slice(-1);
    expect(commit?.put.map((r) => [r.recordType, idKey(r.recordId)])).toEqual([
      [RecordType.device, idKey(phone)],
    ]);
    expect(commit?.delete).toEqual([]);
    const after = must(deviceOf(session, phone));
    expect(after.device).toEqual({ ...before.device, retired: true });
    expect(after.unknownKeys).toEqual(['color']);
    expect(compareHlc(after.hlc, before.hlc)).toBeGreaterThan(0);
    expect(after.hlc.deviceId).toEqual(session.deviceId);

    // As stored: another unlock reads it retired, with the unknown key kept.
    session.lock();
    const again = await unlock(store, clock);
    expect(deviceOf(again, phone)).toMatchObject({
      device: { retired: true, displayName: 'Phone' },
      unknownKeys: ['color'],
    });
  });

  it('records the retired device as seen-as-retired, so a merge of the same retirement shows no notice (D47, D186)', async () => {
    const source = await create();
    const phone = plantDevice(source.store, hlcAt(T0 + 10));
    const a = await unlock(source.store);
    const b = await restored({ ...source, session: a });
    expect(localState(b.store, 2).seenRetiredDevices).toBeUndefined();

    await b.session.retireDevice(phone);
    expect(localState(b.store, 2).seenRetiredDevices).toEqual([phone]);
    expect(localState(b.store, 2).seenDevices).toEqual(sortedHex([phone, source.session.deviceId]));

    await a.retireDevice(phone);
    const file = await a.exportBackup({ kek: kek(source.keyring), method: 'password' });
    const keyring = new Keyring();
    const result = await b.session.mergeBackup(
      restoreWithPhrase(keyring, parseBackup(file.bytes), source.words),
    );
    expect(result.retiredDevices).toEqual([]);
    expect(result.newDevices).toEqual([]);
    expect(deviceOf(b.session, phone)?.device.retired).toBe(true);
  });

  it('lets an unregistered device retire any record (D41)', async () => {
    const source = await create();
    const { session, store } = await restored(source);
    const commits = store.commits.length;
    await session.retireDevice(source.session.deviceId);
    expect(store.commits).toHaveLength(commits + 1);
    expect(deviceOf(session, source.session.deviceId)?.device.retired).toBe(true);
    expect(session.registered).toBe(false);
  });

  it('refuses its own record, a retired one, an unknown one and one kept aside as corrupt, writing nothing (D41, D186)', async () => {
    const { store, clock } = await create();
    const gone = plantDevice(store, hlcAt(T0 + 10), { retired: true });
    const broken = plantDevice(store, hlcAt(T0 + 11));
    const key = { recordType: RecordType.device, recordId: broken };
    const envelope = must(store.get(key)).envelope.slice() as RecordEnvelope;
    envelope[envelope.length - 1] = (envelope[envelope.length - 1] ?? 0) ^ 1;
    store.put({ ...key, envelope });
    const session = await unlock(store, clock);
    expect(session.corrupt()).toEqual([key]);
    const commits = store.commits.length;

    await expect(session.retireDevice(session.deviceId)).rejects.toThrow(
      new RetirementRefusedError('own-device'),
    );
    await expect(session.retireDevice(gone)).rejects.toThrow(
      new RetirementRefusedError('already-retired'),
    );
    await expect(session.retireDevice(randomId())).rejects.toThrow(RecordNotFoundError);
    await expect(session.retireDevice(broken)).rejects.toThrow(RecordNotFoundError);
    expect(store.commits).toHaveLength(commits);
    expect(session.retired).toBe(false);
  });

  it('retires a record beyond the future-clock bound, under an HLC of now that still wins (D31, D74)', async () => {
    const { store, clock } = await create();
    const ahead = hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + 1);
    const phone = plantDevice(store, ahead);
    const session = await unlock(store, clock);
    expect(must(deviceOf(session, phone)).hlc).toEqual(ahead);
    await session.retireDevice(phone);
    const after = must(deviceOf(session, phone));
    expect(after.device.retired).toBe(true);
    expect(after.hlc.physicalMs).toBe(T0);
    expect(compareHlc(after.hlc, ahead)).toBeLessThan(0);
    expect(session.writable).toBe(true);
  });

  it('retires while the vault is read-only for a clock gone back, with the D85 HLC (D73, D85)', async () => {
    const clock = new Clock(T0 + 2 * DAY);
    const { store } = await create(clock);
    const phone = plantDevice(store, hlcAt(T0 + 2 * DAY + 10));
    clock.t = T0;
    const behind = await unlock(store, clock);
    expect(behind.writable).toBe(false);
    const state = localState(store).hlc;

    await behind.retireDevice(phone);
    const after = must(deviceOf(behind, phone));
    expect(after.device.retired).toBe(true);
    expect(after.hlc).toEqual({
      physicalMs: state.physicalMs,
      counter: state.counter + 1,
      deviceId: behind.deviceId,
    });
    expect(localState(store).hlc).toEqual(after.hlc);
    expect(behind.writable).toBe(false);
    await expect(behind.createItem(login())).rejects.toThrow(HlcReadOnlyError);
  });
});

describe('re-founding (§14, D28, D40, D60, D72, D86, D99, D187)', () => {
  /** Re-founds `old` into a new store, with the new password's KEK seed 3 and a new phrase. */
  async function refound(
    old: VaultSession,
    options: { clock?: Clock; seed?: number; method?: UnlockMethod; store?: MemoryStore } = {},
  ) {
    const caller = new Keyring();
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    const store = options.store ?? new MemoryStore();
    const session = await VaultSession.refound(old, {
      store,
      keyring,
      kek: kek(keyring, 3),
      recoveryEntropy: phrase.entropy,
      salt: SALT,
      kdfParams: PARAMS,
      displayName: 'Re-founded laptop',
      current: { kek: kek(caller, options.seed ?? 1), method: options.method ?? 'password' },
      now: (options.clock ?? new Clock()).now,
    });
    open.push(session);
    caller.wipeAll();
    return { session, store, words: phrase.words };
  }

  function ids(store: MemoryStore): Set<string> {
    return new Set([...store.held.values()].map((r) => idKey(r.recordId)));
  }

  /** The folder tree as names: `[name, children, items]`, sorted. */
  function shape(session: VaultSession): unknown {
    const names = (s: VaultSession, parent?: Uint8Array): unknown[] =>
      s
        .folders()
        .filter(
          (f) =>
            !f.inTrash &&
            idKey(f.parentId ?? new Uint8Array()) === idKey(parent ?? new Uint8Array()),
        )
        .map((f) => [
          f.name,
          names(s, f.id),
          s
            .items()
            .filter((i) => !i.inTrash && i.item?.folderId && idKey(i.item.folderId) === idKey(f.id))
            .map((i) => i.item?.title)
            .sort(),
        ])
        .sort((a, b) => String(a[0]).localeCompare(String(b[0])));
    return names(session);
  }

  it('carries live items and folders under new keys, IDs and HLCs, in one commit with the replaced vaultId (D28, D40, D99)', async () => {
    const clock = new Clock();
    const { session: old, store: oldStore } = await create(clock);
    const work = await old.createFolder('Work');
    const team = await old.createFolder('Team', work);
    const bank = await old.createItem({ ...login('Bank'), folderId: team });
    await old.updateItem(bank, { ...login('Bank, edited'), folderId: team });
    await old.createItem(login('Root item'));
    clock.t = T0 + 1000;
    const before = shape(old);
    const oldHeld = await oldStore.records();

    const { session, store, words } = await refound(old, { clock });
    expect(store.commits).toHaveLength(1);
    expect(session.vaultId).not.toEqual(old.vaultId);
    expect(session.deviceId).not.toEqual(old.deviceId);
    const config = parseLocalConfig(store.localConfig);
    expect(config.replacesVaultId).toEqual(old.vaultId);
    expect(shape(session)).toEqual(before);
    expect(
      session
        .items()
        .map((i) => i.item?.title)
        .sort(),
    ).toEqual(['Bank, edited', 'Root item']);
    // No history, no record ID and no record of the old vault (D99).
    for (const i of session.items()) expect(session.versions(i.id)).toEqual([]);
    const oldIds = new Set(oldHeld.map((r) => idKey(r.recordId)));
    // Only the Vault Key record shares its ID, fixed by the epoch alone (crypto-spec.md §4).
    expect([...ids(store)].filter((id) => oldIds.has(id))).toEqual([idKey(vaultKeyRecordId(1))]);
    expect(store.ofType(RecordType.itemVersion)).toHaveLength(0);
    for (const i of session.items()) expect(i.hlc.physicalMs).toBe(T0 + 1000);
    // Its own Device record only, as the creator of the new vault (D40).
    expect(session.devices().map((d) => [d.deviceId, d.device.displayName])).toEqual([
      [session.deviceId, 'Re-founded laptop'],
    ]);
    expect(session.registered).toBe(true);
    // The new phrase opens the new envelope; the old vault is untouched.
    expect(session.checkRecoveryPhrase(words)).toBe('opens');
    expect(await oldStore.records()).toEqual(oldHeld);
    session.lock();
    expect((await unlock(store, clock, 3)).items()).toHaveLength(2);
  });

  it('empties the trash and the history, and moves to the root what had its folder in the trash (D72, D86)', async () => {
    const { session: old } = await create();
    const kept = await old.createFolder('Kept');
    const gone = await old.createFolder('Gone');
    const child = await old.createFolder('Child', gone);
    await old.createItem({ ...login('In kept'), folderId: kept });
    const orphan = await old.createItem({ ...login('Orphan'), folderId: gone });
    const trashed = await old.createItem(login('Trashed'));
    await old.trashItem(trashed);
    await old.trashFolder(gone);
    // Restored from the trash on its own: live again, its folder still in the trash (D106).
    await old.restoreItem(orphan);
    await old.restoreFolder(child);

    const { session } = await refound(old);
    expect(
      session
        .items()
        .map((i) => [i.item?.title, i.inTrash])
        .sort(),
    ).toEqual([
      ['In kept', false],
      ['Orphan', false],
    ]);
    const orphanView = must(session.items().find((i) => i.item?.title === 'Orphan'));
    expect(orphanView.item?.folderId).toBeUndefined();
    expect(
      session
        .folders()
        .map((f) => [f.name, f.parentId, f.inTrash])
        .sort(),
    ).toEqual([
      ['Child', undefined, false],
      ['Kept', undefined, false],
    ]);
  });

  it('carries a read-only item with its content unchanged, unknown keys included, at the root (D60, D86)', async () => {
    const { session: old0, store: oldStore } = await create();
    const work = await old0.createFolder('Work');
    old0.lock();
    const keys = keysOf(oldStore);
    const content = itemToCbor({ ...login('Newer'), folderId: work }, false);
    content.set('color', 'red');
    plant(oldStore, keys, RecordType.item, randomId(), hlcAt(T0), false, content);
    const old = await unlock(oldStore);
    expect(old.items()[0]?.readOnly).toBe('newer-content');

    const { session, store } = await refound(old);
    const [view] = session.items();
    expect(view?.readOnly).toBe('newer-content');
    const carried = contentOf(store, keysOf(store, 3), RecordType.item, must(view).id);
    expect(encodeCbor(carried)).toEqual(encodeCbor(content));
    expect(session.tree().items.map((i) => i.id)).toEqual([must(view).id]);
  });

  it('carries records beyond the future-clock bound with fresh HLCs, and re-founds a vault read-only for a clock gone back (D73, D149)', async () => {
    const clock = new Clock(T0 + 2 * DAY);
    const { session: ahead, store: oldStore } = await create(clock);
    await ahead.createItem(login('Written ahead'));
    await ahead.createFolder('Folder ahead');
    clock.t = T0;
    const old = await unlock(oldStore, clock);
    expect(old.writable).toBe(false);
    expect(old.items()[0]?.readOnly).toBe('future-clock');

    const { session } = await refound(old, { clock });
    expect(session.writable).toBe(true);
    expect(session.items().map((i) => [i.item?.title, i.readOnly, i.hlc.physicalMs])).toEqual([
      ['Written ahead', undefined, T0],
    ]);
    expect(session.folders().map((f) => f.name)).toEqual(['Folder ahead']);
    await session.createItem(login('Now'));
  });

  it('keeps the preferences and starts with no backup date, devices seen, rejected peers or passkey (D107, D187)', async () => {
    const { session: old0, keyring } = await create();
    await old0.setPreferences({ ...DEFAULT_PREFERENCES, autoLockMinutes: 1 });
    await old0.exportBackup({ kek: kek(keyring), method: 'password' });
    await old0.setPasskey({
      current: kek(keyring),
      prfKek: kek(keyring, 4),
      credentialId: new Uint8Array([1]),
      prfInput: new Uint8Array(32),
    });
    expect(old0.lastBackupAt).toBe(T0);

    const { session, store } = await refound(old0);
    expect(session.preferences).toEqual({ ...DEFAULT_PREFERENCES, autoLockMinutes: 1 });
    expect(session.lastBackupAt).toBeUndefined();
    expect(session.passkeyCredentialId).toBeUndefined();
    expect(session.backupMayBeIncomplete).toBe(false);
    expect(session.lastPhraseId).toEqual(session.recovery?.phraseId);
    expect(parseLocalConfig(store.localConfig).prf).toBeUndefined();
  });

  it('takes the passkey as the proof of the user too (D187)', async () => {
    const { session: old, keyring } = await create();
    await old.setPasskey({
      current: kek(keyring),
      prfKek: kek(keyring, 4),
      credentialId: new Uint8Array([1]),
      prfInput: new Uint8Array(32),
    });
    const { session } = await refound(old, { seed: 4, method: 'passkey' });
    expect(session.vaultId).not.toEqual(old.vaultId);
  });

  it('refuses a KEK that does not open the old vault, and a locked old vault, writing nothing (D93, D187)', async () => {
    const { session: old } = await create();
    await old.createItem(login());
    const store = new MemoryStore();
    await expect(refound(old, { seed: 2, store })).rejects.toThrow(UnlockRejectedError);
    await expect(refound(old, { seed: 1, method: 'passkey', store })).rejects.toThrow(
      UnlockRejectedError,
    );
    expect(store.commits).toHaveLength(0);
    expect(old.items()).toHaveLength(1);
    old.lock();
    await expect(refound(old, { store })).rejects.toThrow(VaultLockedError);
    expect(store.commits).toHaveLength(0);
  });

  it('confirms the user with the password or passkey KEK, keeping no key (D187)', async () => {
    const { session, keyring } = await create();
    const caller = new Keyring();
    expect(() => {
      session.confirmUser({ kek: kek(caller), method: 'password' });
    }).not.toThrow();
    expect(() => {
      session.confirmUser({ kek: kek(caller, 2), method: 'password' });
    }).toThrow(UnlockRejectedError);
    expect(() => {
      session.confirmUser({ kek: kek(caller), method: 'passkey' });
    }).toThrow(UnlockRejectedError);
    expect(caller.size).toBe(3);
    const size = keyring.size;
    session.confirmUser({ kek: kek(caller), method: 'password' });
    expect(keyring.size).toBe(size);
  });

  it('names the peers whose records were rejected, for the D116 warning', async () => {
    const { session, store } = await create();
    expect(session.rejectedPeers).toEqual([]);
    session.lock();
    const keys = keysOf(store);
    const config = parseLocalConfig(store.localConfig);
    const peer = randomId();
    const encrypted = sealLocalConfigPart(
      keys.subkeys.localConfig,
      localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
      localConfigStateToCbor({
        preferences: DEFAULT_PREFERENCES,
        hlc: hlcAt(T0),
        rejectedPeers: [peer],
      }),
      generateDeviceIdentity(new Keyring()),
    );
    store.localConfig = encodeCbor(localConfigToCbor({ ...config, encrypted }));
    expect((await unlock(store)).rejectedPeers).toEqual([peer]);
  });

  it('carries nothing kept aside as corrupt, and wipes its keyring when the commit fails', async () => {
    const { session: old0, store: oldStore } = await create();
    await old0.createItem(login('Good'));
    const bad = await old0.createItem(login('Tampered'));
    old0.lock();
    const key = { recordType: RecordType.item, recordId: bad };
    const envelope = must(oldStore.get(key)).envelope.slice() as RecordEnvelope;
    envelope[envelope.length - 1] = (envelope[envelope.length - 1] ?? 0) ^ 1;
    oldStore.put({ ...key, envelope });
    const old = await unlock(oldStore);
    expect(old.corrupt()).toHaveLength(1);
    const { session } = await refound(old);
    expect(session.items().map((i) => i.item?.title)).toEqual(['Good']);

    const failing = new MemoryStore();
    failing.failNext = true;
    const keyring = new Keyring();
    const caller = new Keyring();
    await expect(
      VaultSession.refound(old, {
        store: failing,
        keyring,
        kek: kek(keyring, 3),
        recoveryEntropy: generateRecoveryPhrase(keyring).entropy,
        salt: SALT,
        kdfParams: PARAMS,
        displayName: 'X',
        current: { kek: kek(caller), method: 'password' },
      }),
    ).rejects.toThrow('storage failure');
    expect(keyring.wiped).toBe(true);
    expect(caller.size).toBe(1);
    expect(old.items().map((i) => i.item?.title)).toEqual(['Good']);
  });
});

describe('read-only records (D52, D73, D74)', () => {
  it('shows an item from a newer app version read-only and blocks every write to it', async () => {
    const { store } = await create();
    const keys = keysOf(store);
    const id = randomId();
    const content = itemToCbor(login(), false);
    content.set('color', 'red');
    plant(store, keys, RecordType.item, id, hlcAt(T0), false, content);
    const session = await unlock(store);
    expect(session.item(id)).toMatchObject({ readOnly: 'newer-content', readOnlyRule: 1 });
    expect(session.item(id)?.item).toBeUndefined();
    for (const action of [
      () => session.updateItem(id, login()),
      () => session.trashItem(id),
      () => session.restoreItem(id),
    ]) {
      await expect(action()).rejects.toThrow(new RecordBlockedError('newer-content'));
    }
  });

  it('blocks writes to an item beyond the future-clock bound, not to the vault', async () => {
    const { store, clock } = await create();
    const id = randomId();
    plant(
      store,
      keysOf(store),
      RecordType.item,
      id,
      hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + 1),
      false,
      itemToCbor(login(), false),
    );
    const session = await unlock(store, clock);
    expect(session.item(id)?.readOnly).toBe('future-clock');
    expect(session.item(id)?.item?.title).toBe('Example');
    await expect(session.updateItem(id, login('New'))).rejects.toThrow(
      new RecordBlockedError('future-clock'),
    );
    expect(session.writable).toBe(true);
    const other = await session.createItem(login());
    expect(session.item(other)?.hlc.physicalMs).toBe(T0);
    clock.t += 2;
    expect(session.item(id)?.readOnly).toBeUndefined();
  });

  it('blocks restoring a version from a newer app version or beyond the bound', async () => {
    const { store, session } = await create();
    const id = await session.createItem(login());
    const keys = keysOf(store);
    const newer = itemToCbor(login('Newer'), false);
    newer.set('color', 'red');
    for (const [hlc, item] of [
      [hlcAt(T0 - 2), newer],
      [hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + 1), itemToCbor(login('Ahead'), false)],
    ] as const) {
      plant(
        store,
        keys,
        RecordType.itemVersion,
        versionId(keys.subkeys.versionId, id, hlc),
        hlc,
        false,
        new Map<CborValue, CborValue>([
          ['item', item],
          ['itemId', id],
        ]),
      );
    }
    session.lock();
    const s = await unlock(store);
    const [ahead, newerVersion] = s.versions(id);
    expect(ahead?.readOnly).toBe('future-clock');
    expect(newerVersion?.readOnly).toBe('newer-content');
    await expect(s.restoreVersion(id, must(ahead).versionId)).rejects.toThrow(
      new RecordBlockedError('future-clock'),
    );
    await expect(s.restoreVersion(id, must(newerVersion).versionId)).rejects.toThrow(
      new RecordBlockedError('newer-content'),
    );
  });

  it('makes the whole vault read-only while the HLC state is beyond the cap', async () => {
    const clock = new Clock(T0 + 2 * DAY);
    const { session, store } = await create(clock);
    const id = await session.createItem(login());
    clock.t = T0;
    const behind = await unlock(store, clock);
    expect(behind.writable).toBe(false);
    expect(behind.writableAt).toBe(T0 + 2 * DAY - FUTURE_CLOCK_BOUND_MS);
    const commits = store.commits.length;
    await expect(behind.createItem(login())).rejects.toThrow(HlcReadOnlyError);
    await expect(behind.updateItem(id, login('New'))).rejects.toThrow(
      new RecordBlockedError('future-clock'),
    );
    expect(store.commits).toHaveLength(commits);
  });

  it('keeps aside a record that fails verification, an invalid folder and a misfiled one', async () => {
    const { session, store } = await create();
    await session.createItem(login('Good'));
    const tampered = await session.createItem(login('Tampered'));
    const misfiled = await session.createItem(login('Misfiled'));
    const tamperedKey = { recordType: RecordType.item, recordId: tampered };
    // Tampered bytes at rest: storage hands back whatever it holds as an envelope.
    const envelope = must(store.get(tamperedKey)).envelope.slice() as RecordEnvelope;
    envelope[envelope.length - 1] = (envelope[envelope.length - 1] ?? 0) ^ 1;
    store.put({ ...tamperedKey, envelope });
    const misfiledKey = { recordType: RecordType.item, recordId: misfiled };
    const moved = must(store.get(misfiledKey));
    store.held.clear();
    for (const r of store.commits.flatMap((c) => c.put)) {
      if (r.recordType !== RecordType.item || idKey(r.recordId) !== idKey(misfiled)) store.put(r);
    }
    store.put({ ...tamperedKey, envelope });
    store.put({ recordType: RecordType.item, recordId: randomId(), envelope: moved.envelope });
    plant(store, keysOf(store), RecordType.folder, randomId(), hlcAt(T0), false, folder('', false));
    const [vaultKeyRecord] = store.ofType(RecordType.vaultKey);
    store.put({ ...must(vaultKeyRecord), recordId: randomId() });
    session.lock();
    const s = await unlock(store);
    expect(s.items().map((v) => v.item?.title)).toEqual(['Good']);
    expect(
      s
        .corrupt()
        .map((k) => k.recordType)
        .sort(),
    ).toEqual([RecordType.item, RecordType.item, RecordType.folder, RecordType.vaultKey]);
  });
});

describe('duplicate (D135, D140, D156, D169)', () => {
  const COPY = ' (copy)';

  it('writes the current content under a new ID, with the suffix and no history', async () => {
    const { session, store, clock } = await create();
    const folderId = await session.createFolder('Work');
    const id = await session.createItem({ ...login(), folderId, tags: ['bank'], notes: 'n' });
    clock.t += 1000;
    await session.updateItem(id, { ...login('Current'), folderId, tags: ['bank'], notes: 'n' });
    const original = session.item(id);
    clock.t += 1000;
    const copy = await session.duplicateItem(id, COPY);
    expect(copy).not.toEqual(id);
    const view = must(session.item(copy));
    expect(view.item).toEqual({ ...login('Current (copy)'), folderId, tags: ['bank'], notes: 'n' });
    expect(view.hlc.physicalMs).toBe(T0 + 2000);
    expect(session.versions(copy)).toEqual([]);
    // The original is untouched: no new state, no new version.
    expect(session.item(id)).toEqual(original);
    expect(session.versions(id)).toHaveLength(1);
    expect((await unlock(store, clock)).item(copy)?.item?.title).toBe('Current (copy)');
  });

  it('places the copy where the original is displayed: the root for an orphan (D156)', async () => {
    const { store, session } = await create();
    const keys = keysOf(store);
    const trashed = await session.createFolder('Old');
    await session.trashFolder(trashed);
    const ids = [trashed, randomId()].map((folderId) => {
      const id = randomId();
      plant(
        store,
        keys,
        RecordType.item,
        id,
        hlcAt(T0 - 1),
        false,
        itemToCbor({ ...login(), folderId }, false),
      );
      return id;
    });
    session.lock();
    const again = await unlock(store);
    for (const id of ids) {
      const copy = await again.duplicateItem(id, COPY);
      expect(again.item(copy)?.item?.folderId).toBeUndefined();
      expect(again.tree().items.map((t) => t.id)).toContainEqual(copy);
    }
  });

  it('is blocked for an item from a newer app version or in the trash, writing nothing (D140)', async () => {
    const { store, session } = await create();
    const keys = keysOf(store);
    const newer = randomId();
    const content = itemToCbor(login(), false);
    content.set('color', 'red');
    plant(store, keys, RecordType.item, newer, hlcAt(T0 - 1), false, content);
    const trashed = await session.createItem(login());
    await session.trashItem(trashed);
    session.lock();
    const again = await unlock(store);
    const commits = store.commits.length;
    await expect(again.duplicateItem(newer, COPY)).rejects.toThrow(
      new RecordBlockedError('newer-content'),
    );
    await expect(again.duplicateItem(trashed, COPY)).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    await expect(again.duplicateItem(randomId(), COPY)).rejects.toThrow(RecordNotFoundError);
    expect(store.commits).toHaveLength(commits);
  });

  it('copies an item beyond the future-clock bound with a fresh HLC (D140)', async () => {
    const { store, clock } = await create();
    const id = randomId();
    const ahead = T0 + FUTURE_CLOCK_BOUND_MS + 1;
    plant(
      store,
      keysOf(store),
      RecordType.item,
      id,
      hlcAt(ahead),
      false,
      itemToCbor(login(), false),
    );
    const session = await unlock(store, clock);
    expect(session.item(id)?.readOnly).toBe('future-clock');
    const copy = await session.duplicateItem(id, COPY);
    const view = session.item(copy);
    expect(view?.readOnly).toBeUndefined();
    expect(view?.hlc.physicalMs).toBe(T0);
    expect(view?.item?.title).toBe('Example (copy)');
  });

  it('is refused when the suffix takes the title or the item past its cap (D169)', async () => {
    const { session, store } = await create();
    const fits = await session.createItem(login('t'.repeat(TITLE_MAX - COPY.length)));
    expect(session.item(await session.duplicateItem(fits, COPY))?.item?.title).toHaveLength(
      TITLE_MAX,
    );
    const long = await session.createItem(login('t'.repeat(TITLE_MAX - COPY.length + 1)));
    // A notes string long enough to leave exactly the room the suffix needs, and one byte less.
    const sized = (room: number) => {
      const base = { ...login('Big'), notes: 'x'.repeat(1_000_000) };
      const length = itemContentLength(itemToCbor(base, false));
      return { ...base, notes: 'x'.repeat(1_000_000 + ITEM_CAP - length - room) };
    };
    const roomy = await session.createItem(sized(COPY.length));
    await session.duplicateItem(roomy, COPY);
    const full = await session.createItem(sized(COPY.length - 1));
    const commits = store.commits.length;
    await expect(session.duplicateItem(long, COPY)).rejects.toThrow(
      new ContentInvalidError('title'),
    );
    await expect(session.duplicateItem(full, COPY)).rejects.toThrow(
      new ContentInvalidError('item cap'),
    );
    expect(store.commits).toHaveLength(commits);
  });
});

describe('folders (D14, D59, D112, D171)', () => {
  it('creates, renames and moves folders, keeping unknown keys through every write', async () => {
    const { session, store } = await create();
    const keys = keysOf(store);
    const id = randomId();
    const content = folder('Work', false);
    content.set('color', 'red');
    plant(store, keys, RecordType.folder, id, hlcAt(T0 - 1), false, content);
    session.lock();
    const s = await unlock(store);
    const parent = await s.createFolder('Projects');
    expect(await s.renameFolder(id, 'Office')).toBe(true);
    expect(await s.renameFolder(id, 'Office')).toBe(false);
    expect(await s.moveFolder(id, parent)).toBe(true);
    expect(await s.moveFolder(id, parent)).toBe(false);
    await s.trashFolder(id);
    await s.restoreFolder(id);
    const again = await unlock(store);
    expect(again.folder(id)).toMatchObject({
      name: 'Office',
      parentId: parent,
      inTrash: false,
      unknownKeys: ['color'],
    });
    expect(again.folder(id)?.trashOperationId).toBeUndefined();
    expect(await again.moveFolder(id)).toBe(true);
    expect(again.folder(id)?.parentId).toBeUndefined();
    expect(await again.moveFolder(id)).toBe(false);
    await expect(again.renameFolder(id, '')).rejects.toThrow(ContentInvalidError);
  });

  it('refuses a place in the trash, an unknown folder, or the folder’s own subtree', async () => {
    const { session } = await create();
    const a = await session.createFolder('A');
    const b = await session.createFolder('B', a);
    const c = await session.createFolder('C', b);
    const gone = await session.createFolder('Gone');
    await session.trashFolder(gone);
    await expect(session.createFolder('X', gone)).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    await expect(session.createFolder('X', randomId())).rejects.toThrow(RecordNotFoundError);
    await expect(session.createItem({ ...login(), folderId: gone })).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    const item = await session.createItem(login());
    await expect(session.updateItem(item, { ...login(), folderId: randomId() })).rejects.toThrow(
      RecordNotFoundError,
    );
    for (const target of [a, c]) {
      await expect(session.moveFolder(a, target)).rejects.toThrow(new RecordBlockedError('cycle'));
    }
    await expect(session.moveFolder(a, gone)).rejects.toThrow(new RecordBlockedError('in-trash'));
    await expect(session.renameFolder(gone, 'Back')).rejects.toThrow(
      new RecordBlockedError('in-trash'),
    );
    await expect(session.restoreFolder(a)).rejects.toThrow(new RecordBlockedError('not-in-trash'));
    await expect(session.renameFolder(randomId(), 'X')).rejects.toThrow(RecordNotFoundError);
    expect(await session.moveFolder(c, a)).toBe(true);
  });

  it('keeps an item whose folder is not held where it is, and shows it at the root', async () => {
    const { session, store } = await create();
    const keys = keysOf(store);
    const missing = randomId();
    const id = randomId();
    plant(
      store,
      keys,
      RecordType.item,
      id,
      hlcAt(T0 - 1),
      false,
      itemToCbor({ ...login('Orphan'), folderId: missing }, false),
    );
    session.lock();
    const s = await unlock(store);
    expect(await s.updateItem(id, { ...login('Renamed'), folderId: missing })).toBe(true);
    expect(s.tree().items.map((i) => i.name)).toEqual(['Renamed']);
  });

  it('derives the tree: folders and items in place, the trash left out, siblings in order', async () => {
    const { session, store } = await create();
    const work = await session.createFolder('work');
    const archive = await session.createFolder('Archive');
    const sub = await session.createFolder('Sub', work);
    await session.createItem({ ...login('b'), folderId: sub });
    await session.createItem({ ...login('a'), folderId: sub });
    await session.createItem(login('Root item'));
    const trashed = await session.createItem(login('Trashed'));
    await session.trashItem(trashed);
    const keys = keysOf(store);
    const newer = itemToCbor({ ...login('Newer'), folderId: work }, false);
    newer.set('color', 'red');
    plant(store, keys, RecordType.item, randomId(), hlcAt(T0 - 1), false, newer);
    session.lock();
    const s = await unlock(store);
    const tree = s.tree();
    expect(tree.folder).toBeNull();
    expect(tree.folders.map((n) => n.folder?.name)).toEqual(['Archive', 'work']);
    expect(tree.items.map((i) => i.name)).toEqual(['Root item']);
    const workNode = tree.folders[1];
    expect(workNode?.items.map((i) => [i.name, i.readOnly])).toEqual([['Newer', 'newer-content']]);
    expect(workNode?.folders[0]?.items.map((i) => i.name)).toEqual(['a', 'b']);
    expect(s.tree(compareBytesOfNames).folders.map((n) => n.folder?.name)).toEqual([
      'Archive',
      'work',
    ]);
    expect(archive).toHaveLength(16);
  });

  it('trashes a subtree under one trashOperationId and restores exactly those records', async () => {
    const { session } = await create();
    const top = await session.createFolder('Top');
    const sub = await session.createFolder('Sub', top);
    const inTop = await session.createItem({ ...login('in top'), folderId: top });
    const inSub = await session.createItem({ ...login('in sub'), folderId: sub });
    const earlier = await session.createItem({ ...login('earlier'), folderId: sub });
    const elsewhere = await session.createItem(login('elsewhere'));
    const separate = await session.createFolder('Separate', top);
    await session.trashFolder(separate);
    await session.trashItem(earlier);
    const earlierOp = session.item(earlier)?.item?.trashOperationId;

    await session.trashFolder(top);
    const op = session.folder(top)?.trashOperationId;
    expect(op).toHaveLength(16);
    expect(session.folder(sub)?.trashOperationId).toEqual(op);
    for (const id of [inTop, inSub]) {
      expect(session.item(id)).toMatchObject({ inTrash: true, item: { trashOperationId: op } });
      expect(session.versions(id)).toHaveLength(1);
    }
    expect(session.item(earlier)?.item?.trashOperationId).toEqual(earlierOp);
    expect(session.item(elsewhere)?.inTrash).toBe(false);
    expect(session.tree().folders).toEqual([]);

    await session.restoreFolder(top);
    expect(session.folder(top)).toMatchObject({ inTrash: false });
    expect(session.folder(sub)).toMatchObject({ inTrash: false, parentId: top });
    expect(session.item(inSub)?.item).toMatchObject({ folderId: sub });
    expect(session.item(inSub)?.item?.trashOperationId).toBeUndefined();
    expect(session.item(inTop)?.inTrash).toBe(false);
    expect(session.item(earlier)?.inTrash).toBe(true);
    expect(session.folder(separate)?.inTrash).toBe(true);
  });

  it('restores a subfolder alone with its part of the operation, at the root (D171)', async () => {
    const { session } = await create();
    const top = await session.createFolder('Top');
    const sub = await session.createFolder('Sub', top);
    const inTop = await session.createItem({ ...login('in top'), folderId: top });
    const inSub = await session.createItem({ ...login('in sub'), folderId: sub });
    await session.trashFolder(top);
    await session.restoreFolder(sub);
    expect(session.folder(sub)?.inTrash).toBe(false);
    expect(session.folder(sub)?.parentId).toBeUndefined();
    expect(session.item(inSub)).toMatchObject({ inTrash: false, item: { folderId: sub } });
    expect(session.folder(top)?.inTrash).toBe(true);
    expect(session.item(inTop)?.inTrash).toBe(true);

    // An item restored on its own leaves its trashed folder behind (D106, D112).
    await session.restoreItem(inTop);
    expect(session.item(inTop)?.item?.folderId).toBeUndefined();
    await session.restoreFolder(top);
    expect(session.item(inTop)?.item?.folderId).toBeUndefined();
  });

  it('refuses to trash or restore a subtree holding a read-only record, writing nothing', async () => {
    const { session, store } = await create();
    const top = await session.createFolder('Top');
    const sub = await session.createFolder('Sub', top);
    const keys = keysOf(store);
    const newer = randomId();
    const content = itemToCbor({ ...login('Newer'), folderId: sub }, false);
    content.set('color', 'red');
    plant(store, keys, RecordType.item, newer, hlcAt(T0 - 1), false, content);
    const ahead = randomId();
    plant(
      store,
      keys,
      RecordType.folder,
      ahead,
      hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + 1),
      false,
      (() => {
        const f = folder('Ahead', false);
        f.set('parentId', top);
        return f;
      })(),
    );
    const aheadItem = randomId();
    plant(
      store,
      keys,
      RecordType.item,
      aheadItem,
      hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + 1),
      false,
      itemToCbor({ ...login('Ahead'), folderId: top }, false),
    );
    session.lock();
    const s = await unlock(store);
    expect(s.folder(ahead)?.readOnly).toBe('future-clock');
    await expect(s.renameFolder(ahead, 'x')).rejects.toThrow(
      new RecordBlockedError('future-clock'),
    );
    const commits = store.commits.length;
    const error = await s.trashFolder(top).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SubtreeBlockedError);
    expect(
      (error as SubtreeBlockedError).records.map((r) => [
        r.recordType,
        idKey(r.recordId),
        r.reason,
      ]),
    ).toEqual(
      expect.arrayContaining([
        [RecordType.folder, idKey(ahead), 'future-clock'],
        [RecordType.item, idKey(newer), 'newer-content'],
        [RecordType.item, idKey(aheadItem), 'future-clock'],
      ]),
    );
    expect(store.commits).toHaveLength(commits);
    expect(s.folder(top)?.inTrash).toBe(false);
  });

  it('refuses to restore an operation holding a record that became read-only', async () => {
    const { session, store } = await create();
    const top = await session.createFolder('Top');
    await session.trashFolder(top);
    const op = must(session.folder(top)?.trashOperationId);
    const keys = keysOf(store);
    const newer = randomId();
    const content = itemToCbor({ ...login('Newer'), folderId: top, trashOperationId: op }, true);
    content.set('color', 'red');
    plant(store, keys, RecordType.item, newer, hlcAt(T0 - 1), true, content);
    session.lock();
    const s = await unlock(store);
    await expect(s.restoreFolder(top)).rejects.toThrow(SubtreeBlockedError);
    expect(s.folder(top)?.inTrash).toBe(true);
  });

  it('purges a folder in the trash and blocks it afterwards', async () => {
    const { session, store, clock } = await create();
    const id = await session.createFolder('Old');
    await session.trashFolder(id);
    expect(session.folder(id)?.purgeAt).toBe(
      must(session.folder(id)).hlc.physicalMs + PURGE_DELAY_MS,
    );
    clock.t += PURGE_DELAY_MS;
    const s = await unlock(store, clock);
    expect(s.folder(id)).toBeUndefined();
    expect(s.folders()).toEqual([]);
    await expect(s.restoreFolder(id)).rejects.toThrow(new RecordBlockedError('purged'));
    await expect(s.createFolder('New', id)).rejects.toThrow(RecordNotFoundError);
  });

  it('keeps folder names and parentId out of every stored byte', async () => {
    const { session, store } = await create();
    const parent = await session.createFolder('Tax returns 2026');
    const child = await session.createFolder('Receipts of the clinic', parent);
    await session.moveFolder(child);
    await session.moveFolder(child, parent);
    const persisted = [store.localConfig, ...[...store.held.values()].map((r) => r.envelope)];
    for (const needle of [utf8('Tax returns 2026'), utf8('Receipts of the clinic')]) {
      expect(persisted.some((bytes) => contains(bytes, needle))).toBe(false);
    }
    // A folder ID shows only in its own record's cleartext header, never as a parentId.
    for (const id of [parent, child]) {
      expect(persisted.filter((bytes) => contains(bytes, id))).toHaveLength(1);
    }
  });
});

function compareBytesOfNames(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

describe('automatic purge (D7, D27, D94)', () => {
  it('purges a tombstone 30 days after its HLC, at unlock, keeping its header', async () => {
    const { session, store, clock } = await create();
    const id = await session.createItem(login());
    await session.updateItem(id, login('Edited'));
    await session.trashItem(id);
    const tombstone = must(session.item(id)).hlc;
    const key = { recordType: RecordType.item, recordId: id };
    const before = decodeEnvelope((store.get(key) as { envelope: Uint8Array }).envelope);

    clock.t = tombstone.physicalMs + PURGE_DELAY_MS - 1;
    expect((await unlock(store, clock)).item(id)?.inTrash).toBe(true);

    clock.t += 1;
    const s = await unlock(store, clock);
    expect(s.item(id)).toBeUndefined();
    expect(s.items()).toEqual([]);
    expect(s.versions(id)).toEqual([]);
    const after = decodeEnvelope((store.get(key) as { envelope: Uint8Array }).envelope);
    expect(after.header).toEqual(before.header);
    expect(after.ct.c).toHaveLength(16);
    expect(store.ofType(RecordType.itemVersion)).toEqual([]);
    await expect(s.restoreItem(id)).rejects.toThrow(new RecordBlockedError('purged'));
    await expect(s.duplicateItem(id, ' (copy)')).rejects.toThrow(new RecordBlockedError('purged'));
    expect((await unlock(store, clock)).item(id)).toBeUndefined();
  });

  it('purges while unlocked, every maintenance interval', async () => {
    vi.useFakeTimers();
    const { session, store, clock } = await create();
    const id = await session.createItem(login());
    await session.trashItem(id);
    clock.t = T0 + PURGE_DELAY_MS;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS - 1);
    expect(session.item(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(1);
    expect(session.item(id)).toBeUndefined();
    expect(store.commits.at(-1)?.put.map((p) => p.recordType)).toEqual([RecordType.item]);
  });

  it('retries a failed pass at the next interval', async () => {
    vi.useFakeTimers();
    const { session, store, clock } = await create();
    const id = await session.createItem(login());
    await session.trashItem(id);
    clock.t = T0 + PURGE_DELAY_MS;
    store.failNext = true;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
    expect(session.item(id)).toBeDefined();
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
    expect(session.item(id)).toBeUndefined();
  });

  it('purges while the vault and the record are read-only, and purges folders', async () => {
    const clock = new Clock();
    const { session, store } = await create(clock);
    const trashed = await session.createItem(login());
    await session.trashItem(trashed);
    const keys = keysOf(store);
    const newer = randomId();
    const content = itemToCbor({ ...login(), trashOperationId: randomId() }, true);
    content.set('color', 'red');
    plant(store, keys, RecordType.item, newer, hlcAt(T0), true, content);
    const folderId = randomId();
    plant(store, keys, RecordType.folder, folderId, hlcAt(T0), true, folder('Old', true));
    clock.t = T0 + 60 * DAY;
    await session.createItem(login());
    clock.t = T0 + PURGE_DELAY_MS;
    session.lock();
    const s = await unlock(store, clock);
    expect(s.writable).toBe(false);
    expect(s.item(trashed)).toBeUndefined();
    expect(s.item(newer)).toBeUndefined();
    for (const [recordType, recordId] of [
      [RecordType.item, trashed],
      [RecordType.item, newer],
      [RecordType.folder, folderId],
    ] as const) {
      const stored = store.get({ recordType, recordId }) as { envelope: Uint8Array };
      expect(decodeEnvelope(stored.envelope).ct.c).toHaveLength(16);
    }
    expect((await unlock(store, clock)).corrupt()).toEqual([]);
  });

  it('drops versions beyond the cut and versions of a purged item at unlock', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const keys = keysOf(store);
    const purgedId = randomId();
    plant(
      store,
      keys,
      RecordType.item,
      purgedId,
      hlcAt(T0 - 40 * DAY),
      true,
      (() => {
        return itemToCbor({ ...login(), trashOperationId: randomId() }, true);
      })(),
    );
    for (const [itemId, count] of [
      [id, HISTORY_LIMIT + 2],
      [purgedId, 3],
    ] as const) {
      for (let i = 0; i < count; i++) {
        const hlc = hlcAt(T0 - 50 * DAY + i);
        plant(
          store,
          keys,
          RecordType.itemVersion,
          versionId(keys.subkeys.versionId, itemId, hlc),
          hlc,
          false,
          new Map<CborValue, CborValue>([
            ['item', itemToCbor(login(`v${String(i)}`), false)],
            ['itemId', itemId],
          ]),
        );
      }
    }
    session.lock();
    const s = await unlock(store);
    expect(s.versions(id).map((v) => v.item?.title)).toEqual(
      Array.from({ length: HISTORY_LIMIT }, (_, i) => `v${String(HISTORY_LIMIT + 1 - i)}`),
    );
    expect(s.versions(purgedId)).toEqual([]);
    expect(store.ofType(RecordType.itemVersion)).toHaveLength(HISTORY_LIMIT);
  });
});

describe('lock (CRYPTO-INV-010)', () => {
  it('wipes the keys and the state, and refuses every later call', async () => {
    vi.useFakeTimers();
    const { session, keyring } = await create();
    const id = await session.createItem(login());
    expect(vi.getTimerCount()).toBe(1);
    session.lock();
    session.lock();
    expect(session.locked).toBe(true);
    expect(keyring.wiped).toBe(true);
    expect(keyring.size).toBe(0);
    expect(vi.getTimerCount()).toBe(0);
    for (const read of [
      () => session.items(),
      () => session.item(id),
      () => session.versions(id),
      () => session.devices(),
      () => session.corrupt(),
      () => session.vaultId,
      () => session.deviceId,
      () => session.preferences,
      () => session.writable,
      () => session.writableAt,
    ]) {
      expect(read).toThrow(VaultLockedError);
    }
    await expect(session.createItem(login())).rejects.toThrow(VaultLockedError);
    await expect(session.updateItem(id, login('x'))).rejects.toThrow(VaultLockedError);
  });

  it('refuses every public member after lock, touching neither a key nor the store, until a new unlock (CRYPTO-INV-010)', async () => {
    const { session, store, keyring } = await create();
    const itemId = await session.createItem(login());
    const folderId = await session.createFolder('Work');
    await session.updateItem(itemId, login('Example', 'rotated'));
    const versionId = must(session.versions(itemId)[0]).versionId;
    const commits = store.commits.length;
    session.lock();
    expect(keyring.wiped).toBe(true);
    expect(keyring.size).toBe(0);
    const reads = vi.spyOn(store, 'records');

    // The caller's keys are good: only the lock refuses.
    const caller = new Keyring();
    const calls: Record<string, () => unknown> = {
      changePassword: () =>
        session.changePassword({
          current: kek(caller),
          next: kek(caller, 2),
          salt: SALT,
          kdfParams: PARAMS,
        }),
      setPasskey: () =>
        session.setPasskey({
          current: kek(caller),
          prfKek: kek(caller, 3),
          credentialId: new Uint8Array([1]),
          prfInput: new Uint8Array(32),
        }),
      removePasskey: () => session.removePasskey(),
      forgetReplacedVault: () => session.forgetReplacedVault(),
      setPreferences: () => session.setPreferences(session.preferences),
      vaultId: () => session.vaultId,
      deviceId: () => session.deviceId,
      preferences: () => session.preferences,
      passkeyCredentialId: () => session.passkeyCredentialId,
      recovery: () => session.recovery,
      lastPhraseId: () => session.lastPhraseId,
      checkRecoveryPhrase: () => session.checkRecoveryPhrase('abandon'),
      regenerationBlock: () => session.regenerationBlock,
      regenerateRecoveryPhrase: () =>
        session.regenerateRecoveryPhrase({
          kek: kek(caller),
          method: 'password',
          entropy: generateRecoveryPhrase(caller).entropy,
        }),
      exportBackup: () => session.exportBackup({ kek: kek(caller), method: 'password' }),
      lastBackupAt: () => session.lastBackupAt,
      backupMayBeIncomplete: () => session.backupMayBeIncomplete,
      writable: () => session.writable,
      writableAt: () => session.writableAt,
      items: () => session.items(),
      item: () => session.item(itemId),
      versions: () => session.versions(itemId),
      devices: () => session.devices(),
      folders: () => session.folders(),
      folder: () => session.folder(folderId),
      tree: () => session.tree(),
      corrupt: () => session.corrupt(),
      createItem: () => session.createItem(login()),
      duplicateItem: () => session.duplicateItem(itemId, ' (copy)'),
      updateItem: () => session.updateItem(itemId, login('x')),
      trashItem: () => session.trashItem(itemId),
      restoreItem: () => session.restoreItem(itemId),
      restoreVersion: () => session.restoreVersion(itemId, versionId),
      createFolder: () => session.createFolder('Home'),
      renameFolder: () => session.renameFolder(folderId, 'Home'),
      moveFolder: () => session.moveFolder(folderId),
      trashFolder: () => session.trashFolder(folderId),
      restoreFolder: () => session.restoreFolder(folderId),
      mergeBackup: () =>
        session.mergeBackup({ vaultId: new Uint8Array(16), masterKey: kek(caller), records: [] }),
      retired: () => session.retired,
      registered: () => session.registered,
      retireDevice: () => session.retireDevice(new Uint8Array(16)),
      lastSyncByPeer: () => session.lastSyncByPeer,
      openPairing: () => session.openPairing({ kek: kek(caller), method: 'password' }),
      openReadmission: () => session.openReadmission(),
      openSync: () => session.openSync(new Uint8Array(16)),
      confirmUser: () => {
        session.confirmUser({ kek: kek(caller), method: 'password' });
      },
      rejectedPeers: () => session.rejectedPeers,
    };
    // Every member but `lock` and `locked` is called: a new one fails here until it is listed.
    const members = Object.getOwnPropertyNames(VaultSession.prototype).filter(
      (name) => !['constructor', 'lock', 'locked'].includes(name),
    );
    expect(Object.keys(calls).sort()).toEqual(members.sort());
    for (const [name, call] of Object.entries(calls)) {
      let outcome: unknown;
      try {
        outcome = await call();
      } catch (error) {
        outcome = error;
      }
      expect(outcome, name).toBeInstanceOf(VaultLockedError);
    }
    expect(store.commits).toHaveLength(commits);
    expect(reads).not.toHaveBeenCalled();
    reads.mockRestore();
    caller.wipeAll();

    // Only a new unlock reads the vault again, through a new session.
    const again = await unlock(store);
    expect(again.item(itemId)?.item?.title).toBe('Example');
    expect(session.locked).toBe(true);
    expect(() => session.items()).toThrow(VaultLockedError);
  });

  it('aborts an operation whose commit is in progress', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login('A'));
    let release: () => void = () => undefined;
    store.gate = new Promise<void>((resolve) => (release = resolve));
    const pending = session.updateItem(id, login('B'));
    await Promise.resolve();
    session.lock();
    release();
    await expect(pending).rejects.toThrow(VaultLockedError);
  });
});

describe('local settings (D151, D168)', () => {
  const NEW_SALT = new Uint8Array(16).fill(9);
  const NEW_PARAMS = { opslimit: 3, memlimit: MEMLIMIT };

  it('changes the password with the current one, re-wrapping only the Master Key', async () => {
    const { session, store, keyring } = await create();
    const itemId = await session.createItem(login());
    const before = parseLocalConfig(store.localConfig);
    const records = new Map(store.held);
    const commits = store.commits.length;
    await session.changePassword({
      current: kek(keyring),
      next: kek(keyring, 2),
      salt: NEW_SALT,
      kdfParams: NEW_PARAMS,
    });
    expect(store.commits).toHaveLength(commits + 1);
    expect(store.commits.at(-1)?.put).toEqual([]);
    expect(store.commits.at(-1)?.delete).toEqual([]);
    expect(store.held).toEqual(records);
    const after = parseLocalConfig(store.localConfig);
    expect(after.localConfigId).toEqual(before.localConfigId);
    expect(after.kek.salt).toEqual(NEW_SALT);
    expect(after.kek.opslimit).toBe(3);
    expect(after.kek.mkWrap.c).not.toEqual(before.kek.mkWrap.c);
    // The session keeps working, and a later write keeps the new wrap.
    await session.updateItem(itemId, login('Renamed'));
    expect(parseLocalConfig(store.localConfig).kek).toEqual(after.kek);
    session.lock();
    await expect(unlock(store, new Clock(), 1)).rejects.toThrow(UnlockRejectedError);
    expect((await unlock(store, new Clock(), 2)).item(itemId)?.item?.title).toBe('Renamed');
  });

  it('refuses another current password, writing nothing', async () => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    const bytes = store.localConfig;
    await expect(
      session.changePassword({
        current: kek(keyring, 3),
        next: kek(keyring, 2),
        salt: NEW_SALT,
        kdfParams: NEW_PARAMS,
      }),
    ).rejects.toThrow(UnlockRejectedError);
    expect(store.commits).toHaveLength(commits);
    expect(store.localConfig).toBe(bytes);
    session.lock();
    expect((await unlock(store, new Clock(), 1)).locked).toBe(false);
  });

  it('refuses parameters outside the accepted range and a short salt', async () => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    const base = { current: kek(keyring), next: kek(keyring, 2) };
    await expect(
      session.changePassword({
        ...base,
        salt: NEW_SALT,
        kdfParams: { opslimit: 1, memlimit: MEMLIMIT },
      }),
    ).rejects.toThrow();
    await expect(
      session.changePassword({ ...base, salt: new Uint8Array(15), kdfParams: NEW_PARAMS }),
    ).rejects.toThrow(RangeError);
    expect(store.commits).toHaveLength(commits);
  });

  it('keeps the old wrap when the commit fails', async () => {
    const { session, store, keyring } = await create();
    const bytes = store.localConfig;
    store.failNext = true;
    await expect(
      session.changePassword({
        current: kek(keyring),
        next: kek(keyring, 2),
        salt: NEW_SALT,
        kdfParams: NEW_PARAMS,
      }),
    ).rejects.toThrow('storage failure');
    expect(store.localConfig).toBe(bytes);
    // The next commit still carries the old wrap: the in-memory cleartext did not change.
    await session.createItem(login());
    expect(parseLocalConfig(store.localConfig).kek).toEqual(parseLocalConfig(bytes).kek);
  });

  it('refuses a password change and preferences once locked', async () => {
    const { session, keyring } = await create();
    const current = kek(keyring);
    const next = kek(keyring, 2);
    session.lock();
    await expect(
      session.changePassword({ current, next, salt: NEW_SALT, kdfParams: NEW_PARAMS }),
    ).rejects.toThrow(VaultLockedError);
    await expect(
      session.setPreferences({
        autoLockMinutes: 2,
        hiddenLockSeconds: 0,
        clipboardClearSeconds: 10,
      }),
    ).rejects.toThrow(VaultLockedError);
  });

  it('sets preferences within their ranges and keeps them across unlocks', async () => {
    const { session, store } = await create();
    const next = { autoLockMinutes: 60, hiddenLockSeconds: 0, clipboardClearSeconds: 120 };
    await session.setPreferences({ ...next, extra: 1 } as typeof next);
    expect(session.preferences).toEqual(next);
    expect(store.commits.at(-1)?.put).toEqual([]);
    const commits = store.commits.length;
    await session.setPreferences(next);
    expect(store.commits).toHaveLength(commits);
    session.lock();
    expect((await unlock(store)).preferences).toEqual(next);
  });

  it.each([
    { autoLockMinutes: 0, hiddenLockSeconds: 60, clipboardClearSeconds: 30 },
    { autoLockMinutes: 61, hiddenLockSeconds: 60, clipboardClearSeconds: 30 },
    { autoLockMinutes: 5, hiddenLockSeconds: 901, clipboardClearSeconds: 30 },
    { autoLockMinutes: 5, hiddenLockSeconds: -1, clipboardClearSeconds: 30 },
    { autoLockMinutes: 5, hiddenLockSeconds: 60, clipboardClearSeconds: 9 },
    { autoLockMinutes: 5, hiddenLockSeconds: 60, clipboardClearSeconds: 121 },
    { autoLockMinutes: 1.5, hiddenLockSeconds: 60, clipboardClearSeconds: 30 },
  ])('refuses preferences outside their ranges (%o)', async (preferences) => {
    const { session, store } = await create();
    const commits = store.commits.length;
    await expect(session.setPreferences(preferences)).rejects.toThrow(RangeError);
    expect(store.commits).toHaveLength(commits);
    expect(session.preferences).toEqual({
      autoLockMinutes: 5,
      hiddenLockSeconds: 60,
      clipboardClearSeconds: 30,
    });
  });
});

describe('passkey unlock (§5.5, D75, D172)', () => {
  const CREDENTIAL = new Uint8Array([9, 8, 7, 6]);
  const PRF_INPUT = new Uint8Array(32).fill(4);

  function setup(keyring: Keyring, current = 1, prf = 3) {
    return {
      current: kek(keyring, current),
      prfKek: kek(keyring, prf),
      credentialId: CREDENTIAL,
      prfInput: PRF_INPUT,
    };
  }

  it('sets up a passkey with the current password, writing only the Local Config', async () => {
    const { session, store, keyring } = await create();
    const itemId = await session.createItem(login());
    const before = parseLocalConfig(store.localConfig);
    const records = new Map(store.held);
    const commits = store.commits.length;
    expect(session.passkeyCredentialId).toBeUndefined();
    await session.setPasskey(setup(keyring));
    expect(store.commits).toHaveLength(commits + 1);
    expect(store.commits.at(-1)?.put).toEqual([]);
    expect(store.commits.at(-1)?.delete).toEqual([]);
    expect(store.held).toEqual(records);
    const after = parseLocalConfig(store.localConfig);
    expect(after.kek).toEqual(before.kek);
    expect(after.prf?.credentialId).toEqual(CREDENTIAL);
    expect(after.prf?.prfInput).toEqual(PRF_INPUT);
    expect(session.passkeyCredentialId).toEqual(CREDENTIAL);
    // The session keeps working, and a later write keeps the PRF wrap.
    await session.updateItem(itemId, login('Renamed'));
    expect(parseLocalConfig(store.localConfig).prf).toEqual(after.prf);
    session.lock();
    expect((await unlock(store, new Clock(), 3, 'passkey')).item(itemId)?.item?.title).toBe(
      'Renamed',
    );
    expect((await unlock(store, new Clock(), 1, 'password')).locked).toBe(false);
    await expect(unlock(store, new Clock(), 1, 'passkey')).rejects.toThrow(UnlockRejectedError);
  });

  it('binds the PRF wrap to its purpose, vault and Local Config (D121)', async () => {
    const { session, store, keyring } = await create();
    await session.setPasskey(setup(keyring));
    const config = parseLocalConfig(store.localConfig);
    const wrap = must(config.prf).mkWrap;
    const opens = (purpose: LocalPurpose, localConfigId = config.localConfigId) => {
      const k = new Keyring();
      try {
        unwrapKey(k, kek(k, 3), localAad(purpose, config.vaultId, localConfigId), wrap);
        return true;
      } catch {
        return false;
      } finally {
        k.wipeAll();
      }
    };
    expect(opens(LocalPurpose.mkWrapPrfKek)).toBe(true);
    expect(opens(LocalPurpose.mkWrapDeviceKek)).toBe(false);
    expect(opens(LocalPurpose.mkWrapPrfKek, randomId())).toBe(false);
  });

  it('refuses another current password, writing nothing (D172)', async () => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    const bytes = store.localConfig;
    await expect(session.setPasskey(setup(keyring, 2))).rejects.toThrow(UnlockRejectedError);
    expect(store.commits).toHaveLength(commits);
    expect(store.localConfig).toBe(bytes);
    expect(session.passkeyCredentialId).toBeUndefined();
  });

  it.each([
    ['an empty credential ID', { credentialId: new Uint8Array(0) }],
    ['a short PRF input', { prfInput: new Uint8Array(31) }],
    ['a long PRF input', { prfInput: new Uint8Array(33) }],
  ])('refuses %s, writing nothing', async (_name, change) => {
    const { session, store, keyring } = await create();
    const commits = store.commits.length;
    await expect(session.setPasskey({ ...setup(keyring), ...change })).rejects.toThrow(RangeError);
    expect(store.commits).toHaveLength(commits);
  });

  it('replaces the passkey set up before', async () => {
    const { session, store, keyring } = await create();
    await session.setPasskey(setup(keyring));
    const other = new Uint8Array([1]);
    await session.setPasskey({ ...setup(keyring, 1, 4), credentialId: other });
    expect(session.passkeyCredentialId).toEqual(other);
    session.lock();
    await expect(unlock(store, new Clock(), 3, 'passkey')).rejects.toThrow(UnlockRejectedError);
    expect((await unlock(store, new Clock(), 4, 'passkey')).locked).toBe(false);
  });

  it('removes the passkey, after which only the password unlocks', async () => {
    const { session, store, keyring } = await create();
    await session.setPasskey(setup(keyring));
    await session.removePasskey();
    expect(session.passkeyCredentialId).toBeUndefined();
    expect(parseLocalConfig(store.localConfig).prf).toBeUndefined();
    const commits = store.commits.length;
    await session.removePasskey();
    expect(store.commits).toHaveLength(commits);
    session.lock();
    await expect(unlock(store, new Clock(), 3, 'passkey')).rejects.toThrow(UnlockRejectedError);
    expect((await unlock(store)).locked).toBe(false);
  });

  it('keeps the old Local Config when the commit fails', async () => {
    const { session, store, keyring } = await create();
    const bytes = store.localConfig;
    store.failNext = true;
    await expect(session.setPasskey(setup(keyring))).rejects.toThrow('storage failure');
    expect(store.localConfig).toBe(bytes);
    expect(session.passkeyCredentialId).toBeUndefined();
    await session.createItem(login());
    expect(parseLocalConfig(store.localConfig).prf).toBeUndefined();
  });

  it('refuses setup and removal once locked', async () => {
    const { session, keyring } = await create();
    const options = setup(keyring);
    session.lock();
    await expect(session.setPasskey(options)).rejects.toThrow(VaultLockedError);
    await expect(session.removePasskey()).rejects.toThrow(VaultLockedError);
    expect(() => session.passkeyCredentialId).toThrow(VaultLockedError);
  });
});

function fromHex(hex: string): Uint8Array {
  return Uint8Array.from(hex.match(/../g) ?? [], (b) => parseInt(b, 16));
}

/** The content of a stored record, opened as another device of the vault would. */
function contentOf(store: MemoryStore, keys: Keys, recordType: RecordType, recordId: Uint8Array) {
  const record = must(store.get({ recordType, recordId }));
  const keyring = new Keyring();
  try {
    return verifyRecord(keyring, record.envelope, {
      vaultId: keys.vaultId,
      vaultKey: () => keys.vaultKey,
      vaultKeyWrapKey: keys.subkeys.vaultKeyWrap,
      versionIdKey: keys.subkeys.versionId,
    }).content;
  } finally {
    keyring.wipeAll();
  }
}

describe('content rules through the session (record-content.md §2, Gate A)', () => {
  const readOnlyItems = vectors.items.filter((row) => row.expected === 'read-only');

  it('has a read-only vector for every rule of §2', () => {
    expect(new Set(readOnlyItems.map((row) => row.rule))).toEqual(new Set([1, 2, 3, 4, 5, 6]));
  });

  it.each(readOnlyItems)(
    'rule $rule, $case: read-only, every write blocked, the record unchanged',
    async (row) => {
      const { store } = await create();
      const keys = keysOf(store);
      const id = randomId();
      const content = decodeCbor(fromHex(row.cbor)) as CborMap;
      plant(store, keys, RecordType.item, id, hlcAt(T0 - 1), row.deleted, content);
      const planted = must(store.get({ recordType: RecordType.item, recordId: id })).envelope;
      const session = await unlock(store);
      expect(session.item(id)).toMatchObject({
        readOnly: 'newer-content',
        readOnlyRule: row.rule,
        inTrash: row.deleted,
      });
      expect(session.item(id)?.item).toBeUndefined();
      const commits = store.commits.length;
      for (const action of [
        () => session.updateItem(id, login()),
        () => session.trashItem(id),
        () => session.restoreItem(id),
        () => session.duplicateItem(id, ' (copy)'),
        () => session.restoreVersion(id, randomId()),
      ]) {
        await expect(action()).rejects.toThrow(new RecordBlockedError('newer-content'));
      }
      expect(store.commits).toHaveLength(commits);
      session.lock();
      // A later unlock reads the same bytes, still read-only.
      expect(must(store.get({ recordType: RecordType.item, recordId: id })).envelope).toEqual(
        planted,
      );
      expect((await unlock(store)).item(id)?.readOnly).toBe('newer-content');
    },
  );

  it('shows a read-only Item Version and refuses to restore it', async () => {
    const { session, store } = await create();
    const id = await session.createItem(login());
    const keys = keysOf(store);
    const [row] = vectors.itemVersions.filter((r) => r.expected === 'read-only');
    const hlc = hlcAt(T0 - 5);
    const version = versionId(keys.subkeys.versionId, id, hlc);
    const content = decodeCbor(fromHex(must(row).cbor)) as CborMap;
    content.set('itemId', id);
    plant(store, keys, RecordType.itemVersion, version, hlc, false, content);
    session.lock();
    const again = await unlock(store);
    expect(again.versions(id)).toMatchObject([
      { readOnly: 'newer-content', readOnlyRule: must(row).rule },
    ]);
    await expect(again.restoreVersion(id, version)).rejects.toThrow(
      new RecordBlockedError('newer-content'),
    );
    expect(again.item(id)?.item?.title).toBe('Example');
  });

  it('keeps a Folder record’s unknown keys, unchanged, through rename, move, trash and restore (D59)', async () => {
    const { session, store } = await create();
    const keys = keysOf(store);
    const [row] = vectors.folders.filter((r) => r.case === 'unknown keys kept');
    const original = decodeCbor(fromHex(must(row).cbor)) as CborMap;
    const unknown = [...original.keys()].filter(
      (k): k is string =>
        typeof k === 'string' && !['name', 'parentId', 'trashOperationId'].includes(k),
    );
    expect(unknown.length).toBeGreaterThan(0);
    const id = randomId();
    plant(store, keys, RecordType.folder, id, hlcAt(T0 - 1), false, original);
    session.lock();
    const s = await unlock(store);
    const parent = await s.createFolder('Projects');
    const kept = (step: string) => {
      const content = must(contentOf(store, keys, RecordType.folder, id) ?? undefined);
      for (const k of unknown) {
        expect(encodeCbor(must(content.get(k))), `${step}: ${k}`).toEqual(
          encodeCbor(must(original.get(k))),
        );
      }
      return content;
    };
    expect(await s.renameFolder(id, 'Office')).toBe(true);
    expect(kept('rename').get('name')).toBe('Office');
    expect(await s.moveFolder(id, parent)).toBe(true);
    expect(kept('move').get('parentId')).toEqual(parent);
    await s.trashFolder(id);
    expect(kept('trash').has('trashOperationId')).toBe(true);
    await s.restoreFolder(id);
    expect(kept('restore').has('trashOperationId')).toBe(false);
    expect(await s.moveFolder(id)).toBe(true);
    expect(kept('move to the root').has('parentId')).toBe(false);
    expect((await unlock(store)).folder(id)?.unknownKeys).toEqual(must(row).unknownKeys);
  });

  it('keeps a Device record’s unknown keys, and never blocks on them (D59)', async () => {
    const { session, store } = await create();
    const keys = keysOf(store);
    const [row] = vectors.devices.filter((r) => r.case === 'unknown keys kept');
    const original = decodeCbor(fromHex(must(row).cbor)) as CborMap;
    const id = deviceId(original.get('publicKey') as Uint8Array);
    plant(store, keys, RecordType.device, id, hlcAt(T0 - 1), false, original);
    const planted = must(store.get({ recordType: RecordType.device, recordId: id })).envelope;
    session.lock();
    const s = await unlock(store);
    const shown = s.devices().find((d) => idKey(d.deviceId) === idKey(id));
    expect(shown?.unknownKeys).toEqual(must(row).unknownKeys);
    expect(shown?.unknownKeys.length).toBeGreaterThan(0);
    expect(s.corrupt()).toEqual([]);
    // Every write still works, and leaves the Device record as it was.
    const folderId = await s.createFolder('Work');
    const itemId = await s.createItem({ ...login(), folderId });
    await s.trashFolder(folderId);
    await s.restoreFolder(folderId);
    await s.trashItem(itemId);
    expect(must(store.get({ recordType: RecordType.device, recordId: id })).envelope).toEqual(
      planted,
    );
    expect(encodeCbor(must(contentOf(store, keys, RecordType.device, id) ?? undefined))).toEqual(
      fromHex(must(row).cbor),
    );
  });
});

describe('pairing (pairing-protocol.md §8, D30, D33, D34, D141, D202)', () => {
  const B_NAME = 'Firefox on Linux';

  /** A Device record of `publicKey`, planted as another device's sync would write it. */
  function plantDevice(
    store: MemoryStore,
    keys: Keys,
    publicKey: Uint8Array,
    hlc: Hlc,
    retired = false,
    displayName = 'Phone',
  ) {
    plant(
      store,
      keys,
      RecordType.device,
      deviceId(publicKey),
      hlc,
      false,
      deviceToCbor({ publicKey, displayName, retired, registeredAt: T0 }),
    );
  }

  function localState(store: MemoryStore, seed = 1) {
    const keys = keysOf(store, seed);
    const config = parseLocalConfig(store.localConfig);
    const opened = openLocalConfigPart(
      new Keyring(),
      keys.subkeys.localConfig,
      localAad(LocalPurpose.localConfig, config.vaultId, config.localConfigId),
      config.encrypted,
    );
    return readLocalConfigState(opened.content);
  }

  /** A's vault, a grant opened with its password, and B's identity in B's keyring. */
  async function started(clock = new Clock()) {
    const a = await create(clock);
    await a.session.createItem(login());
    await a.session.createFolder('Work');
    const caller = new Keyring();
    const grant = a.session.openPairing({ kek: kek(caller), method: 'password' });
    caller.wipeAll();
    const keyringB = new Keyring();
    const identityB = generateDeviceIdentity(keyringB);
    return { a, grant, keyringB, identityB, clock };
  }

  /** B's side of the transfer: the Master Key as `importTransferKey` gives it, and the records. */
  async function transferred(clock = new Clock()) {
    const s = await started(clock);
    await s.grant.admit(s.identityB.publicKey, B_NAME);
    const records = await s.grant.records();
    const masterKey = importTransferKey(s.keyringB, exportTransferKey(s.grant.masterKey));
    return { ...s, records, masterKey };
  }

  async function join(
    t: Awaited<ReturnType<typeof transferred>>,
    records: readonly Uint8Array[] = t.records,
    store = new MemoryStore(),
    replacesVaultId?: Uint8Array,
  ) {
    const session = await VaultSession.join({
      ...(replacesVaultId ? { replacesVaultId } : {}),
      store,
      keyring: t.keyringB,
      kek: kek(t.keyringB, 2),
      salt: SALT,
      kdfParams: PARAMS,
      identity: t.identityB,
      vaultId: t.grant.vaultId,
      masterKey: t.masterKey,
      records,
      peerPublicKey: must(t.a.session.devices()[0]).device.publicKey,
      now: t.clock.now,
    });
    open.push(session);
    return { session, store };
  }

  async function rejection(promise: Promise<unknown>): Promise<string> {
    const error = await promise.catch((e: unknown) => e);
    if (error instanceof JoinRejectedError) return error.reason;
    throw error;
  }

  describe('on A, the device holding the vault', () => {
    it('opens the Master Key with the password again, for this pairing only (D202)', async () => {
      const { a, grant } = await started();
      const keys = keysOf(a.store);
      expect(sameKey(grant.masterKey, keys.masterKey)).toBe(true);
      expect(grant.vaultId).toEqual(a.session.vaultId);
      expect(deviceId(grant.identity.publicKey)).toEqual(a.session.deviceId);
      grant.wipe();
      expect(() => sameKey(grant.masterKey, keys.masterKey)).toThrow(KeyWipedError);
      // The session itself still holds no Master Key and goes on working.
      await a.session.createItem(login('After'));
    });

    it('refuses a password or passkey that does not open the vault', async () => {
      const { session } = await create();
      const caller = new Keyring();
      expect(() => session.openPairing({ kek: kek(caller, 9), method: 'password' })).toThrow(
        UnlockRejectedError,
      );
      expect(() => session.openPairing({ kek: kek(caller), method: 'passkey' })).toThrow(
        UnlockRejectedError,
      );
    });

    it('is refused while read-only, retired, or holding a corrupt record (D45, D102, D202)', async () => {
      const behind = await create();
      behind.session.lock();
      behind.clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
      const readOnly = await unlock(behind.store, behind.clock);
      const caller = new Keyring();
      const refusal = (session: VaultSession) => {
        try {
          session.openPairing({ kek: kek(caller), method: 'password' });
        } catch (error) {
          if (error instanceof PairingRefusedError) return error.reason;
          throw error;
        }
        return 'opened';
      };
      expect(refusal(readOnly)).toBe('read-only');

      const retired = await create();
      const own = must(retired.session.devices()[0]).device.publicKey;
      plantDevice(retired.store, keysOf(retired.store), own, hlcAt(T0 + DAY), true);
      retired.session.lock();
      const again = await unlock(retired.store);
      expect(again.retired).toBe(true);
      expect(refusal(again)).toBe('retired');

      const damaged = await create();
      damaged.store.put({
        recordType: RecordType.item,
        recordId: randomId(),
        envelope: Uint8Array.of(0xa0) as RecordEnvelope,
      });
      damaged.session.lock();
      expect(refusal(await unlock(damaged.store))).toBe('corrupt-record');
    });

    it("writes B's Device record in one commit, with the key and name given (D30)", async () => {
      const { a, grant, identityB, clock } = await started();
      const commits = a.store.commits.length;
      clock.t = T0 + DAY;
      await grant.admit(identityB.publicKey, B_NAME);
      expect(a.store.commits).toHaveLength(commits + 1);
      const [commit] = a.store.commits.slice(-1);
      expect(commit?.put.map((p) => [p.recordType, p.recordId])).toEqual([
        [RecordType.device, deviceId(identityB.publicKey)],
      ]);
      const b = a.session
        .devices()
        .find((d) => idKey(d.deviceId) === idKey(deviceId(identityB.publicKey)));
      expect(b?.device).toEqual({
        publicKey: identityB.publicKey,
        displayName: B_NAME,
        retired: false,
        registeredAt: T0 + DAY,
      });
      // A wrote it: it is seen, and no new-device notice follows (D48).
      expect(localState(a.store).seenDevices).toEqual([deviceId(identityB.publicKey)]);
    });

    it('writes its own Device record too when it holds none (D141)', async () => {
      const source = await create();
      const file = await source.session.exportBackup({
        kek: kek(source.keyring),
        method: 'password',
      });
      const keyring = new Keyring();
      const restored = await VaultSession.restore({
        store: new MemoryStore(),
        keyring,
        kek: kek(keyring, 2),
        salt: SALT,
        kdfParams: PARAMS,
        backup: restoreWithPhrase(keyring, parseBackup(file.bytes), source.words),
        now: new Clock().now,
      });
      open.push(restored);
      expect(restored.registered).toBe(false);
      const caller = new Keyring();
      // It has no name of its own yet: the pairing asks for one.
      expect(() => restored.openPairing({ kek: kek(caller, 2), method: 'password' })).toThrow(
        RangeError,
      );
      const grant = restored.openPairing({
        kek: kek(caller, 2),
        method: 'password',
        displayName: 'Safari on iPhone',
      });
      const identityB = generateDeviceIdentity(new Keyring());
      await grant.admit(identityB.publicKey, B_NAME);
      expect(restored.registered).toBe(true);
      const own = restored.devices().find((d) => idKey(d.deviceId) === idKey(restored.deviceId));
      expect(own?.device.displayName).toBe('Safari on iPhone');
      expect(restored.devices()).toHaveLength(3);
    });

    it('refuses a key that already has a Device record, its own included, writing nothing', async () => {
      const { a, grant, identityB } = await started();
      const own = must(a.session.devices()[0]).device.publicKey;
      const commits = a.store.commits.length;
      await expect(grant.admit(own, B_NAME)).rejects.toThrow(PairingRefusedError);
      await grant.admit(identityB.publicKey, B_NAME);
      const error = await grant.admit(identityB.publicKey, B_NAME).catch((e: unknown) => e);
      expect((error as PairingRefusedError).reason).toBe('known-device');
      expect(a.store.commits).toHaveLength(commits + 1);
    });

    it('reads every stored record again and verifies it before sending it (D181)', async () => {
      const { a, grant, identityB } = await started();
      await grant.admit(identityB.publicKey, B_NAME);
      const records = await grant.records();
      expect(records.map((r) => Buffer.from(r).toString('hex')).sort()).toEqual(
        (await a.store.records()).map((r) => Buffer.from(r.envelope).toString('hex')).sort(),
      );
      // A record damaged in storage after unlock is caught at this read.
      const [item] = a.store.ofType(RecordType.item);
      a.store.put({ ...must(item), envelope: Uint8Array.of(0xa0) as RecordEnvelope });
      const error = await grant.records().catch((e: unknown) => e);
      expect(error).toBeInstanceOf(PairingRefusedError);
      expect((error as PairingRefusedError).reason).toBe('corrupt-record');
      expect((error as PairingRefusedError).record?.recordType).toBe(RecordType.item);
    });

    it('records the completed sync with B, ascending by deviceId (D34)', async () => {
      const { a, grant, identityB, clock } = await started();
      await grant.admit(identityB.publicKey, B_NAME);
      const other = deviceId(generateDeviceIdentity(new Keyring()).publicKey);
      clock.t = T0 + DAY;
      await grant.completed(other);
      clock.t = T0 + 2 * DAY;
      await grant.completed(deviceId(identityB.publicKey));
      clock.t = T0 + 3 * DAY;
      await grant.completed(other);
      expect(a.session.lastSyncByPeer).toEqual(
        sortedHex([other, deviceId(identityB.publicKey)]).map((id) => [
          id,
          idKey(id) === idKey(other) ? T0 + 3 * DAY : T0 + 2 * DAY,
        ]),
      );
    });

    it('wipes the Master Key it opened when the vault locks (D93)', async () => {
      const { a, grant, identityB } = await started();
      const keys = keysOf(a.store);
      a.session.lock();
      expect(() => sameKey(grant.masterKey, keys.masterKey)).toThrow(KeyWipedError);
      await expect(grant.admit(identityB.publicKey, B_NAME)).rejects.toThrow(VaultLockedError);
      await expect(grant.records()).rejects.toThrow(VaultLockedError);
    });
  });

  describe('on B, the joining device', () => {
    it('commits every record and its Local Config in one commit, with its own identity (D33)', async () => {
      const t = await transferred();
      const { session, store } = await join(t);
      expect(store.commits).toHaveLength(1);
      expect(
        (store.commits[0]?.put ?? []).map((p) => Buffer.from(p.envelope).toString('hex')).sort(),
      ).toEqual(t.records.map((r) => Buffer.from(r).toString('hex')).sort());
      expect(session.vaultId).toEqual(t.a.session.vaultId);
      expect(session.deviceId).toEqual(deviceId(t.identityB.publicKey));
      expect(session.registered).toBe(true);
      expect(session.items().map((i) => i.item?.title)).toEqual(['Example']);
      expect(session.folders().map((f) => f.name)).toEqual(['Work']);
      // Seen without a notice (D53), the phrase seen (D43), the sync with A completed (D34).
      expect(session.lastPhraseId).toEqual(t.a.session.lastPhraseId);
      expect(session.lastSyncByPeer).toEqual([[t.a.session.deviceId, T0]]);
      session.lock();
      const again = await unlock(store, new Clock(), 2);
      expect(again.deviceId).toEqual(deviceId(t.identityB.publicKey));
      expect(again.items()).toHaveLength(1);
    });

    it('refuses a newer record before anything else (unsupported-format, D68, D81)', async () => {
      const t = await transferred();
      // A record of a newer format version: the same envelope with v 2.
      const map = decodeCbor(must(t.records[0])) as CborMap;
      map.set('v', RECORD_FORMAT_VERSION + 1);
      const store = new MemoryStore();
      expect(
        await rejection(join(t, [Uint8Array.of(0xa0), ...t.records, encodeCbor(map)], store)),
      ).toBe('unsupported-format');
      expect(store.commits).toEqual([]);
      expect(t.keyringB.wiped).toBe(true);
    });

    it('refuses a record that fails verification (verification-failed)', async () => {
      const t = await transferred();
      const store = new MemoryStore();
      const records = [...t.records];
      const flipped = must(records[1]).slice();
      flipped[flipped.length - 1] = must(flipped[flipped.length - 1]) ^ 1;
      records[1] = flipped;
      expect(await rejection(join(t, records, store))).toBe('verification-failed');
      expect(store.commits).toEqual([]);
      expect(t.keyringB.wiped).toBe(true);
    });

    it('refuses two records of one identity (protocol-error)', async () => {
      const t = await transferred();
      expect(await rejection(join(t, [...t.records, must(t.records[0])]))).toBe('protocol-error');
    });

    it("refuses a transfer without B's own Device record, or without A's (protocol-error)", async () => {
      const t = await transferred();
      const without = (records: readonly Uint8Array[], id: Uint8Array) =>
        records
          .map((r) => ({ r, header: decodeEnvelope(r).header }))
          .filter(
            (d) =>
              !(
                d.header.recordType === RecordType.device && idKey(d.header.recordId) === idKey(id)
              ),
          )
          .map((d) => d.r);
      expect(await rejection(join(t, without(t.records, deviceId(t.identityB.publicKey))))).toBe(
        'protocol-error',
      );
      const u = await transferred();
      expect(await rejection(join(u, without(u.records, u.a.session.deviceId)))).toBe(
        'protocol-error',
      );
    });

    it('refuses a transfer naming identities the handshake did not authenticate (protocol-error, D211)', async () => {
      // A admitted another key than B's, as it would for a man in the middle.
      const t = await transferred();
      const other = generateDeviceIdentity(new Keyring()).publicKey;
      const u = await started();
      await u.grant.admit(other, B_NAME);
      const masterKey = importTransferKey(u.keyringB, exportTransferKey(u.grant.masterKey));
      const store = new MemoryStore();
      expect(
        await rejection(
          join({ ...u, records: await u.grant.records(), masterKey }, undefined, store),
        ),
      ).toBe('protocol-error');
      expect(store.commits).toEqual([]);
      expect(u.keyringB.wiped).toBe(true);

      // The peer the handshake authenticated is not the vault's A.
      const peer = await VaultSession.join({
        store: new MemoryStore(),
        keyring: t.keyringB,
        kek: kek(t.keyringB, 2),
        salt: SALT,
        kdfParams: PARAMS,
        identity: t.identityB,
        vaultId: t.grant.vaultId,
        masterKey: t.masterKey,
        records: t.records,
        peerPublicKey: other,
        now: t.clock.now,
      }).catch((e: unknown) => e);
      expect((peer as JoinRejectedError).reason).toBe('protocol-error');
      expect(t.keyringB.wiped).toBe(true);
    });

    it("refuses a transfer where A's own Device record is retired (retired-peer, D45)", async () => {
      const t = await transferred();
      const keys = keysOf(t.a.store);
      const own = must(
        t.a.session.devices().find((d) => idKey(d.deviceId) === idKey(t.a.session.deviceId)),
      );
      plantDevice(t.a.store, keys, own.device.publicKey, hlcAt(T0 + DAY), true);
      const records = (await t.a.store.records()).map((r) => r.envelope);
      const store = new MemoryStore();
      expect(await rejection(join(t, records, store))).toBe('retired-peer');
      expect(store.commits).toEqual([]);
    });

    it('accepts a record beyond the future-clock bound, read-only until the clock reaches it (D101)', async () => {
      const t = await transferred();
      const keys = keysOf(t.a.store);
      const ahead = new MemoryStore();
      const id = randomId();
      plant(
        ahead,
        keys,
        RecordType.item,
        id,
        hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + DAY),
        false,
        itemToCbor(login('Ahead'), false),
      );
      const { session } = await join(t, [
        ...t.records,
        ...[...ahead.held.values()].map((r) => r.envelope),
      ]);
      expect(session.item(id)?.readOnly).toBe('future-clock');
      expect(session.writable).toBe(true);
    });

    it('joins only into an empty storage (D202)', async () => {
      const t = await transferred();
      const store = new MemoryStore();
      store.put({
        recordType: RecordType.item,
        recordId: randomId(),
        envelope: Uint8Array.of(0) as RecordEnvelope,
      });
      await expect(join(t, t.records, store)).rejects.toThrow(RangeError);
      expect(t.keyringB.wiped).toBe(true);
    });

    it('records the vault it replaces, another one, until forgotten (D89, D96, D150)', async () => {
      const t = await transferred();
      const replaced = randomId();
      const { session, store } = await join(t, t.records, new MemoryStore(), replaced);
      expect(store.commits).toHaveLength(1);
      expect(parseLocalConfig(store.localConfig).replacesVaultId).toEqual(replaced);
      await session.forgetReplacedVault();
      expect(parseLocalConfig(store.localConfig).replacesVaultId).toBeUndefined();
    });

    it('refuses a replaced vaultId that is not an ID, writing nothing', async () => {
      const t = await transferred();
      const store = new MemoryStore();
      await expect(join(t, t.records, store, new Uint8Array(15))).rejects.toThrow(RangeError);
      expect(store.commits).toEqual([]);
      expect(t.keyringB.wiped).toBe(true);
    });

    it('refuses to replace the vault it joins: the same vaultId commits in place (D153)', async () => {
      const t = await transferred();
      const store = new MemoryStore();
      await expect(join(t, t.records, store, t.grant.vaultId.slice())).rejects.toThrow(RangeError);
      expect(store.commits).toEqual([]);
      expect(t.keyringB.wiped).toBe(true);
    });

    it('writes nothing and keeps no key when the commit fails (D33)', async () => {
      const t = await transferred();
      const store = new MemoryStore();
      store.failNext = true;
      await expect(join(t, t.records, store)).rejects.toThrow('storage failure');
      expect(store.held.size).toBe(0);
      expect(store.localConfig).toHaveLength(0);
      expect(t.keyringB.wiped).toBe(true);
    });
  });
});

describe('re-admission (pairing-protocol.md §9, sync-protocol.md §2.3, D22, D29, D35, D49, D206)', () => {
  const H = new Uint8Array(64).fill(0x50);

  /** A Device record of `publicKey`, planted as another device's sync would write it. */
  function plantDevice(
    store: MemoryStore,
    keys: Keys,
    publicKey: Uint8Array,
    hlc: Hlc,
    retired: boolean,
  ) {
    plant(
      store,
      keys,
      RecordType.device,
      deviceId(publicKey),
      hlc,
      false,
      deviceToCbor({ publicKey, displayName: 'Planted', retired, registeredAt: T0 }),
    );
  }

  /** X created the vault and is registered; Y restored X's backup and holds no Device record. */
  async function devices() {
    const clock = new Clock();
    const x = await create(clock);
    await x.session.createItem(login('From X'));
    const file = await x.session.exportBackup({ kek: kek(x.keyring), method: 'password' });
    const keyring = new Keyring();
    const store = new MemoryStore();
    const y = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(file.bytes), x.words),
      now: clock.now,
    });
    open.push(y);
    await y.createItem(login('From Y'));
    return { x, y: { session: y, store }, clock };
  }

  function titles(session: VaultSession): (string | undefined)[] {
    return session
      .items()
      .map((i) => i.item?.title)
      .sort();
  }

  async function rejection(promise: Promise<unknown>): Promise<string> {
    const error = await promise.catch((e: unknown) => e);
    if (error instanceof JoinRejectedError) return error.reason;
    throw error;
  }

  it('confirms the same Master Key both ways, bound to the role and the handshake hash (D29)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const mac = gx.mac('initiator', H);
    expect(gy.checkMac('initiator', H, mac)).toBe(true);
    expect(gy.checkMac('responder', H, mac)).toBe(false);
    expect(gx.checkMac('responder', H, gy.mac('responder', H))).toBe(true);
    // Another vault's device derives another K_readmission.
    const other = await create();
    expect(other.session.openReadmission().checkMac('initiator', H, mac)).toBe(false);
  });

  it('says which Device records it holds, and refuses a retired peer at once (D45, D49)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    expect(gx.held(gy.identity.publicKey)).toEqual({ own: true, peer: false });
    expect(gy.held(gx.identity.publicKey)).toEqual({ own: false, peer: true });
    gy.checkPeer(gx.identity.publicKey);
    gx.checkPeer(gy.identity.publicKey);

    // X's own record retired, as Y holds it: Y refuses X before the nonces.
    plantDevice(y.store, keysOf(x.store), gx.identity.publicKey, hlcAt(T0 + DAY), true);
    y.session.lock();
    const again = await unlock(y.store, new Clock(), 2);
    expect(() => {
      again.openReadmission().checkPeer(gx.identity.publicKey);
    }).toThrow(JoinRejectedError);
  });

  it('writes the records step 4 gives it, in one commit, with the names received (D35)', async () => {
    const { x, y, clock } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const commits = x.store.commits.length;
    clock.t = T0 + DAY;
    await gx.admit({ own: false, peer: true }, gy.identity.publicKey, 'Restored laptop', 'X');
    expect(x.store.commits).toHaveLength(commits + 1);
    const written = x.session
      .devices()
      .find((d) => idKey(d.deviceId) === idKey(y.session.deviceId));
    expect(written?.device).toEqual({
      publicKey: gy.identity.publicKey,
      displayName: 'Restored laptop',
      retired: false,
      registeredAt: T0 + DAY,
    });
    // Nothing to write: no commit.
    const yCommits = y.store.commits.length;
    await gy.admit({ own: false, peer: false }, gx.identity.publicKey, 'X', 'Restored laptop');
    expect(y.store.commits).toHaveLength(yCommits);
  });

  it('writes its own record and the peer’s when it is I and neither is registered', async () => {
    const { x, y } = await devices();
    const gy = y.session.openReadmission();
    const z = generateDeviceIdentity(new Keyring());
    await gy.admit({ own: true, peer: true }, z.publicKey, 'Z', 'Restored laptop');
    expect(y.session.registered).toBe(true);
    const names = y.session
      .devices()
      .map((d) => d.device.displayName)
      .sort();
    expect(names).toEqual(['Chrome on macOS', 'Restored laptop', 'Z']);
    expect(x.session.devices()).toHaveLength(1);
  });

  it('refuses a write that contradicts what it holds (protocol-error), writing nothing', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const commits = x.store.commits.length;
    expect(
      await rejection(gx.admit({ own: true, peer: false }, gy.identity.publicKey, 'Y', 'X')),
    ).toBe('protocol-error');
    expect(
      await rejection(gy.admit({ own: false, peer: true }, gx.identity.publicKey, 'X', 'Y')),
    ).toBe('protocol-error');
    expect(x.store.commits).toHaveLength(commits);
  });

  it('merges both ways: Y becomes registered with X’s items, X gets Y’s, and both record the sync', async () => {
    const { x, y, clock } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    await gx.admit({ own: false, peer: true }, gy.identity.publicKey, 'Restored laptop', 'X');
    const fromX = await gx.records();
    const fromY = await gy.records();
    clock.t = T0 + DAY;
    const commitsY = y.store.commits.length;
    const resultY = await gy.merge(fromX, gx.identity.publicKey);
    const resultX = await gx.merge(fromY, gy.identity.publicKey);
    expect(y.store.commits).toHaveLength(commitsY + 1);
    expect(y.session.registered).toBe(true);
    expect(titles(y.session)).toEqual(['From X', 'From Y']);
    expect(titles(x.session)).toEqual(['From X', 'From Y']);
    expect(resultY.rejected).toEqual([]);
    expect(resultX.rejected).toEqual([]);
    expect(resultY.added).toBeGreaterThan(0);
    expect(y.session.lastSyncByPeer).toEqual([[x.session.deviceId, T0 + DAY]]);
    expect(x.session.lastSyncByPeer).toEqual([[y.session.deviceId, T0 + DAY]]);
    // Y's own record came from X: no new-device notice for it (D48).
    expect(resultY.newDevices).toEqual([]);
  });

  it('a merge with nothing new still records the sync (D206)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    await gx.admit({ own: false, peer: true }, gy.identity.publicKey, 'Y', 'X');
    await gy.merge(await gx.records(), gx.identity.publicKey);
    await gx.merge(await gy.records(), gy.identity.publicKey);
    const result = await gy.merge(await gx.records(), gx.identity.publicKey);
    expect(result).toMatchObject({ added: 0, replaced: 0, versions: 0, rejected: [] });
    expect(y.session.lastSyncByPeer).toHaveLength(1);
  });

  it('rejects and reports a record that fails verification or is beyond the bound, merging the rest (§2.3)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const keys = keysOf(x.store);
    const aheadId = randomId();
    plant(
      x.store,
      keys,
      RecordType.item,
      aheadId,
      hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + DAY),
      false,
      itemToCbor(login('Ahead'), false),
    );
    const records = await x.store.records();
    const items = records.filter((r) => r.recordType === RecordType.item);
    const target = must(items.find((r) => idKey(r.recordId) !== idKey(aheadId)));
    const flipped = target.envelope.slice();
    flipped[flipped.length - 1] = must(flipped[flipped.length - 1]) ^ 1;
    const sent = records.map((r) => (r === target ? flipped : r.envelope));
    const result = await gy.merge(sent, gx.identity.publicKey);
    expect(
      result.rejected
        .map((r) => [r.reason, r.record?.recordType, idKey(r.record?.recordId ?? new Uint8Array())])
        .sort(),
    ).toEqual(
      [
        ['future-clock', RecordType.item, idKey(aheadId)],
        ['verification-failed', RecordType.item, idKey(target.recordId)],
      ].sort(),
    );
    expect(titles(y.session)).toEqual(['From X', 'From Y']);
    expect(y.session.item(aheadId)).toBeUndefined();
    expect(y.session.lastSyncByPeer).toHaveLength(1);
  });

  it('rejects and reports another version of a held Vault Key record, merging the rest (D42)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const keys = keysOf(x.store);
    const header: RecordHeader = {
      recordFormatVersion: RECORD_FORMAT_VERSION,
      recordType: RecordType.vaultKey,
      recordId: vaultKeyRecordId(1),
      keyEpoch: 1,
      hlc: hlcAt(T0 + 10),
      deleted: false,
    };
    const forged = sealVaultKeyRecord(
      header,
      keys.vaultId,
      keys.subkeys.vaultKeyWrap,
      generateKey(new Keyring()),
    );
    const others = (await gx.records()).filter(
      (r) => decodeEnvelope(r).header.recordType !== RecordType.vaultKey,
    );
    const size = y.store.commits.length;
    const result = await gy.merge([forged, ...others], gx.identity.publicKey);
    expect(result.rejected).toEqual([
      {
        reason: 'immutable-record',
        record: { recordType: RecordType.vaultKey, recordId: vaultKeyRecordId(1) },
      },
    ]);
    expect(y.store.commits).toHaveLength(size + 1);
    expect(titles(y.session)).toEqual(['From X', 'From Y']);
  });

  it('refuses a newer record, two of one identity, or a retired peer before writing anything (D45, D206)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const records = await gx.records();
    const commits = y.store.commits.length;
    const map = decodeCbor(must(records[0])) as CborMap;
    map.set('v', RECORD_FORMAT_VERSION + 1);
    expect(await rejection(gy.merge([...records, encodeCbor(map)], gx.identity.publicKey))).toBe(
      'unsupported-format',
    );
    expect(await rejection(gy.merge([...records, must(records[0])], gx.identity.publicKey))).toBe(
      'protocol-error',
    );
    // X's own record arrives retired in the transfer (D49).
    plantDevice(x.store, keysOf(x.store), gx.identity.publicKey, hlcAt(T0 + DAY), true);
    const retired = (await x.store.records()).map((r) => r.envelope);
    expect(await rejection(gy.merge(retired, gx.identity.publicKey))).toBe('retired-peer');
    expect(y.store.commits).toHaveLength(commits);
    expect(y.session.registered).toBe(false);
  });

  it('reports an envelope that does not even decode, with no record named, merging the rest', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const result = await gy.merge(
      [Uint8Array.of(0xa0), ...(await gx.records())],
      gx.identity.publicKey,
    );
    expect(result.rejected).toEqual([{ reason: 'verification-failed' }]);
    expect(titles(y.session)).toEqual(['From X', 'From Y']);
  });

  it('refuses a malformed key or its own key as the peer, and writes only its own record when told', async () => {
    const { x, y } = await devices();
    const gy = y.session.openReadmission();
    await expect(
      gy.admit({ own: false, peer: true }, new Uint8Array(31), 'Z', 'Y'),
    ).rejects.toThrow(RangeError);
    expect(
      await rejection(gy.admit({ own: true, peer: false }, gy.identity.publicKey, 'Y', 'Y')),
    ).toBe('protocol-error');
    await gy.admit(
      { own: true, peer: false },
      x.session.openReadmission().identity.publicKey,
      'X',
      'Y',
    );
    expect(y.session.registered).toBe(true);
    expect(y.session.devices()).toHaveLength(2);
  });

  it('writes nothing once the clock went back past the bound after it started (D102)', async () => {
    const { x, y, clock } = await devices();
    const gy = y.session.openReadmission();
    const xKey = x.session.openReadmission().identity.publicKey;
    const commits = y.store.commits.length;
    clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
    await expect(gy.admit({ own: true, peer: false }, xKey, 'X', 'Y')).rejects.toThrow(
      PairingRefusedError,
    );
    expect(y.store.commits).toHaveLength(commits);
  });

  it('is refused while read-only, retired, or holding a corrupt record (D45, D102)', async () => {
    const refusal = (session: VaultSession) => {
      try {
        session.openReadmission();
      } catch (error) {
        if (error instanceof PairingRefusedError) return error.reason;
        throw error;
      }
      return 'opened';
    };
    const behind = await create();
    behind.session.lock();
    behind.clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
    expect(refusal(await unlock(behind.store, behind.clock))).toBe('read-only');

    const retired = await create();
    const own = must(retired.session.devices()[0]).device.publicKey;
    plantDevice(retired.store, keysOf(retired.store), own, hlcAt(T0 + DAY), true);
    retired.session.lock();
    expect(refusal(await unlock(retired.store))).toBe('retired');

    const damaged = await create();
    damaged.store.put({
      recordType: RecordType.item,
      recordId: randomId(),
      envelope: Uint8Array.of(0xa0) as RecordEnvelope,
    });
    damaged.session.lock();
    expect(refusal(await unlock(damaged.store))).toBe('corrupt-record');
  });

  it('does nothing once the vault locks (D93)', async () => {
    const { x, y } = await devices();
    const gx = x.session.openReadmission();
    const gy = y.session.openReadmission();
    const records = await gx.records();
    y.session.lock();
    expect(() => gy.mac('initiator', H)).toThrow(VaultLockedError);
    await expect(gy.merge(records, gx.identity.publicKey)).rejects.toThrow(VaultLockedError);
    await expect(gy.records()).rejects.toThrow(VaultLockedError);
  });
});

describe('sync (sync-protocol.md §3, D113, D216)', () => {
  /** A Device record of `publicKey`, planted as another device's sync would write it. */
  function plantDevice(
    store: MemoryStore,
    keys: Keys,
    publicKey: Uint8Array,
    hlc: Hlc,
    retired = false,
  ) {
    plant(
      store,
      keys,
      RecordType.device,
      deviceId(publicKey),
      hlc,
      false,
      deviceToCbor({ publicKey, displayName: 'Phone', retired, registeredAt: T0 }),
    );
  }

  /** X created the vault and holds the Device record of another device, the peer. */
  async function withPeer(clock = new Clock()) {
    const x = await create(clock);
    const peer = generateDeviceIdentity(new Keyring());
    plantDevice(x.store, keysOf(x.store), peer.publicKey, hlcAt(T0));
    x.session.lock();
    const session = await unlock(x.store, clock);
    return { ...x, session, peer };
  }

  function refusal(session: VaultSession, peer: Uint8Array): string {
    try {
      session.openSync(peer);
    } catch (error) {
      if (error instanceof SyncRefusedError) return error.reason;
      throw error;
    }
    return 'opened';
  }

  it("opens with this device's identity, the vault and the peer's key and name from its record", async () => {
    const { session, peer } = await withPeer();
    const grant = session.openSync(peer.deviceId);
    expect(deviceId(grant.identity.publicKey)).toEqual(session.deviceId);
    expect(grant.vaultId).toEqual(session.vaultId);
    expect(grant.peerPublicKey).toEqual(peer.publicKey);
    expect(grant.peerDeviceId).toEqual(peer.deviceId);
    expect(grant.peerName).toBe('Phone');
  });

  it('refuses an unknown peer, this device itself, and a retired peer (§3, D31)', async () => {
    const { session, peer } = await withPeer();
    expect(refusal(session, randomId())).toBe('unknown-peer');
    expect(refusal(session, session.deviceId)).toBe('unknown-peer');
    await session.retireDevice(peer.deviceId);
    expect(refusal(session, peer.deviceId)).toBe('retired-peer');
  });

  it('refuses a device with no Device record of its own, or a retired one (D41, D113)', async () => {
    const x = await withPeer();
    const file = await x.session.exportBackup({ kek: kek(new Keyring()), method: 'password' });
    const keyring = new Keyring();
    const restored = await VaultSession.restore({
      store: new MemoryStore(),
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(file.bytes), x.words),
      now: x.clock.now,
    });
    open.push(restored);
    expect(restored.registered).toBe(false);
    expect(refusal(restored, x.peer.deviceId)).toBe('unregistered');

    const own = x.session.deviceId;
    const ownKey = must(x.session.devices().find((d) => idKey(d.deviceId) === idKey(own))).device
      .publicKey;
    plantDevice(x.store, keysOf(x.store), ownKey, hlcAt(T0 + DAY), true);
    x.session.lock();
    const retired = await unlock(x.store, x.clock);
    expect(retired.retired).toBe(true);
    expect(refusal(retired, x.peer.deviceId)).toBe('retired');
  });

  it('opens while read-only for a clock gone back, and while a record is kept aside (§3, §7)', async () => {
    const x = await withPeer();
    x.session.lock();
    x.clock.t = T0 - FUTURE_CLOCK_BOUND_MS - DAY;
    const behind = await unlock(x.store, x.clock);
    expect(behind.writable).toBe(false);
    expect(refusal(behind, x.peer.deviceId)).toBe('opened');

    const y = await withPeer();
    y.store.put({
      recordType: RecordType.item,
      recordId: randomId(),
      envelope: Uint8Array.of(0xa0) as RecordEnvelope,
    });
    y.session.lock();
    const damaged = await unlock(y.store, y.clock);
    expect(damaged.corrupt()).toHaveLength(1);
    expect(refusal(damaged, y.peer.deviceId)).toBe('opened');
  });

  it('is refused once the vault locks (D93)', async () => {
    const { session, peer } = await withPeer();
    const grant = session.openSync(peer.deviceId);
    session.lock();
    expect(() => session.openSync(peer.deviceId)).toThrow(VaultLockedError);
    await expect(grant.peerRetirement()).rejects.toThrow(VaultLockedError);
    await expect(grant.mergeOwnRetirement(new Uint8Array(8))).rejects.toThrow(VaultLockedError);
  });

  it('opens a retirement notice only to a retired peer, and a sync only to one not retired (D219)', async () => {
    const { session, peer } = await withPeer();
    const notice = (id: Uint8Array) => {
      try {
        session.openSync(id, 'retirement');
      } catch (error) {
        if (error instanceof SyncRefusedError) return error.reason;
        throw error;
      }
      return 'opened';
    };
    expect(notice(peer.deviceId)).toBe('not-retired');
    expect(notice(randomId())).toBe('unknown-peer');
    await session.retireDevice(peer.deviceId);
    expect(notice(peer.deviceId)).toBe('opened');
    expect(refusal(session, peer.deviceId)).toBe('retired-peer');
  });

  describe('retired peer (§6, D31, D45, D219)', () => {
    const own = (session: VaultSession) =>
      must(session.devices().find((d) => idKey(d.deviceId) === idKey(session.deviceId)));

    /** This device's own Device record, sealed under the vault's keys as another device writes it. */
    function ownRecord(
      x: { store: MemoryStore; session: VaultSession },
      changes: { retired?: boolean; hlc?: Hlc } = {},
    ): Uint8Array {
      const scratch = new MemoryStore();
      const { device } = own(x.session);
      plant(
        scratch,
        keysOf(x.store),
        RecordType.device,
        x.session.deviceId,
        changes.hlc ?? hlcAt(T0 + 1000),
        false,
        deviceToCbor({
          publicKey: device.publicKey,
          displayName: device.displayName,
          retired: changes.retired ?? true,
          registeredAt: T0,
        }),
      );
      return must(scratch.ofType(RecordType.device)[0]).envelope;
    }

    it('gives nothing for a peer not retired, and the stored record once retired', async () => {
      const { session, store, peer } = await withPeer();
      const grant = session.openSync(peer.deviceId);
      expect(await grant.peerRetirement()).toBeUndefined();
      // Retired after the sync started, as when the user retires it meanwhile.
      await session.retireDevice(peer.deviceId);
      const sent = must(await grant.peerRetirement());
      const stored = must(store.get({ recordType: RecordType.device, recordId: peer.deviceId }));
      expect(sent).toEqual(stored.envelope);
      expect(decodeEnvelope(sent).header.recordId).toEqual(peer.deviceId);
    });

    it('refuses to send a stored retired record that fails verification (verification-failed)', async () => {
      const { session, store, peer } = await withPeer();
      await session.retireDevice(peer.deviceId);
      const grant = session.openSync(peer.deviceId, 'retirement');
      const k = { recordType: RecordType.device, recordId: peer.deviceId };
      const envelope = must(store.get(k)).envelope;
      store.put({
        ...k,
        envelope: Uint8Array.from(envelope, (b, i) =>
          i === envelope.length - 1 ? b ^ 1 : b,
        ) as RecordEnvelope,
      });
      await expect(grant.peerRetirement()).rejects.toThrow(
        expect.objectContaining({ name: 'SyncRejectedError', reason: 'verification-failed' }),
      );
      // A valid retired record, but not the one held: another write than the one unlocked.
      plantDevice(store, keysOf(store), peer.publicKey, hlcAt(T0 + 5), true);
      await expect(grant.peerRetirement()).rejects.toThrow(SyncRejectedError);
      // Gone from storage.
      store.held.clear();
      await expect(grant.peerRetirement()).rejects.toThrow(SyncRejectedError);
    });

    it('merges its own record retired, with no retired-devices notice, and keeps it', async () => {
      const x = await withPeer();
      const grant = x.session.openSync(x.peer.deviceId);
      const result = await grant.mergeOwnRetirement(ownRecord(x));
      expect(result.retiredDevices).toEqual([]);
      expect(result.newDevices).toEqual([]);
      expect(x.session.retired).toBe(true);
      // No completed sync: the session never reached its commit (D34).
      expect(x.session.lastSyncByPeer).toEqual([]);
      x.session.lock();
      const again = await unlock(x.store, x.clock);
      expect(again.retired).toBe(true);
    });

    it.each([
      ['its own record not retired, newer', { retired: false, hlc: hlcAt(T0 + DAY / 2) }],
      [
        'its own record beyond the future-clock bound',
        { hlc: hlcAt(T0 + FUTURE_CLOCK_BOUND_MS + DAY) },
      ],
    ])('refuses %s (protocol-error), writing nothing', async (_case, change) => {
      const x = await withPeer();
      const grant = x.session.openSync(x.peer.deviceId);
      const envelope = ownRecord(x, change);
      const before = await x.store.records();
      await expect(grant.mergeOwnRetirement(envelope)).rejects.toThrow(
        expect.objectContaining({ name: 'SyncRejectedError', reason: 'protocol-error' }),
      );
      expect(await x.store.records()).toEqual(before);
      expect(x.session.retired).toBe(false);
    });

    it("refuses another device's retired record, another type, a tampered or malformed envelope", async () => {
      const x = await withPeer();
      const grant = x.session.openSync(x.peer.deviceId);
      const keys = keysOf(x.store);
      const scratch = new MemoryStore();
      plantDevice(scratch, keys, x.peer.publicKey, hlcAt(T0 + 1000), true);
      plant(
        scratch,
        keys,
        RecordType.item,
        x.session.deviceId,
        hlcAt(T0 + 1000),
        false,
        itemToCbor(login(), false),
      );
      const others = [
        must(scratch.ofType(RecordType.device)[0]).envelope,
        must(scratch.ofType(RecordType.item)[0]).envelope,
      ];
      const mine = ownRecord(x);
      const bad = [
        ...others,
        Uint8Array.from(mine, (b, i) => (i === mine.length - 1 ? b ^ 1 : b)),
        mine.subarray(0, 20),
        new Uint8Array(0),
      ];
      const before = await x.store.records();
      for (const envelope of bad) {
        await expect(grant.mergeOwnRetirement(envelope)).rejects.toThrow(SyncRejectedError);
      }
      expect(await x.store.records()).toEqual(before);
      expect(x.session.retired).toBe(false);
    });
  });
});

describe('sync transfer (sync-protocol.md §7 to §9, D69, D73, D109, D222)', () => {
  /** X created the vault; Y restored its backup, then both re-admitted: each holds the other. */
  async function peers() {
    const clock = new Clock();
    const x = await create(clock);
    await x.session.createItem(login('From X'));
    const file = await x.session.exportBackup({ kek: kek(x.keyring), method: 'password' });
    const keyring = new Keyring();
    const store = new MemoryStore();
    const y = await VaultSession.restore({
      store,
      keyring,
      kek: kek(keyring, 2),
      salt: SALT,
      kdfParams: PARAMS,
      backup: restoreWithPhrase(keyring, parseBackup(file.bytes), x.words),
      now: clock.now,
    });
    open.push(y);
    const gx = x.session.openReadmission();
    const gy = y.openReadmission();
    await gx.admit({ own: false, peer: true }, gy.identity.publicKey, 'Y', 'X');
    await gy.merge(await gx.records(), gx.identity.publicKey);
    await gx.merge(await gy.records(), gy.identity.publicKey);
    return {
      clock,
      x: { ...x, grant: x.session.openSync(y.deviceId) },
      y: { session: y, store, grant: y.openSync(x.session.deviceId) },
    };
  }

  const keyOf = (r: { recordType: number; recordId: Uint8Array }) =>
    `${String(r.recordType)}:${idKey(r.recordId)}`;

  function titles(session: VaultSession): (string | undefined)[] {
    return session
      .items()
      .map((i) => i.item?.title)
      .sort();
  }

  async function rejection(promise: Promise<unknown>): Promise<string> {
    const error = await promise.catch((e: unknown) => e);
    if (error instanceof SyncRejectedError) return error.reason;
    throw error;
  }

  it('summarizes every record held by its header, but those kept aside as corrupt (§7)', async () => {
    const { x } = await peers();
    const stored = await x.store.records();
    const summary = x.grant.summary();
    expect(summary.map(keyOf).sort()).toEqual(stored.map(keyOf).sort());
    for (const r of stored) {
      const { header } = decodeEnvelope(r.envelope);
      expect(summary.find((e) => keyOf(e) === keyOf(r))).toEqual({
        recordFormatVersion: header.recordFormatVersion,
        recordType: header.recordType,
        recordId: header.recordId,
        hlc: header.hlc,
        deleted: header.deleted,
        keyEpoch: header.keyEpoch,
      });
    }
    const damaged = randomId();
    x.store.put({
      recordType: RecordType.item,
      recordId: damaged,
      envelope: Uint8Array.of(0xa0) as RecordEnvelope,
    });
    x.session.lock();
    const again = await unlock(x.store, x.clock);
    const ids = again
      .openSync(must(again.devices().find((d) => !sameId(d.deviceId, again.deviceId))).deviceId)
      .summary()
      .map(keyOf);
    expect(ids).toHaveLength(stored.length);
    expect(ids).not.toContain(keyOf({ recordType: RecordType.item, recordId: damaged }));
  });

  function sameId(a: Uint8Array, b: Uint8Array): boolean {
    return idKey(a) === idKey(b);
  }

  it('reads the records selected again and verifies them, skipping one gone meanwhile (§8, D181)', async () => {
    const { x } = await peers();
    const summary = x.grant.summary();
    const items = summary.filter((e) => e.recordType === RecordType.item);
    const gone = { ...must(items[0]), recordId: randomId() };
    const envelopes = await x.grant.records([...items, gone]);
    const stored = await x.store.records();
    expect(envelopes).toEqual(
      items.map((e) => must(stored.find((r) => keyOf(r) === keyOf(e))).envelope),
    );

    const target = must(stored.find((r) => r.recordType === RecordType.item));
    const flipped = target.envelope.slice() as RecordEnvelope;
    flipped[flipped.length - 1] = must(flipped[flipped.length - 1]) ^ 1;
    x.store.put({ ...target, envelope: flipped });
    const error = await x.grant.records(items).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(SyncRejectedError);
    expect(error).toMatchObject({
      reason: 'verification-failed',
      record: { recordType: RecordType.item, recordId: target.recordId },
    });
  });

  it('merges the peer’s records both ways in one commit each, recording the sync (§9, D34)', async () => {
    const { clock, x, y } = await peers();
    const edited = must(y.session.items().find((i) => i.item?.title === 'From X')).id;
    clock.t = T0 + DAY;
    await y.session.updateItem(edited, login('Edited on Y'));
    await y.session.createItem(login('New on Y'));
    await x.session.createItem(login('New on X'));
    const fromY = await y.grant.records(y.grant.summary());
    const fromX = await x.grant.records(x.grant.summary());
    clock.t = T0 + 2 * DAY;
    const commits = x.store.commits.length;
    const result = await x.grant.merge(fromY);
    expect(x.store.commits).toHaveLength(commits + 1);
    await y.grant.merge(fromX);
    expect(titles(x.session)).toEqual(['Edited on Y', 'New on X', 'New on Y']);
    expect(titles(y.session)).toEqual(['Edited on Y', 'New on X', 'New on Y']);
    expect(result).toMatchObject({ added: 1, replaced: 1, rejected: [], ownRetired: false });
    // The edit's loser went to history on Y already: X adds Y's version of it.
    expect(result.versions).toBeGreaterThan(0);
    expect(x.session.lastSyncByPeer).toEqual([[y.session.deviceId, T0 + 2 * DAY]]);
    // A second exchange changes nothing but the date.
    const again = await x.grant.merge(await y.grant.records(y.grant.summary()));
    expect(again).toMatchObject({ added: 0, replaced: 0, versions: 0, rejected: [] });
  });

  it('rejects and reports a record that fails verification, is newer or breaks D42, merging the rest (§9, D68)', async () => {
    const { x, y } = await peers();
    await y.session.createItem(login('Good'));
    const records = await y.grant.records(y.grant.summary());
    const keys = keysOf(x.store);
    const tampered = (await y.store.records()).find((r) => r.recordType === RecordType.item);
    const flipped = must(tampered).envelope.slice();
    flipped[flipped.length - 1] = must(flipped[flipped.length - 1]) ^ 1;
    const newer = decodeCbor(must(records[0])) as CborMap;
    newer.set('v', RECORD_FORMAT_VERSION + 1);
    const forged = sealVaultKeyRecord(
      {
        recordFormatVersion: RECORD_FORMAT_VERSION,
        recordType: RecordType.vaultKey,
        recordId: vaultKeyRecordId(1),
        keyEpoch: 1,
        hlc: hlcAt(T0 + 10),
        deleted: false,
      },
      keys.vaultId,
      keys.subkeys.vaultKeyWrap,
      generateKey(new Keyring()),
    );
    const sent = [
      ...records.filter(
        (r) =>
          !sameId(decodeEnvelope(r).header.recordId, must(tampered).recordId) &&
          decodeEnvelope(r).header.recordType !== RecordType.vaultKey,
      ),
      flipped,
      encodeCbor(newer),
      forged,
    ];
    const result = await x.grant.merge(sent);
    expect(result.rejected.map((r) => [r.reason, r.record?.recordType ?? null]).sort()).toEqual(
      [
        ['immutable-record', RecordType.vaultKey],
        ['unsupported-format', null],
        ['verification-failed', RecordType.item],
      ].sort(),
    );
    expect(titles(x.session)).toContain('Good');
  });

  it('reports each local write to watch with the records it wrote, and no merge, purge or cut (§10, D225)', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });
    const { clock, x, y } = await peers();
    const seen: Map<string, string>[] = [];
    const hex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');
    const stop = x.grant.watch((envelopes) => {
      seen.push(new Map(envelopes.map((e) => [keyOf(decodeEnvelope(e).header), hex(e)] as const)));
    });
    const stored = async () =>
      new Map((await x.store.records()).map((r) => [keyOf(r), hex(r.envelope)] as const));
    /** What `write` changed in storage: the records it added or replaced, as stored. */
    const written = async (write: () => Promise<unknown>) => {
      const before = await stored();
      await write();
      return new Map([...(await stored())].filter(([k, v]) => before.get(k) !== v));
    };

    const id = randomId();
    const changes = [
      await written(async () => {
        id.set(await x.session.createItem(login('Live')));
      }),
      await written(() => x.session.updateItem(id, login('Live, edited'))),
      await written(() => x.session.trashItem(id)),
    ];
    // Each local write reports exactly what it stored: the item, then the item and a version.
    expect(seen).toEqual(changes);
    expect(changes.map((c) => c.size)).toEqual([1, 2, 2]);

    // A merge of the peer's records, the purge and the history cut issue no HLC: nothing reported.
    await y.session.createItem(login('From Y'));
    await x.grant.merge(await y.grant.records(y.grant.summary()));
    clock.t += PURGE_DELAY_MS + DAY;
    await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
    expect(x.session.item(id)).toBeUndefined();
    expect(seen).toHaveLength(3);

    stop();
    await x.session.createItem(login('Not watched'));
    expect(seen).toHaveLength(3);
  });

  it('rejects and reports a Recovery Envelope changed under the held phraseId, merging the rest (§1.3, D44)', async () => {
    const { x, y } = await peers();
    await y.session.createItem(login('Good'));
    const keys = keysOf(x.store);
    const held = must(x.session.recovery);
    const phrase = typed(x.words);
    // Newer than the held envelope: it would win last-write-wins if it were not rejected.
    const forged = sealRecoveryEnvelope(
      {
        recordFormatVersion: RECORD_FORMAT_VERSION,
        recordType: RecordType.recoveryEnvelope,
        recordId: recoveryEnvelopeRecordId(keys.vaultId),
        keyEpoch: 1,
        hlc: hlcAt(T0 + 5000),
        deleted: false,
      },
      keys.vaultId,
      keys.vaultKey,
      phrase.envelopeKey,
      keys.masterKey,
      new Map<CborValue, CborValue>([
        ['keyslotPublicKey', held.keyslotPublicKey],
        ['phraseCreatedAt', held.phraseCreatedAt],
        ['phraseId', held.phraseId],
      ]),
    );
    const sent = [
      ...(await y.grant.records(y.grant.summary())).filter(
        (r) => decodeEnvelope(r).header.recordType !== RecordType.recoveryEnvelope,
      ),
      forged,
    ];
    const result = await x.grant.merge(sent);
    expect(result.rejected).toEqual([
      {
        reason: 'immutable-record',
        record: {
          recordType: RecordType.recoveryEnvelope,
          recordId: recoveryEnvelopeRecordId(keys.vaultId),
        },
      },
    ]);
    expect(titles(x.session)).toContain('Good');
    expect(x.session.recovery).toEqual(held);
    expect(x.session.lastPhraseId).toEqual(held.phraseId);
    expect(result.phraseChanged).toBe(false);
  });

  it('rejects a record beyond the future-clock bound, then accepts it once the clock reaches it (§9, D19, D76)', async () => {
    const { clock, x, y } = await peers();
    const aheadId = randomId();
    const at = T0 + FUTURE_CLOCK_BOUND_MS + DAY;
    plant(
      y.store,
      keysOf(y.store, 2),
      RecordType.item,
      aheadId,
      hlcAt(at),
      false,
      itemToCbor(login('Ahead'), false),
    );
    const sent = (await y.store.records()).map((r) => r.envelope);
    const first = await x.grant.merge(sent);
    expect(first.rejected).toEqual([
      { reason: 'future-clock', record: { recordType: RecordType.item, recordId: aheadId } },
    ]);
    expect(x.session.item(aheadId)).toBeUndefined();
    clock.t = at - FUTURE_CLOCK_BOUND_MS;
    const second = await x.grant.merge(sent);
    expect(second.rejected).toEqual([]);
    expect(x.session.item(aheadId)?.item?.title).toBe('Ahead');
  });

  it('merges while read-only for a clock gone back, issuing no HLC (§1.5, D73, D109)', async () => {
    const { clock, x, y } = await peers();
    // X wrote with its clock 3 days ahead, then the clock came back: X's HLC state is beyond its cap.
    clock.t = T0 + 3 * DAY;
    await x.session.createItem(login('Ahead on X'));
    clock.t = T0 + DAY;
    const edited = must(y.session.items().find((i) => i.item?.title === 'From X')).id;
    await y.session.updateItem(edited, login('Edited on Y'));
    const sent = await y.grant.records(y.grant.summary());
    x.session.lock();
    const session = await unlock(x.store, clock);
    expect(session.writable).toBe(false);
    const grant = session.openSync(y.session.deviceId);
    const commits = x.store.commits.length;
    const result = await grant.merge(sent);
    expect(result.rejected).toEqual([]);
    expect(x.store.commits).toHaveLength(commits + 1);
    // Every record written carries an HLC of the transfer, its loser's included: none is new.
    const hlcKey = (h: Hlc) => `${String(h.physicalMs)}.${String(h.counter)}.${idKey(h.deviceId)}`;
    const received = new Set(sent.map((r) => hlcKey(decodeEnvelope(r).header.hlc)));
    const written = must(x.store.commits.at(-1)).put.map((r) => decodeEnvelope(r.envelope).header);
    expect(written.length).toBeGreaterThan(0);
    for (const header of written) expect(received.has(hlcKey(header.hlc))).toBe(true);
    expect(titles(session)).toEqual(['Ahead on X', 'Edited on Y']);
    expect(session.writable).toBe(false);
  });

  it.each(['writable', 'read-only for a clock gone back'])(
    'purges on arrival an item in the trash past its date, with its history, %s (§1.3, §1.4, D7, D73, D94)',
    async (state) => {
      const { clock, x, y } = await peers();
      clock.t = T0 + 1000;
      const id = await y.session.createItem(login('On Y'));
      await y.session.updateItem(id, login('Edited on Y'));
      await y.session.trashItem(id);
      const sent = await y.grant.records(y.grant.summary());
      if (state !== 'writable') {
        // X wrote with its clock 40 days ahead, then the clock came back past the purge date.
        clock.t = T0 + 40 * DAY;
        await x.session.createItem(login('Ahead on X'));
      }
      clock.t = T0 + 1000 + PURGE_DELAY_MS;
      x.session.lock();
      const session = await unlock(x.store, clock);
      expect(session.writable).toBe(state === 'writable');
      const grant = session.openSync(y.session.deviceId);
      const result = await grant.merge(sent);
      expect(result).toMatchObject({ added: 1, rejected: [], droppedLosers: [] });
      expect(session.item(id)).toBeUndefined();
      expect(session.versions(id)).toEqual([]);
      // The tombstone is kept, under the header Y sent.
      const entry = grant
        .summary()
        .find((e) => e.recordType === RecordType.item && sameId(e.recordId, id));
      expect(entry).toMatchObject({ deleted: true, hlc: must(y.session.item(id)).hlc });
      expect(session.writable).toBe(state === 'writable');
    },
  );

  it('merges the peer’s own record retired in a transfer, so the check of §6 finds it (D69, D220)', async () => {
    const { x, y } = await peers();
    // A third device retired X; Y carries that record.
    const xKey = must(y.session.devices().find((d) => sameId(d.deviceId, x.session.deviceId)))
      .device.publicKey;
    plant(
      y.store,
      keysOf(y.store, 2),
      RecordType.device,
      x.session.deviceId,
      hlcAt(T0 + DAY),
      false,
      deviceToCbor({ publicKey: xKey, displayName: 'X', retired: true, registeredAt: T0 }),
    );
    const sent = (await y.store.records()).map((r) => r.envelope);
    // Y merges X's records: nothing retires Y. X merges its own record retired.
    const result = await x.grant.merge(sent);
    expect(result.ownRetired).toBe(true);
    expect(x.session.retired).toBe(true);
    expect(x.session.lastSyncByPeer).toHaveLength(1);
  });

  it('merges the peer’s record retired, which peerRetirement then sends back (D69, D220)', async () => {
    const { x, y } = await peers();
    // Y cannot retire its peer through the grant: a third device's retirement of Y, carried by Y.
    const yKey = must(x.session.devices().find((d) => sameId(d.deviceId, y.session.deviceId)))
      .device.publicKey;
    plant(
      y.store,
      keysOf(y.store, 2),
      RecordType.device,
      y.session.deviceId,
      hlcAt(T0 + DAY),
      false,
      deviceToCbor({ publicKey: yKey, displayName: 'Y', retired: true, registeredAt: T0 }),
    );
    const sent = (await y.store.records()).map((r) => r.envelope);
    const result = await x.grant.merge(sent);
    expect(result.ownRetired).toBe(false);
    expect(result.retiredDevices.map((d) => idKey(d.deviceId))).toContain(
      idKey(y.session.deviceId),
    );
    expect(await x.grant.peerRetirement()).toBeInstanceOf(Uint8Array);
  });

  it('refuses two records of one identity (protocol-error), writing nothing (§2.1)', async () => {
    const { x, y } = await peers();
    const records = await y.grant.records(y.grant.summary());
    const commits = x.store.commits.length;
    expect(await rejection(x.grant.merge([...records, must(records[0])]))).toBe('protocol-error');
    expect(x.store.commits).toHaveLength(commits);
  });

  it.each(['in the order sent', 'reversed'])(
    'keeps the versions of a restore from the trash at a device that purged the item, %s (§1.4, D137)',
    async (order) => {
      vi.useFakeTimers();
      const { clock, x, y } = await peers();
      const id = must(x.session.items().find((i) => i.item?.title === 'From X')).id;
      clock.t = T0 + 1000;
      await x.session.updateItem(id, login('Edited on X'));
      await x.session.trashItem(id);
      await y.grant.merge(await x.grant.records(x.grant.summary()));
      clock.t = T0 + 29 * DAY;
      await x.session.restoreItem(id);
      clock.t = T0 + 31 * DAY;
      await vi.advanceTimersByTimeAsync(MAINTENANCE_INTERVAL_MS);
      expect(y.session.item(id)).toBeUndefined();
      expect(y.session.versions(id)).toEqual([]);

      const records = await x.grant.records(x.grant.summary());
      const result = await y.grant.merge(order === 'reversed' ? records.reverse() : records);
      expect(result).toMatchObject({ rejected: [], droppedLosers: [] });
      expect(y.session.item(id)).toMatchObject({ inTrash: false, item: { title: 'Edited on X' } });
      const history = (s: VaultSession) => s.versions(id).map((v) => [v.hlc, v.item?.title]);
      expect(x.session.versions(id)).toHaveLength(3);
      expect(history(y.session)).toEqual(history(x.session));
    },
  );

  it('does nothing once the vault locks (D93)', async () => {
    const { x, y } = await peers();
    const records = await y.grant.records(y.grant.summary());
    x.session.lock();
    expect(() => x.grant.summary()).toThrow(VaultLockedError);
    await expect(x.grant.records([])).rejects.toThrow(VaultLockedError);
    await expect(x.grant.merge(records)).rejects.toThrow(VaultLockedError);
  });
});
