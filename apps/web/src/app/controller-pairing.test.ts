// The controller's pairing (§8.4, D202, D203): two controllers, each with its own IndexedDB and Web
// Locks, over the in-memory transport in place of WebRTC. The protocol itself is tested in
// `packages/sync` and `tests/pairing.test.ts`; here, the flow the screens drive.

import { type KdfPort, MEMLIMIT, initCrypto } from '@blindvault/crypto';
import {
  type ConnectionOptions,
  type MemoryPair,
  type Payload,
  decodeBase45,
  decodePayloadText,
  encodeBase45,
  encodePayloadText,
  memoryPair,
} from '@blindvault/sync';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';

import { VaultController } from './controller';
import { type PairingPort, type PairingStage, STUN_SERVERS } from './pairing';
import { type PasskeyPort } from './passkey';

beforeAll(initCrypto);

const PASSWORD_A = 'correct horse battery staple orbit';
const PASSWORD_B = 'another horse battery staple comet';

/** A stand-in for the Argon2id worker: the key is the password's bytes padded to 32. */
function fakeKdf(): KdfPort {
  const port: KdfPort = {
    onmessage: null,
    onerror: null,
    postMessage(message) {
      const key = new Uint8Array(32);
      key.set(message.password.subarray(0, 32));
      message.password.fill(0);
      const params = message.op === 'derive' ? message.params : { opslimit: 2, memlimit: MEMLIMIT };
      queueMicrotask(() => port.onmessage?.({ data: { ok: true, key, params } }));
    },
    terminate() {
      // nothing runs in the background
    },
  };
  return port;
}

/** Each device its own Web Locks: both hold the same `vaultId` once paired. */
function locksOf(prefix: string): LockManager {
  return {
    request: (name: string, ...rest: unknown[]) =>
      (navigator.locks.request as (...args: unknown[]) => Promise<unknown>)(
        `${prefix}:${name}`,
        ...rest,
      ),
    query: () => navigator.locks.query(),
  } as LockManager;
}

const DESCRIPTION = {
  ufrag: 'abcd',
  pwd: 'a'.repeat(22),
  candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
} as const;

/** WebRTC replaced by one in-memory link per session: A's accept opens it for B. */
function network() {
  let link: { pair: MemoryPair; open: () => void; opened: Promise<void> } | undefined;
  const options: ConnectionOptions[] = [];
  /** The connections closed by the app, as WebRTC would close them: cutting what is in flight. */
  const closed: string[] = [];
  const a: PairingPort = {
    startInitiator: (context, connection) => {
      options.push(connection);
      let open!: () => void;
      const opened = new Promise<void>((resolve) => {
        open = resolve;
      });
      const pair = memoryPair();
      link = { pair, open, opened };
      const payload: Payload = {
        role: 'initiator',
        setup: 'actpass',
        fingerprint: new Uint8Array(32).fill(0x10),
        ...DESCRIPTION,
        sessionId: context.sessionId.slice(),
        holdsVault: context.holdsVault,
        formatVersions: [...context.formatVersions],
        recordTypes: [...context.recordTypes],
        commitment: context.commitment.slice(),
      };
      return Promise.resolve({
        payload,
        accept: () => {
          open();
          return Promise.resolve(pair.a);
        },
        close: () => {
          closed.push('a');
          pair.a.close();
        },
      });
    },
    startResponder: () => Promise.reject(new Error('A does not answer')),
  };
  const b: PairingPort = {
    startInitiator: () => Promise.reject(new Error('B does not start')),
    startResponder: (offer, context, connection) => {
      options.push(connection);
      if (!link) return Promise.reject(new Error('no session'));
      const { pair, opened } = link;
      return Promise.resolve({
        payload: {
          role: 'responder',
          setup: 'active',
          fingerprint: new Uint8Array(32).fill(0x30),
          ...DESCRIPTION,
          sessionId: offer.sessionId.slice(),
          holdsVault: context.holdsVault,
          formatVersions: [...context.formatVersions],
          recordTypes: [...context.recordTypes],
          commitment: null,
        },
        transport: opened.then(() => pair.b),
        close: () => {
          closed.push('b');
          pair.b.close();
        },
      });
    },
  };
  return { a, b, options, closed };
}

