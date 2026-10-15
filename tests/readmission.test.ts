// Gate C (Phase 4): a re-admission end to end over the in-memory transport, through the real
// Noise_XX handshake, the SAS confirmation, the key-confirmation MACs, the Device records of step 4
// and the merge in both directions, with both vaults in IndexedDB (pairing-protocol.md §9,
// sync-protocol.md §2.3, D22, D29, D35, D49, D206). The app will wire sync to the vault the same way.

import { parseBackup, restoreWithPhrase } from '@blindvault/backup';
import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  derivePrfKek,
  generateRecoveryPhrase,
  initCrypto,
  pairingNonce,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import {
  PairingError,
  PairingSession,
  type Role,
  TransferRefusal,
  encodePayload,
  exchangeNonces,
  memoryPair,
  pairingHandshake,
  readmit,
} from '@blindvault/sync';
import {
  type ItemInput,
  JoinRejectedError,
  PairingRefusedError,
  type RecordStore,
  VaultLockedError,
  VaultSession,
  parseLocalConfig,
} from '@blindvault/vault';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

beforeAll(initCrypto);

const T0 = 1_760_000_000_000;
const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };

/** A reproducible KEK: a PRF KEK of a fixed output, standing in for Argon2id here. */
function kek(keyring: Keyring, seed: number): SymmetricKey {
  const authenticatorData = new Uint8Array(37);
  authenticatorData[32] = 0x05;
  return derivePrfKek(keyring, { authenticatorData, prfOutput: new Uint8Array(32).fill(seed) });
}

function login(title: string): ItemInput {
  return {
    templateId: 'login',
    templateVersion: 1,
    title,
    fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
    tags: [],
  };
}

const sessions: VaultSession[] = [];
const opened: VaultDatabase[] = [];

afterEach(() => {
  for (const s of sessions.splice(0)) s.lock();
  for (const d of opened.splice(0)) d.close();
});

/** A store that opens the vault's database at its first commit, as the app does. */
function lazyStore(factory: IDBFactory) {
  let db: VaultDatabase | undefined;
  const store: RecordStore = {
    records: () => (db ? db.records() : Promise.resolve([])),
    commit: async (commit) => {
      if (!db) {
        db = await VaultDatabase.open(parseLocalConfig(commit.localConfig).vaultId, factory);
        opened.push(db);
      }
      await db.commit(commit);
    },
  };
  return store;
}

/** The abort reason a vault error stands for (pairing-protocol.md §10.3), as the app maps it. */
function refusal(error: unknown): unknown {
  if (error instanceof JoinRejectedError) {
    return new TransferRefusal(error.reason, { cause: error });
  }
  if (error instanceof VaultLockedError) return new TransferRefusal('locked', { cause: error });
  if (error instanceof PairingRefusedError) {
    const reason = error.reason === 'corrupt-record' ? 'verification-failed' : 'protocol-error';
    return new TransferRefusal(reason, { cause: error });
  }
  return error;
}

function mapped<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    throw refusal(error);
  });
}

interface Device {
  readonly factory: IDBFactory;
  readonly session: VaultSession;
  readonly seed: number;
  readonly name: string;
  /** Kept apart: a locked session no longer gives it. */
  readonly vaultId: Uint8Array;
}

/** A created vault, registered, with one item. */
async function created(name: string): Promise<Device & { words: string }> {
  const factory = new IDBFactory();
  const keyring = new Keyring();
  const phrase = generateRecoveryPhrase(keyring);
  const session = await VaultSession.create({
    store: lazyStore(factory),
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: phrase.entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: name,
    now: () => T0,
  });
  sessions.push(session);
  await session.createItem(login(`From ${name}`));
  return { factory, session, seed: 1, name, words: phrase.words, vaultId: session.vaultId };
}

/** A fresh restore of `source`'s backup, unregistered (D30), with one item of its own. */
async function restored(source: Device & { words: string }, name: string, seed: number) {
  const caller = new Keyring();
  const file = await source.session.exportBackup({
    kek: kek(caller, source.seed),
    method: 'password',
  });
  caller.wipeAll();
  const factory = new IDBFactory();
  const keyring = new Keyring();
  const session = await VaultSession.restore({
    store: lazyStore(factory),
    keyring,
    kek: kek(keyring, seed),
    salt: new Uint8Array(16).fill(8),
    kdfParams: PARAMS,
    backup: restoreWithPhrase(keyring, parseBackup(file.bytes), source.words),
    now: () => T0,
  });
  sessions.push(session);
  await session.createItem(login(`From ${name}`));
  return { factory, session, seed, name, vaultId: session.vaultId };
}

