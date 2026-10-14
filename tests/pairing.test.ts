// Gate C (Phase 4): a pairing end to end over the in-memory transport, through the real Noise_XX
// handshake, the SAS confirmation, the Master Key transfer and the full transfer, with both vaults
// in IndexedDB (pairing-protocol.md §5 to §8, D33, D202). The app wires sync to the vault the same
// way, in `apps/web/src/app/pairing.ts` and its controller.

import {
  Keyring,
  MEMLIMIT,
  type SymmetricKey,
  deviceId,
  derivePrfKek,
  generateDeviceIdentity,
  generateRecoveryPhrase,
  initCrypto,
  pairingNonce,
} from '@blindvault/crypto';
import { VaultDatabase } from '@blindvault/storage';
import {
  type MemoryPairOptions,
  PairingError,
  PairingSession,
  TransferRefusal,
  encodePayload,
  exchangeNonces,
  memoryPair,
  pairingHandshake,
  receiveVault,
  sendVault,
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
const B_NAME = 'Firefox on Linux';

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

/**
 * The abort reason a vault error stands for (pairing-protocol.md §10.3): a copy of `refusal` in
 * `apps/web/src/app/pairing.ts`, which `tests/` does not import.
 */
function refusal(error: unknown): unknown {
  if (error instanceof JoinRejectedError)
    return new TransferRefusal(error.reason, { cause: error });
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

/** A's vault, with an item, a folder and a history, in IndexedDB. */
async function vaultA() {
  const factory = new IDBFactory();
  const keyring = new Keyring();
  const session = await VaultSession.create({
    store: lazyStore(factory),
    keyring,
    kek: kek(keyring, 1),
    recoveryEntropy: generateRecoveryPhrase(keyring).entropy,
    salt: new Uint8Array(16).fill(7),
    kdfParams: PARAMS,
    displayName: 'Chrome on macOS',
    now: () => T0,
  });
  sessions.push(session);
  const id = await session.createItem(login('Bank'));
  await session.updateItem(id, login('Bank, renamed'));
  await session.createFolder('Work');
  return { factory, session };
}

interface Run {
  /** The link closes in place of A's frame of this index after the handshake (0 is the first). */
  readonly cut?: number;
  /** B's answer to the SAS. */
  readonly answer?: 'confirm' | 'sas-mismatch';
  /** Runs on A once B acknowledged the Master Key, before A writes anything. */
  readonly beforeAdmit?: (a: VaultSession) => void;
}

/** A's handshake messages: the first and the third of Noise_XX. */
const HANDSHAKE_FRAMES = 2;

/** One pairing: A (initiator, holds the vault) and B (responder, an empty installation). */
async function pairing(run: Run = {}) {
  const a = await vaultA();
  const caller = new Keyring();
  const grant = a.session.openPairing({ kek: kek(caller, 1), method: 'password' });
  caller.wipeAll();

  // B, before the handshake: its identity and its Device KEK, in memory only (D33).
  const factoryB = new IDBFactory();
  const keyringB = new Keyring();
  const identityB = generateDeviceIdentity(keyringB);
  const kekB = kek(keyringB, 2);

  const drawn = pairingNonce();
  const base = {
    sessionId: new Uint8Array(16).fill(0x5a),
    ufrag: 'abcd',
    pwd: 'a'.repeat(22),
    candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
    formatVersions: [1],
    recordTypes: [1, 2, 3, 4, 5, 6],
  } as const;
  const payloadInitiator = encodePayload({
    ...base,
    role: 'initiator',
    setup: 'actpass',
    holdsVault: true,
    fingerprint: new Uint8Array(32).fill(0x10),
    commitment: drawn.commitment,
  });
  const payloadResponder = encodePayload({
    ...base,
    role: 'responder',
    setup: 'active',
    holdsVault: false,
    fingerprint: new Uint8Array(32).fill(0x30),
    commitment: null,
  });
  let sent = 0;
  const intercept: MemoryPairOptions['intercept'] = (direction, frame) => {
    if (direction !== 'a-to-b' || run.cut === undefined) return [frame];
    sent += 1;
    if (sent <= HANDSHAKE_FRAMES + run.cut) return [frame];
    link.a.close();
    return [];
  };
  const link = memoryPair({ intercept });
  const shared = { payloadInitiator, payloadResponder };
  const [ha, hb] = await Promise.all([
    pairingHandshake(link.a, { ...shared, role: 'initiator', identity: grant.identity }),
    pairingHandshake(link.b, { ...shared, role: 'responder', identity: identityB }),
  ]);
  const sa = new PairingSession(ha.channel, { expiresAt: Date.now() + 600_000 });
  const sb = new PairingSession(hb.channel, { expiresAt: Date.now() + 600_000 });

  const sideA = (async () => {
    const sas = await exchangeNonces(sa, {
      role: 'initiator',
      handshakeHash: ha.handshakeHash,
      nonce: drawn.nonce,
    });
    await sas.confirm();
    await sendVault(sa, {
      vaultId: grant.vaultId,
      masterKey: grant.masterKey,
      admit: (name) =>
        mapped(async () => {
          run.beforeAdmit?.(a.session);
          await grant.admit(ha.peerPublicKey, name);
          return grant.records();
        }),
      completed: () => grant.completed(ha.peerDeviceId),
    });
  })().finally(() => {
    grant.wipe();
  });

  const sideB = (async () => {
    const sas = await exchangeNonces(sb, {
      role: 'responder',
      handshakeHash: hb.handshakeHash,
      commitment: drawn.commitment,
    });
    if (run.answer === 'sas-mismatch') {
      await sas.reject('sas-mismatch');
      throw await sb.ended;
    }
    await sas.confirm();
    const received = await receiveVault(sb, { keyring: keyringB, name: B_NAME });
    return received.commit(() =>
      mapped(() =>
        VaultSession.join({
          store: lazyStore(factoryB),
          keyring: keyringB,
          kek: kekB,
          salt: new Uint8Array(16).fill(8),
          kdfParams: PARAMS,
          identity: identityB,
          vaultId: received.vaultId,
          masterKey: received.masterKey,
          records: received.records,
          peerPublicKey: hb.peerPublicKey,
          now: () => T0,
        }),
      ),
    );
  })().catch((error: unknown) => {
    keyringB.wipeAll();
    throw error;
  });

  const [outA, outB] = await Promise.allSettled([sideA, sideB]);
  if (outB.status === 'fulfilled') sessions.push(outB.value);
  return { a, factoryB, keyringB, identityB, grant, link, outA, outB };
}

function reasonOf(outcome: PromiseSettledResult<unknown>): string {
  if (outcome.status === 'fulfilled') return 'completed';
  const error: unknown = outcome.reason;
  if (error instanceof PairingError) return error.reason;
  throw error;
}

async function databases(factory: IDBFactory): Promise<number> {
  return (await factory.databases()).length;
}

describe('pairing end to end (pairing-protocol.md §8, Gate C)', () => {
  it('B holds the whole vault, committed in IndexedDB, and both record the sync (D33, D34)', async () => {
    const { a, factoryB, identityB, outA, outB } = await pairing();
    expect(reasonOf(outA)).toBe('completed');
    if (outB.status !== 'fulfilled') throw outB.reason;
    const b = outB.value;
    expect(b.vaultId).toEqual(a.session.vaultId);
    expect(b.deviceId).toEqual(deviceId(identityB.publicKey));
    expect(b.registered).toBe(true);
    expect(b.items().map((i) => i.item?.title)).toEqual(['Bank, renamed']);
    expect(b.folders().map((f) => f.name)).toEqual(['Work']);
    const [item] = b.items();
    expect(b.versions(item?.id ?? new Uint8Array())).toHaveLength(
      a.session.versions(item?.id ?? new Uint8Array()).length,
    );
    // Both Device records, on both devices (CRYPTO-INV-007: written by A after the SAS).
    const names = (s: VaultSession) =>
      s
        .devices()
        .map((d) => d.device.displayName)
        .sort();
    expect(names(a.session)).toEqual(['Chrome on macOS', B_NAME]);
    expect(names(b)).toEqual(['Chrome on macOS', B_NAME]);
    expect(a.session.lastSyncByPeer).toEqual([[b.deviceId, T0]]);
    expect(b.lastSyncByPeer).toEqual([[a.session.deviceId, T0]]);

    // B's vault is in its own IndexedDB, and opens with B's password.
    b.lock();
    const db = await VaultDatabase.open(a.session.vaultId, factoryB);
    opened.push(db);
    const config = await db.localConfig();
    const keyring = new Keyring();
    const again = await VaultSession.unlock({
      store: { records: () => db.records(), commit: (c) => db.commit(c) },
      localConfig: parseLocalConfig(config ?? new Uint8Array()),
      keyring,
      kek: kek(keyring, 2),
      method: 'password',
      now: () => T0,
    });
    sessions.push(again);
    expect(again.items().map((i) => i.item?.title)).toEqual(['Bank, renamed']);
  });

  it('a SAS rejected on B transfers nothing and writes nothing (CRYPTO-INV-011)', async () => {
    const { a, factoryB, keyringB, outA, outB } = await pairing({ answer: 'sas-mismatch' });
    expect(reasonOf(outA)).toBe('sas-mismatch');
    expect(reasonOf(outB)).toBe('sas-mismatch');
    expect(a.session.devices()).toHaveLength(1);
    expect(await databases(factoryB)).toBe(0);
    expect(keyringB.size).toBe(0);
  });

  it('a lock on A after the Master Key went out aborts with locked, leaving B empty (D93)', async () => {
    const { a, factoryB, keyringB, outA, outB } = await pairing({
      beforeAdmit: (session) => {
        session.lock();
      },
    });
    expect(reasonOf(outA)).toBe('locked');
    expect(reasonOf(outB)).toBe('locked');
    expect(a.session.locked).toBe(true);
    expect(await databases(factoryB)).toBe(0);
    expect(keyringB.size).toBe(0);
  });

  // A's frames after the handshake: nonce_I, confirmed, master-key, records-begin, its 7 records
  // (Vault Key, Recovery Envelope, both Device records, the item, its version, the folder) and
  // records-end: 12 in all.
  const FRAMES = 12;

  it("completes when the link carries all 12 of A's frames", async () => {
    const { outA, outB } = await pairing({ cut: FRAMES });
    expect(reasonOf(outA)).toBe('completed');
    expect(reasonOf(outB)).toBe('completed');
  });

  it.each(Array.from({ length: FRAMES }, (_, i) => i))(
    "a link closed in place of A's frame %i leaves B with no database and no key (D33)",
    async (cut) => {
      const { factoryB, keyringB, outA, outB } = await pairing({ cut });
      expect(reasonOf(outA)).toBe('closed');
      expect(reasonOf(outB)).toBe('closed');
      expect(await databases(factoryB)).toBe(0);
      expect(keyringB.size).toBe(0);
    },
  );
});