const controllers: VaultController[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});

function controller(
  prefix: string,
  factory: IDBFactory,
  pairing?: PairingPort,
  passkeys?: PasskeyPort,
) {
  const c = new VaultController({
    factory,
    locks: locksOf(prefix),
    kdf: fakeKdf,
    now: () => 1_760_000_000_000,
    ...(pairing ? { pairing } : {}),
    ...(passkeys ? { passkeys } : {}),
  });
  controllers.push(c);
  return c;
}

function session(c: VaultController) {
  const s = c.status;
  if (s.kind !== 'unlocked') throw new Error(`not unlocked: ${s.kind}`);
  return s.session;
}

async function stage(c: VaultController, kind: PairingStage['kind']): Promise<PairingStage> {
  await vi.waitFor(() => {
    expect(c.pairing?.kind).toBe(kind);
  });
  const current = c.pairing;
  if (!current) throw new Error('no pairing');
  return current;
}

function textOf(s: PairingStage): string {
  if (s.kind !== 'offer' && s.kind !== 'answer') throw new Error(`no text: ${s.kind}`);
  return s.text;
}

async function created(c: VaultController): Promise<void> {
  await c.start();
  c.newRecoveryPhrase();
  await c.create(PASSWORD_A, 'Chrome on macOS');
}

/** A with a vault holding an item; B with no vault. Both reach the SAS. */
async function toSas(
  sameNetwork = true,
  vaultOnA: (a: VaultController) => Promise<void> = created,
  factoryB = new IDBFactory(),
  net = network(),
) {
  const a = controller('a', new IDBFactory(), net.a);
  const b = controller('b', factoryB, net.b);
  await vaultOnA(a);
  await session(a).createItem({
    templateId: 'login',
    templateVersion: 1,
    title: 'Bank',
    fields: [{ type: 'secret', role: 'password', value: 'hunter2-very-secret' }],
    tags: [],
  });
  await b.start();

  expect(
    await a.startPairing(
      { kind: 'password', password: PASSWORD_A },
      { sameNetwork, defaultName: 'Own name' },
    ),
  ).toBe('ok');
  const offer = textOf(await stage(a, 'offer'));
  expect(await b.beginJoin(PASSWORD_B, { sameNetwork, name: 'Firefox on Linux' })).toBe('ok');
  expect(b.status.kind).toBe('joining');
  expect(b.pairing?.kind).toBe('scan');
  expect(await b.joinOffer(offer)).toBe('ok');
  const answer = textOf(await stage(b, 'answer'));
  expect(a.pairingAnswer(answer)).toBe('ok');
  const sasA = await stage(a, 'sas');
  const sasB = await stage(b, 'sas');
  return { a, b, factoryB, net, sasA, sasB, offer, answer };
}

async function databases(factory: IDBFactory): Promise<number> {
  return (await factory.databases()).length;
}