interface Run {
  /** The responder's answer to the SAS. */
  readonly answer?: 'confirm' | 'sas-mismatch';
  /** Runs on the responder once the transfer is in, before its merge. */
  readonly beforeMerge?: (responder: VaultSession) => void;
}

/** One re-admission: `i` shows the first payload, `r` answers; both hold the vault. */
async function readmission(i: Device, r: Device, run: Run = {}) {
  const grantI = i.session.openReadmission();
  const grantR = r.session.openReadmission();
  const drawn = pairingNonce();
  const base = {
    sessionId: new Uint8Array(16).fill(0x5a),
    ufrag: 'abcd',
    pwd: 'a'.repeat(22),
    candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
    formatVersions: [1],
    recordTypes: [1, 2, 3, 4, 5, 6],
    holdsVault: true,
  } as const;
  const payloadInitiator = encodePayload({
    ...base,
    role: 'initiator',
    setup: 'actpass',
    fingerprint: new Uint8Array(32).fill(0x10),
    commitment: drawn.commitment,
  });
  const payloadResponder = encodePayload({
    ...base,
    role: 'responder',
    setup: 'active',
    fingerprint: new Uint8Array(32).fill(0x30),
    commitment: null,
  });
  const link = memoryPair();
  const shared = { payloadInitiator, payloadResponder };
  const [hi, hr] = await Promise.all([
    pairingHandshake(link.a, { ...shared, role: 'initiator', identity: grantI.identity }),
    pairingHandshake(link.b, { ...shared, role: 'responder', identity: grantR.identity }),
  ]);
  const si = new PairingSession(hi.channel, { expiresAt: Date.now() + 600_000 });
  const sr = new PairingSession(hr.channel, { expiresAt: Date.now() + 600_000 });

  const side = async (
    role: Role,
    device: Device,
    grant: typeof grantI,
    session: PairingSession,
    handshake: typeof hi,
  ) => {
    // §9 step 1: a retired peer is refused before the nonces.
    try {
      grant.checkPeer(handshake.peerPublicKey);
    } catch (error) {
      const refused = refusal(error);
      if (refused instanceof TransferRefusal) return session.refuse(refused.reason, error);
      throw error;
    }
    const sas = await exchangeNonces(
      session,
      role === 'initiator'
        ? { role, handshakeHash: handshake.handshakeHash, nonce: drawn.nonce }
        : { role, handshakeHash: handshake.handshakeHash, commitment: drawn.commitment },
    );
    if (role === 'responder' && run.answer === 'sas-mismatch') {
      await sas.reject('sas-mismatch');
      throw await session.ended;
    }
    await sas.confirm();
    const peerRole: Role = role === 'initiator' ? 'responder' : 'initiator';
    return readmit(session, {
      role,
      mac: () => grant.mac(role, handshake.handshakeHash),
      checkPeerMac: (mac) => grant.checkMac(peerRole, handshake.handshakeHash, mac),
      devices: { ...grant.held(handshake.peerPublicKey), name: device.name },
      admit: (writes, peer) =>
        mapped(() => grant.admit(writes, handshake.peerPublicKey, peer.name, device.name)),
      records: () => mapped(() => grant.records()),
      merge: (records) =>
        mapped(() => {
          if (role === 'responder') run.beforeMerge?.(device.session);
          return grant.merge(records, handshake.peerPublicKey);
        }),
    });
  };

  const [outI, outR] = await Promise.allSettled([
    side('initiator', i, grantI, si, hi),
    side('responder', r, grantR, sr, hr),
  ]);
  return { outI, outR };
}

function reasonOf(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === 'fulfilled') return 'completed';
  const error: unknown = outcome.reason;
  if (error instanceof PairingError) return error.reason;
  throw error;
}

function names(session: VaultSession): string[] {
  return session
    .devices()
    .map((d) => d.device.displayName)
    .sort();
}

function titles(session: VaultSession): (string | undefined)[] {
  return session
    .items()
    .map((i) => i.item?.title)
    .sort();
}

/** The vault as stored in `device`'s IndexedDB, unlocked again with its password. */
async function reopened(device: Device): Promise<VaultSession> {
  device.session.lock();
  const db = await VaultDatabase.open(device.vaultId, device.factory);
  opened.push(db);
  const keyring = new Keyring();
  const session = await VaultSession.unlock({
    store: { records: () => db.records(), commit: (c) => db.commit(c) },
    localConfig: parseLocalConfig((await db.localConfig()) ?? new Uint8Array()),
    keyring,
    kek: kek(keyring, device.seed),
    method: 'password',
    now: () => T0,
  });
  sessions.push(session);
  return session;
}