describe('pairing through the controller (§8.4, D202, D203)', () => {
  it('pairs: the same SAS on both, then B holds the vault, unlocked, with "Vault ready"', async () => {
    const { a, b, factoryB, net, sasA, sasB } = await toSas();
    expect(sasA).toEqual(sasB);
    if (sasA.kind !== 'sas') throw new Error('no SAS');
    expect(sasA.sas).toMatch(/^\d{6}$/);
    expect(sasA.confirmed).toBe(false);
    // No STUN server on the same network only (D203).
    expect(net.options.map((o) => o.iceServers)).toEqual([[], []]);
    // No asset update while a pairing runs (D152).
    expect(a.updateAllowed).toBe(false);

    a.confirmSas();
    expect(a.pairing).toEqual({ ...sasA, confirmed: true });
    b.confirmSas();
    await vi.waitFor(() => {
      expect(b.status.kind).toBe('unlocked');
    });
    expect(await stage(a, 'done')).toEqual({
      kind: 'done',
      name: 'Firefox on Linux',
      readmit: false,
    });

    const sb = session(b);
    expect(sb.vaultId).toEqual(session(a).vaultId);
    expect(sb.items().map((i) => i.item?.title)).toEqual(['Bank']);
    expect(b.ready).toEqual({ start: 'paired' });
    expect(b.pairing).toBeUndefined();
    const names = (c: VaultController) =>
      session(c)
        .devices()
        .map((d) => d.device.displayName)
        .sort();
    expect(names(a)).toEqual(['Chrome on macOS', 'Firefox on Linux']);
    expect(names(b)).toEqual(['Chrome on macOS', 'Firefox on Linux']);
    expect(session(a).lastSyncByPeer).toHaveLength(1);
    expect(sb.lastSyncByPeer).toHaveLength(1);
    expect(await databases(factoryB)).toBe(1);

    // A's result stays until closed.
    expect(a.updateAllowed).toBe(false);
    a.cancelPairing();
    expect(a.pairing).toBeUndefined();
    expect(a.updateAllowed).toBe(true);

    // B's vault opens with B's own password.
    b.lock();
    expect(b.status.kind).toBe('locked');
    expect(await b.unlock(PASSWORD_B)).toBe('ok');
    expect(
      session(b)
        .items()
        .map((i) => i.item?.title),
    ).toEqual(['Bank']);
  });

  it('uses the default STUN servers unless the same network only is chosen (§9.2)', async () => {
    const { a, net } = await toSas(false);
    expect(net.options.map((o) => o.iceServers)).toEqual([STUN_SERVERS, STUN_SERVERS]);
    a.cancelPairing();
  });

  it('a SAS said to differ ends both sides, and B keeps nothing (§6.4, CRYPTO-INV-011)', async () => {
    const { a, b, factoryB } = await toSas();
    b.rejectSas();
    expect(await stage(b, 'failed')).toEqual({
      kind: 'failed',
      reason: 'sas-mismatch',
      by: 'local',
    });
    expect(await stage(a, 'failed')).toEqual({
      kind: 'failed',
      reason: 'sas-mismatch',
      by: 'remote',
    });
    expect(session(a).devices()).toHaveLength(1);
    expect(await databases(factoryB)).toBe(0);
    expect(b.status.kind).toBe('joining');
    b.cancelPairing();
    expect(b.status.kind).toBe('no-vault');
    expect(b.pairing).toBeUndefined();
  });

  it('a lock on A while the SAS is shown ends the pairing with locked on B (D93)', async () => {
    const { a, b, factoryB, net } = await toSas();
    b.confirmSas();
    a.lock();
    // The connection stays open until `abort` is out: closing it at once would cut it, and B would
    // see a closed link instead of the reason (§10.3).
    expect(net.closed).toEqual([]);
    expect(a.status.kind).toBe('locked');
    expect(a.pairing).toBeUndefined();
    expect(await stage(b, 'failed')).toEqual({ kind: 'failed', reason: 'locked', by: 'remote' });
    expect(await databases(factoryB)).toBe(0);
  });

  it('a lock on B ends the pairing with locked on A, and B has no vault (D93, D203)', async () => {
    const { a, b, factoryB } = await toSas();
    a.confirmSas();
    b.lock();
    expect(b.status.kind).toBe('no-vault');
    expect(b.pairing).toBeUndefined();
    expect(await stage(a, 'failed')).toEqual({ kind: 'failed', reason: 'locked', by: 'remote' });
    expect(session(a).devices()).toHaveLength(1);
    expect(await databases(factoryB)).toBe(0);
  });

  it('a cancel on A ends B with cancelled', async () => {
    const { a, b } = await toSas();
    a.cancelPairing();
    expect(a.pairing).toBeUndefined();
    expect(await stage(b, 'failed')).toEqual({ kind: 'failed', reason: 'cancelled', by: 'remote' });
  });

  it('refuses a pasted text that is not the expected payload, keeping the session (§3.3, §7, D122)', async () => {
    const net = network();
    const a = controller('a', new IDBFactory(), net.a);
    const b = controller('b', new IDBFactory(), net.b);
    await a.start();
    a.newRecoveryPhrase();
    await a.create(PASSWORD_A, 'Chrome on macOS');
    await b.start();
    await a.startPairing(
      { kind: 'password', password: PASSWORD_A },
      { sameNetwork: true, defaultName: 'unused' },
    );
    const offer = textOf(await stage(a, 'offer'));
    const decoded = decodePayloadText(offer, { role: 'initiator' });
    const answer = (changes: Partial<Payload>) =>
      encodePayloadText({
        ...decoded,
        role: 'responder',
        setup: 'active',
        commitment: null,
        holdsVault: false,
        ...changes,
      });
    expect(a.pairingAnswer('not a payload')).toBe('invalid');
    expect(a.pairingAnswer(offer)).toBe('invalid');
    expect(a.pairingAnswer(answer({ sessionId: new Uint8Array(16) }))).toBe('wrong-session');
    expect(a.pairingAnswer(answer({ holdsVault: true }))).toBe('peer-holds-vault');
    expect(a.pairingAnswer(answer({ recordTypes: [1, 2, 3, 4, 5] }))).toBe('outdated-peer');
    const newer = decodeBase45(answer({}));
    newer[0] = 2;
    expect(a.pairingAnswer(encodeBase45(newer))).toBe('version');
    expect(a.pairing?.kind).toBe('offer');

    expect(await b.beginJoin(PASSWORD_B, { sameNetwork: true, name: 'B' })).toBe('ok');
    expect(await b.joinOffer(answer({}))).toBe('invalid');
    expect(await b.joinOffer(encodePayloadText({ ...decoded, holdsVault: false }))).toBe(
      'peer-no-vault',
    );
    expect(b.pairing?.kind).toBe('scan');
    // A line break added by a chat is not a change (§3.4).
    expect(await b.joinOffer(`${offer.slice(0, 10)}\n${offer.slice(10)}`)).toBe('ok');
    expect(b.pairingAnswer('anything')).toBe('unavailable');
    expect(await a.joinOffer(offer)).toBe('unavailable');
    a.cancelPairing();
    b.cancelPairing();
  });

  it('starts only after the password opens the Master Key wrap again (D202)', async () => {
    const net = network();
    const a = controller('a', new IDBFactory(), net.a);
    await a.start();
    a.newRecoveryPhrase();
    await a.create(PASSWORD_A, 'Chrome on macOS');
    expect(
      await a.startPairing(
        { kind: 'password', password: 'wrong password entirely' },
        { sameNetwork: true, defaultName: 'unused' },
      ),
    ).toBe('wrong-password');
    expect(a.pairing).toBeUndefined();
    expect(net.options).toEqual([]);

    const none = controller('c', new IDBFactory());
    await none.start();
    none.newRecoveryPhrase();
    await none.create(PASSWORD_A, 'Chrome on macOS');
    expect(
      await none.startPairing(
        { kind: 'password', password: PASSWORD_A },
        { sameNetwork: true, defaultName: 'unused' },
      ),
    ).toBe('no-webrtc');
    expect(await none.beginJoin(PASSWORD_B, { sameNetwork: true, name: 'B' })).toBe('unavailable');
  });

  it('joins only with no vault, and a lock before the handshake leaves nothing (D13, D33)', async () => {
    const net = network();
    const b = controller('b', new IDBFactory(), net.b);
    await b.start();
    const joining = b.beginJoin(PASSWORD_B, { sameNetwork: true, name: 'B' });
    expect(b.status.kind).toBe('joining');
    b.lock();
    expect(await joining).toBe('locked');
    expect(b.status.kind).toBe('no-vault');
    expect(b.pairing).toBeUndefined();

    const a = controller('a', new IDBFactory(), net.a);
    await a.start();
    a.newRecoveryPhrase();
    await a.create(PASSWORD_A, 'Chrome on macOS');
    expect(await a.beginJoin(PASSWORD_B, { sameNetwork: true, name: 'B' })).toBe('unavailable');
    a.lock();
    expect(await a.beginJoin(PASSWORD_B, { sameNetwork: true, name: 'B' })).toBe('unavailable');
  });

  it('expires 10 minutes after the payload, before any connection (§11)', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const net = network();
      const a = controller('a', new IDBFactory(), net.a);
      await a.start();
      a.newRecoveryPhrase();
      await a.create(PASSWORD_A, 'Chrome on macOS');
      await a.startPairing(
        { kind: 'password', password: PASSWORD_A },
        { sameNetwork: true, defaultName: 'unused' },
      );
      expect(a.pairing?.kind).toBe('offer');
      vi.advanceTimersByTime(10 * 60 * 1000 - 1);
      expect(a.pairing?.kind).toBe('offer');
      vi.advanceTimersByTime(1);
      expect(a.pairing).toEqual({ kind: 'failed', reason: 'expired', by: 'local' });
      expect(a.pairingAnswer('anything')).toBe('unavailable');
    } finally {
      vi.useRealTimers();
    }
  });

  it('an unregistered A names its own record, and recommends re-admission (D141, D203)', async () => {
    // A restored from a backup of the vault's creator: it holds no Device record of its own.
    const creator = controller('c', new IDBFactory());
    await creator.start();
    const words = creator.newRecoveryPhrase();
    await creator.create(PASSWORD_A, 'Creator');
    const file = await creator.exportBackup({ kind: 'password', password: PASSWORD_A });
    if (file.kind !== 'ok' || !words) throw new Error('no backup');
    const { a, b } = await toSas(true, async (restored) => {
      await restored.start();
      expect(restored.openBackupFile(file.bytes).kind).toBe('ok');
      expect((await restored.openBackup({ kind: 'phrase', words })).kind).toBe('ok');
      expect((await restored.restore(PASSWORD_A)).kind).toBe('ok');
      expect(session(restored).registered).toBe(false);
    });
    a.confirmSas();
    b.confirmSas();
    expect(await stage(a, 'done')).toEqual({
      kind: 'done',
      name: 'Firefox on Linux',
      readmit: true,
    });
    const names = session(a)
      .devices()
      .map((d) => d.device.displayName)
      .sort();
    expect(names).toEqual(['Creator', 'Firefox on Linux', 'Own name']);
    expect(session(a).registered).toBe(true);
  });
});

describe('replace by pairing (§8.4, D150, D153, D154, D204)', () => {
  const PASSWORD_NEW = 'a third horse battery staple comet';

  /** One credential whose PRF output is its input XOR 7, with user verification (D75). */
  function authenticator() {
    const forgotten: Uint8Array[] = [];
    const result = (prfInput: Uint8Array) => {
      const authenticatorData = new Uint8Array(37);
      authenticatorData[32] = 0x01 | 0x04;
      return {
        credentialId: Uint8Array.of(9),
        authenticatorData,
        prfOutput: prfInput.map((b) => b ^ 7),
      };
    };
    const port: PasskeyPort = {
      supported: () => Promise.resolve(true),
      create: (prfInput) => Promise.resolve(result(prfInput)),
      get: (_id, prfInput) => Promise.resolve(result(prfInput)),
      forget: (id) => {
        forgotten.push(id);
        return Promise.resolve(false);
      },
    };
    return { port, forgotten };
  }

  /** A holds a vault with an item and invites; B is given, locked or not. Both reach the SAS. */
  async function pairWith(
    b: VaultController,
    net: ReturnType<typeof network>,
    a?: VaultController,
  ) {
    const inviter = a ?? controller('a', new IDBFactory(), net.a);
    if (!a) {
      await created(inviter);
      await session(inviter).createItem({
        templateId: 'login',
        templateVersion: 1,
        title: 'Bank',
        fields: [],
        tags: [],
      });
    }
    expect(
      await inviter.startPairing(
        { kind: 'password', password: PASSWORD_A },
        { sameNetwork: true, defaultName: 'unused' },
      ),
    ).toBe('ok');
    const offer = textOf(await stage(inviter, 'offer'));
    expect(
      await b.beginJoin(PASSWORD_NEW, { sameNetwork: true, name: 'Replacing', replace: true }),
    ).toBe('ok');
    expect(b.status).toEqual({ kind: 'joining', replacing: true });
    expect(await b.joinOffer(offer)).toBe('ok');
    expect(inviter.pairingAnswer(textOf(await stage(b, 'answer')))).toBe('ok');
    await stage(inviter, 'sas');
    await stage(b, 'sas');
    return inviter;
  }

  /** B holds a vault of its own, with one item, locked. */
  async function lockedB(net: ReturnType<typeof network>, passkeys?: PasskeyPort) {
    const factory = new IDBFactory();
    const b = controller('b', factory, net.b, passkeys);
    await b.start();
    b.newRecoveryPhrase();
    await b.create(PASSWORD_B, 'Old name');
    await session(b).createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'Old item',
      fields: [],
      tags: [],
    });
    if (passkeys) expect(await b.setUpPasskey(PASSWORD_B)).toMatchObject({ kind: 'ok' });
    const vaultId = session(b).vaultId;
    b.lock();
    return { b, factory, vaultId };
  }

  async function titles(c: VaultController, password: string) {
    expect(await c.unlock(password)).toBe('ok');
    return session(c)
      .items()
      .map((i) => i.item?.title);
  }

  it('replaces a locked vault of another vault: the old database goes after the commit (D89, D150)', async () => {
    const net = network();
    const { port, forgotten } = authenticator();
    const { b, factory, vaultId } = await lockedB(net, port);
    const a = await pairWith(b, net);
    a.confirmSas();
    b.confirmSas();
    await vi.waitFor(() => {
      expect(b.status.kind).toBe('unlocked');
    });
    expect(session(b).vaultId).toEqual(session(a).vaultId);
    expect(session(b).vaultId).not.toEqual(vaultId);
    expect(b.ready).toEqual({ start: 'paired' });
    expect(await databases(factory)).toBe(1);
    // The old vault's passkey: the authenticator is asked to forget it, or the user is told (D120).
    expect(forgotten).toEqual([Uint8Array.of(9)]);
    expect(b.hasPasskey).toBe(false);
    expect(b.leftoverPasskey).toBe(true);
    expect(await stage(a, 'done')).toMatchObject({ kind: 'done', name: 'Replacing' });

    b.lock();
    expect(await b.unlock(PASSWORD_B)).toBe('wrong-password');
    expect(await titles(b, PASSWORD_NEW)).toEqual(['Bank']);
    // A startup keeps only the new vault (D150).
    await b.close();
    const again = controller('b', factory);
    await again.start();
    expect(await titles(again, PASSWORD_NEW)).toEqual(['Bank']);
  });

  it('replaces a locked vault of the same vaultId in its own database (D153)', async () => {
    const net = network();
    const factory = new IDBFactory();
    const { a, b } = await toSas(true, created, factory, net);
    a.confirmSas();
    b.confirmSas();
    await vi.waitFor(() => {
      expect(b.status.kind).toBe('unlocked');
    });
    a.cancelPairing();
    const vaultId = session(b).vaultId;
    // A change only B holds is lost by the replacement.
    await session(b).createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'Only on B',
      fields: [],
      tags: [],
    });
    b.lock();

    await pairWith(b, net, a);
    a.confirmSas();
    b.confirmSas();
    await vi.waitFor(() => {
      expect(b.status.kind).toBe('unlocked');
    });
    expect(session(b).vaultId).toEqual(vaultId);
    expect(await databases(factory)).toBe(1);
    expect(
      session(b)
        .items()
        .map((i) => i.item?.title),
    ).toEqual(['Bank']);
    // B's old Device record stays, for the user to retire from another device (D183).
    expect(
      session(b)
        .devices()
        .map((d) => d.device.displayName)
        .sort(),
    ).toEqual(['Chrome on macOS', 'Firefox on Linux', 'Replacing']);
    b.lock();
    expect(await b.unlock(PASSWORD_B)).toBe('wrong-password');
    expect(await titles(b, PASSWORD_NEW)).toEqual(['Bank']);
  });

  it('a SAS said to differ leaves the old vault intact and locked (D150, D153)', async () => {
    const net = network();
    const { b, factory } = await lockedB(net);
    await pairWith(b, net);
    b.rejectSas();
    await stage(b, 'failed');
    expect(b.status).toEqual({ kind: 'joining', replacing: true });
    b.cancelPairing();
    expect(b.status.kind).toBe('locked');
    expect(await databases(factory)).toBe(1);
    expect(await titles(b, PASSWORD_B)).toEqual(['Old item']);
  });

  it('a lock on B, the app hidden, ends the pairing and leaves the old vault locked (D93, D203)', async () => {
    const net = network();
    const { b } = await lockedB(net);
    const a = await pairWith(b, net);
    a.confirmSas();
    b.lock();
    expect(b.status.kind).toBe('locked');
    expect(b.pairing).toBeUndefined();
    expect(await stage(a, 'failed')).toEqual({ kind: 'failed', reason: 'locked', by: 'remote' });
    expect(await titles(b, PASSWORD_B)).toEqual(['Old item']);
  });

  it('a take-over by another app window ends the pairing; the old vault stays (D154)', async () => {
    const net = network();
    const { b, factory } = await lockedB(net);
    // Opened before the pairing: during it, the installation guard keeps a new window busy (D97).
    const other = controller('b', factory);
    await other.start();
    expect(other.status.kind).toBe('elsewhere');
    const a = await pairWith(b, net);
    const late = controller('b', factory);
    await late.start();
    expect(late.status.kind).toBe('busy');
    await other.takeOver();
    expect(other.status.kind).toBe('locked');
    await vi.waitFor(() => {
      expect(b.status.kind).toBe('elsewhere');
    });
    expect(b.pairing).toBeUndefined();
    expect(await stage(a, 'failed')).toEqual({ kind: 'failed', reason: 'locked', by: 'remote' });
    expect(await titles(other, PASSWORD_B)).toEqual(['Old item']);
  });

  it('replaces only a locked vault, and only when asked (D183, D204)', async () => {
    const net = network();
    const { b } = await lockedB(net);
    expect(await b.beginJoin(PASSWORD_NEW, { sameNetwork: true, name: 'B' })).toBe('unavailable');
    expect(await b.unlock(PASSWORD_B)).toBe('ok');
    expect(await b.beginJoin(PASSWORD_NEW, { sameNetwork: true, name: 'B', replace: true })).toBe(
      'unavailable',
    );
    expect(b.status.kind).toBe('unlocked');
    // With no vault, there is nothing to replace: the flag changes nothing.
    const none = controller('c', new IDBFactory(), network().b);
    await none.start();
    expect(
      await none.beginJoin(PASSWORD_NEW, { sameNetwork: true, name: 'C', replace: true }),
    ).toBe('ok');
    expect(none.status).toEqual({ kind: 'joining' });
    none.cancelPairing();
    expect(none.status.kind).toBe('no-vault');
  });
});