describe('re-admission end to end (pairing-protocol.md §9, Gate C)', () => {
  it('re-admits a restored device: both hold both Device records and every item, in IndexedDB (D22, D34, D35)', async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Restored phone', 2);
    expect(y.session.registered).toBe(false);
    // The restored device shows the first payload: it is I, and X writes its record.
    const { outI, outR } = await readmission(y, x);
    expect(reasonOf(outI)).toBe('completed');
    expect(reasonOf(outR)).toBe('completed');
    if (outI.status === 'fulfilled') {
      expect(outI.value.peerCommitted).toBe(true);
      expect(outI.value.result.rejected).toEqual([]);
    }
    for (const device of [x, y]) {
      const again = await reopened(device);
      expect(again.registered).toBe(true);
      expect(names(again)).toEqual(['Laptop', 'Restored phone']);
      expect(titles(again)).toEqual(['From Laptop', 'From Restored phone']);
      expect(again.lastSyncByPeer).toHaveLength(1);
    }
  });

  it('two restored devices, neither registered: I writes both records (§9 step 4)', async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Phone', 2);
    const z = await restored(x, 'Tablet', 3);
    const { outI, outR } = await readmission(y, z);
    expect(reasonOf(outI)).toBe('completed');
    expect(reasonOf(outR)).toBe('completed');
    for (const device of [y, z]) {
      expect(device.session.registered).toBe(true);
      expect(names(device.session)).toEqual(['Laptop', 'Phone', 'Tablet']);
    }
  });

  it('two devices that hold both records merge, writing no Device record (D206)', async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Phone', 2);
    expect(reasonOf((await readmission(y, x)).outI)).toBe('completed');
    await x.session.createItem(login('Later on Laptop'));
    const before = x.session.devices().length;
    const { outI, outR } = await readmission(x, y);
    expect(reasonOf(outI)).toBe('completed');
    expect(reasonOf(outR)).toBe('completed');
    expect(x.session.devices()).toHaveLength(before);
    expect(titles(y.session)).toContain('Later on Laptop');
  });

  it('devices of different vaults abort with different-vaults and write no Device record (CRYPTO-INV-014)', async () => {
    const x = await created('Laptop');
    const other = await created('Stranger');
    const { outI, outR } = await readmission(x, other);
    expect(reasonOf(outI)).toBe('different-vaults');
    expect(reasonOf(outR)).toBe('different-vaults');
    expect(names(x.session)).toEqual(['Laptop']);
    expect(names(other.session)).toEqual(['Stranger']);
    expect(x.session.lastSyncByPeer).toEqual([]);
  });

  it('a SAS rejected writes nothing and sends no MAC (CRYPTO-INV-011)', async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Phone', 2);
    const { outI, outR } = await readmission(y, x, { answer: 'sas-mismatch' });
    expect(reasonOf(outI)).toBe('sas-mismatch');
    expect(reasonOf(outR)).toBe('sas-mismatch');
    expect(y.session.registered).toBe(false);
    expect(names(x.session)).toEqual(['Laptop']);
  });

  it('a peer whose own record is retired here is refused before the nonces (retired-peer, D49)', async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Phone', 2);
    const z = await restored(x, 'Tablet', 3);
    // Z gets registered by X, then X retires it.
    expect(reasonOf((await readmission(z, x)).outI)).toBe('completed');
    const zRecord = x.session.devices().find((d) => d.device.displayName === 'Tablet');
    await x.session.retireDevice(zRecord?.deviceId ?? new Uint8Array());
    expect(reasonOf((await readmission(y, x)).outI)).toBe('completed');
    // Y now holds Z's record, retired: Z is refused.
    const { outI, outR } = await readmission(z, y);
    expect(reasonOf(outR)).toBe('retired-peer');
    expect(reasonOf(outI)).toBe('retired-peer');
  });

  it("a lock on R before its merge aborts with locked; R's vault keeps nothing of I's (D93)", async () => {
    const x = await created('Laptop');
    const y = await restored(x, 'Phone', 2);
    const { outI, outR } = await readmission(x, y, {
      beforeMerge: (session) => {
        session.lock();
      },
    });
    expect(reasonOf(outR)).toBe('locked');
    expect(['locked', 'completed']).toContain(reasonOf(outI));
    const again = await reopened(y);
    expect(titles(again)).toEqual(['From Laptop', 'From Phone']);
    expect(again.lastSyncByPeer).toEqual([]);
  });
});
