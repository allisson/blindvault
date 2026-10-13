import {
  type KdfPort,
  type KdfRequest,
  Keyring,
  MEMLIMIT,
  type RecordEnvelope,
  deriveRecoveryKeys,
  parseRecoveryPhrase,
} from '@blindvault/crypto';
import { VaultDatabase, acquireInstallationGuard, acquireVaultLock } from '@blindvault/storage';
import { IDBFactory } from 'fake-indexeddb';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { recordIdPrefix } from './backup-file';
import { VaultController } from './controller';
import { PasskeyCancelledError, type PasskeyPort, type PasskeyResult } from './passkey';

const PASSWORD = 'correct horse battery staple orbit';

function must<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('missing');
  return value;
}

/**
 * A stand-in for the Argon2id worker: the key is the password's bytes padded to 32, so another
 * password gives another key. Argon2id itself is tested in `packages/crypto`.
 */
function fakeKdf(log: KdfRequest['op'][] = []): () => KdfPort {
  return () => {
    const port: KdfPort = {
      onmessage: null,
      onerror: null,
      postMessage(message) {
        log.push(message.op);
        const key = new Uint8Array(32);
        key.set(message.password.subarray(0, 32));
        message.password.fill(0);
        const params =
          message.op === 'derive' ? message.params : { opslimit: 2, memlimit: MEMLIMIT };
        queueMicrotask(() => port.onmessage?.({ data: { ok: true, key, params } }));
      },
      terminate() {
        // nothing runs in the background
      },
    };
    return port;
  };
}

const controllers: VaultController[] = [];

afterEach(async () => {
  for (const c of controllers.splice(0)) await c.close();
});

const UP = 0x01;
const UV = 0x04;
const BE = 0x08;

/**
 * A stand-in authenticator: the PRF output is the PRF input XOR a per-credential byte, so it is
 * stable per credential and input. `flags` and `prf` change what the next ceremonies return.
 */
class FakeAuthenticator implements PasskeyPort {
  flags = UP | UV;
  /** `create`: PRF output at create, only on a later get, or never. */
  prf: 'create' | 'get' | 'none' = 'create';
  cancel = false;
  signal = true;
  readonly calls: string[] = [];
  readonly forgotten: Uint8Array[] = [];
  #next = 1;
  readonly #known = new Set<number>();

  #result(credentialId: Uint8Array, prfInput: Uint8Array, output: boolean): PasskeyResult {
    const authenticatorData = new Uint8Array(37);
    authenticatorData[32] = this.flags;
    const key = credentialId[0] ?? 0;
    return {
      credentialId: credentialId.slice(),
      authenticatorData,
      ...(output ? { prfOutput: prfInput.map((b) => b ^ key) } : {}),
    };
  }

  supported() {
    return Promise.resolve(true);
  }

  create(prfInput: Uint8Array) {
    this.calls.push('create');
    if (this.cancel) return Promise.reject(new PasskeyCancelledError());
    const id = this.#next++;
    this.#known.add(id);
    return Promise.resolve(this.#result(new Uint8Array([id]), prfInput, this.prf === 'create'));
  }

  get(credentialId: Uint8Array, prfInput: Uint8Array) {
    this.calls.push('get');
    if (this.cancel || !this.#known.has(credentialId[0] ?? 0)) {
      return Promise.reject(new PasskeyCancelledError());
    }
    return Promise.resolve(this.#result(credentialId, prfInput, this.prf !== 'none'));
  }

  forget(credentialId: Uint8Array) {
    this.forgotten.push(credentialId);
    return Promise.resolve(this.signal);
  }
}

function controller(
  factory = new IDBFactory(),
  log?: KdfRequest['op'][],
  passkeys?: PasskeyPort,
  now?: () => number,
) {
  const c = new VaultController({
    factory,
    locks: navigator.locks,
    kdf: fakeKdf(log),
    ...(passkeys ? { passkeys } : {}),
    ...(now ? { now } : {}),
  });
  controllers.push(c);
  return c;
}

/** Creates the vault as the UI does: a Recovery Phrase first, then the password (D179). */
function createIn(c: VaultController): Promise<void> {
  c.newRecoveryPhrase();
  return c.create(PASSWORD, 'Test device');
}

async function created(factory = new IDBFactory()) {
  const c = controller(factory);
  await c.start();
  await createIn(c);
  return c;
}

function session(c: VaultController) {
  const s = c.status;
  if (s.kind !== 'unlocked') throw new Error(`not unlocked: ${s.kind}`);
  return s.session;
}

describe('Recovery Phrase at creation (§5.4, D179)', () => {
  it('hands out 24 words, a new phrase each time, and creates the vault for the last one', async () => {
    const c = controller();
    await c.start();
    const first = must(c.newRecoveryPhrase());
    const words = must(c.newRecoveryPhrase());
    expect(words.split(' ')).toHaveLength(24);
    expect(words).not.toBe(first);
    await c.create(PASSWORD, 'Test device');
    const keyring = new Keyring();
    const keys = deriveRecoveryKeys(keyring, parseRecoveryPhrase(keyring, words));
    expect(must(session(c).recovery).keyslotPublicKey).toEqual(keys.keyslotPublicKey);
  });

  it('creates nothing without a phrase', async () => {
    const factory = new IDBFactory();
    const c = controller(factory);
    await c.start();
    await c.create(PASSWORD, 'Test device');
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('drops the phrase on lock, so a creation needs a new one', async () => {
    const factory = new IDBFactory();
    const c = controller(factory);
    await c.start();
    c.newRecoveryPhrase();
    c.lock();
    await c.create(PASSWORD, 'Test device');
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('hands out no phrase once a vault exists', async () => {
    const c = await created();
    expect(c.newRecoveryPhrase()).toBeUndefined();
  });
});

describe('Check Recovery Phrase (§5.4, D24, D180)', () => {
  it('checks a typed phrase against the vault it created', async () => {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'Test device');
    expect(c.recoveryEnvelope()).toBe('held');
    expect(c.checkRecoveryPhrase(words.toUpperCase())).toEqual({ kind: 'opens' });
    const other = controller();
    await other.start();
    expect(c.checkRecoveryPhrase(must(other.newRecoveryPhrase()))).toEqual({
      kind: 'wrong-phrase',
    });
  });

  it('reports input that is not a phrase, with the position of an unknown word', async () => {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase()).split(' ');
    await c.create(PASSWORD, 'Test device');
    expect(c.checkRecoveryPhrase(words.slice(2).join(' '))).toEqual({
      kind: 'invalid',
      reason: 'word-count',
    });
    words[9] = 'blindvault';
    expect(c.checkRecoveryPhrase(words.join(' '))).toEqual({
      kind: 'invalid',
      reason: 'unknown-word',
      position: 10,
    });
  });

  it('checks nothing once locked', async () => {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'Test device');
    c.lock();
    expect(c.recoveryEnvelope()).toBe('locked');
    expect(c.checkRecoveryPhrase(words)).toEqual({ kind: 'locked' });
  });
});

describe('backup export (§10, D36, D64, D181)', () => {
  const MAGIC = [0x89, 0x42, 0x56, 0x41, 0x55, 0x4c, 0x54, 0x0a];
  const EXPORT_PASSWORD = 'orbit-tulip-granite-ferry-cedar-pixel';
  // 2026-03-04 at noon, local time: the file name takes the local date.
  const AT = new Date(2026, 2, 4, 12).getTime();

  async function exporting(passkeys?: PasskeyPort) {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log, passkeys, () => AT);
    await c.start();
    await createIn(c);
    log.length = 0;
    return { c, log, factory };
  }

  it('asks for the local password again and makes the file, recording the date (D181, §13.4)', async () => {
    const { c, log } = await exporting();
    expect(session(c).lastBackupAt).toBeUndefined();
    const made = await c.exportBackup({ kind: 'password', password: PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    expect([...made.bytes.subarray(0, 8)]).toEqual(MAGIC);
    expect(made.name).toBe('blindvault-2026-03-04.bvault');
    // Only the Device KEK is derived: no export password, no password keyslot.
    expect(log).toEqual(['derive']);
    expect(session(c).lastBackupAt).toBe(AT);

    log.length = 0;
    const protectedFile = await c.exportBackup(
      { kind: 'password', password: PASSWORD },
      EXPORT_PASSWORD,
    );
    expect(protectedFile.kind).toBe('ok');
    expect(log).toEqual(['derive', 'derive']);
  });

  it('refuses another local password, deriving no export KEK and recording nothing', async () => {
    const { c, log } = await exporting();
    expect(
      await c.exportBackup({ kind: 'password', password: 'not the password' }, EXPORT_PASSWORD),
    ).toEqual({ kind: 'wrong-password' });
    expect(log).toEqual(['derive']);
    expect(session(c).lastBackupAt).toBeUndefined();
  });

  it('makes nothing once locked, before or during the export (D105)', async () => {
    const { c } = await exporting();
    const pending = c.exportBackup({ kind: 'password', password: PASSWORD }, EXPORT_PASSWORD);
    c.lock();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(await c.exportBackup({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'locked',
    });
  });

  it('accepts a passkey assertion with user verification instead (D181, §14)', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await exporting(authenticator);
    expect(await c.exportBackup({ kind: 'passkey' })).toEqual({ kind: 'unavailable' });
    await c.setUpPasskey(PASSWORD);
    expect((await c.exportBackup({ kind: 'passkey' })).kind).toBe('ok');
    authenticator.flags = UP;
    expect(await c.exportBackup({ kind: 'passkey' })).toEqual({ kind: 'no-user-verification' });
    authenticator.flags = UP | UV;
    authenticator.cancel = true;
    expect(await c.exportBackup({ kind: 'passkey' })).toEqual({ kind: 'cancelled' });
  });

  it('names a stored record that fails verification, making no file (D64)', async () => {
    const { c, factory } = await exporting();
    const id = await session(c).createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'ACME',
      fields: [],
      tags: [],
    });
    const db = await VaultDatabase.open(session(c).vaultId, factory);
    const item = must((await db.records()).find((r) => r.recordType === 1));
    const envelope = item.envelope.slice();
    envelope[envelope.length - 1] = (envelope[envelope.length - 1] ?? 0) ^ 1;
    await db.commit({
      put: [{ ...item, envelope: envelope as RecordEnvelope }],
      delete: [],
      localConfig: must(await db.localConfig()),
    });
    db.close();
    expect(await c.exportBackup({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'corrupt-record',
      recordType: 1,
      recordId: recordIdPrefix(id),
    });
    expect(session(c).lastBackupAt).toBeUndefined();
  });
});

describe('fresh restore (§10, D33, D43, D95, D104)', () => {
  const EXPORT_PASSWORD = 'orbit-tulip-granite-ferry-cedar-pixel';
  const NEW_PASSWORD = 'a new local password for this device';

  /** A vault with one item, and its backup, with or without an export password. */
  async function backup(exportPassword?: string) {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'Test device');
    await session(c).createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'ACME',
      fields: [],
      tags: [],
    });
    const made = await c.exportBackup({ kind: 'password', password: PASSWORD }, exportPassword);
    if (made.kind !== 'ok') throw new Error(made.kind);
    const vaultId = session(c).vaultId;
    // The source installation lets go of the vault's Web Lock, as another browser would hold none.
    await c.close();
    return { words, bytes: made.bytes, vaultId };
  }

  /** A new installation, with no vault yet. */
  async function empty(factory = new IDBFactory(), log?: KdfRequest['op'][]) {
    const c = controller(factory, log);
    await c.start();
    expect(c.status.kind).toBe('no-vault');
    return c;
  }

  it('restores a backup by the Recovery Phrase into a new installation', async () => {
    const source = await backup();
    const factory = new IDBFactory();
    const c = await empty(factory);
    const opened = c.openBackupFile(source.bytes);
    if (opened.kind !== 'ok') throw new Error(opened.kind);
    // Unverified until a keyslot opens (D95): shown to choose one.
    expect(opened.header.hasExportPassword).toBe(false);
    expect(typeof opened.header.phraseCreatedAt).toBe('number');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toMatchObject({
      kind: 'ok',
      openedWith: 'phrase',
    });
    // Nothing is written before the local password (D33).
    expect(await factory.databases()).toEqual([]);
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'ok' });
    expect(session(c).vaultId).toEqual(source.vaultId);
    expect(
      session(c)
        .items()
        .map((i) => i.item?.title),
    ).toEqual(['ACME']);
    expect(c.afterRestore).toBeUndefined();

    c.lock();
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    expect(await c.unlock(NEW_PASSWORD)).toBe('ok');
    await c.close();
    const again = controller(factory);
    await again.start();
    expect(again.status.kind).toBe('locked');
  });

  it('restores by the export password and then recommends Check Recovery Phrase (D43)', async () => {
    const source = await backup(EXPORT_PASSWORD);
    const c = await empty();
    const opened = c.openBackupFile(source.bytes);
    expect(opened).toMatchObject({ kind: 'ok', header: { hasExportPassword: true } });
    expect(await c.openBackup({ kind: 'password', password: 'not the export password' })).toEqual({
      kind: 'wrong-secret',
    });
    // A wrong secret keeps the file: the user tries again.
    expect(await c.openBackup({ kind: 'password', password: EXPORT_PASSWORD })).toMatchObject({
      kind: 'ok',
      openedWith: 'password',
    });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'ok' });
    expect(c.afterRestore).toBe('check-phrase');
    c.dismissAfterRestore();
    expect(c.afterRestore).toBeUndefined();
  });

  it('reports a file that is not a backup, a phrase that is not one, and a wrong phrase', async () => {
    const source = await backup();
    const c = await empty();
    expect(c.openBackupFile(new TextEncoder().encode('{"items":[]}'))).toEqual({
      kind: 'not-a-backup',
    });
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'no-file',
    });
    c.openBackupFile(source.bytes);
    const words = source.words.split(' ');
    words[2] = 'notaword';
    expect(await c.openBackup({ kind: 'phrase', words: words.join(' ') })).toEqual({
      kind: 'invalid-phrase',
      reason: 'unknown-word',
      position: 3,
    });
    const otherWords = (await backup()).words;
    expect(await c.openBackup({ kind: 'phrase', words: otherWords })).toEqual({
      kind: 'wrong-secret',
    });
    expect(await c.openBackup({ kind: 'password', password: EXPORT_PASSWORD })).toEqual({
      kind: 'no-password-keyslot',
    });
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toMatchObject({
      kind: 'ok',
    });
  });

  it('rejects an unknown format version before any keyslot, and a changed header once one opens (D95)', async () => {
    const source = await backup();
    const c = await empty();
    const newer = source.bytes.slice();
    newer[9] = 2;
    expect(c.openBackupFile(newer)).toEqual({ kind: 'newer-version' });
    const changed = source.bytes.slice();
    // The last header byte, in the cleartext stream header: read unverified, refused once a
    // keyslot opens and the first chunk does not authenticate.
    const date = new DataView(changed.buffer).getUint32(10) + 14 - 1;
    changed[date] = (changed[date] ?? 0) ^ 1;
    expect(c.openBackupFile(changed).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'corrupt',
    });
  });

  it('rejects a truncated file once a keyslot opens, and drops it', async () => {
    const source = await backup();
    const c = await empty();
    expect(c.openBackupFile(source.bytes.subarray(0, source.bytes.length - 1)).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'corrupt',
    });
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'no-file',
    });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
  });

  it('persists nothing when locked before the commit, and drops the opened backup (D104)', async () => {
    const source = await backup();
    const factory = new IDBFactory();
    const c = await empty(factory);
    c.openBackupFile(source.bytes);
    await c.openBackup({ kind: 'phrase', words: source.words });
    const pending = c.restore(NEW_PASSWORD);
    expect(c.status.kind).toBe('restoring');
    c.lock();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
    // The validated backup went with the lock: the file must be opened again.
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });

    c.openBackupFile(source.bytes);
    await c.openBackup({ kind: 'phrase', words: source.words });
    c.lock();
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
    expect(await factory.databases()).toEqual([]);
  });

  it('keeps nothing when locked during the export password derivation', async () => {
    const source = await backup(EXPORT_PASSWORD);
    const c = await empty();
    c.openBackupFile(source.bytes);
    const pending = c.openBackup({ kind: 'password', password: EXPORT_PASSWORD });
    c.lock();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
  });

  it('restores nothing while a vault exists, and opens no backup while it is locked', async () => {
    const source = await backup();
    const c = await created();
    // Unlocked, a backup opens for a merge (D182), never for a fresh restore.
    expect(c.openBackupFile(source.bytes).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'different-vault',
    });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
    c.lock();
    expect(c.openBackupFile(source.bytes)).toEqual({ kind: 'unavailable' });
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'no-file',
    });
  });
});

describe('backup merge (§10, sync-protocol.md §1, D13, D43, D182)', () => {
  const EXPORT_PASSWORD = 'orbit-tulip-granite-ferry-cedar-pixel';
  const NEW_PASSWORD = 'a new local password for this device';
  const T0 = Date.UTC(2026, 9, 1);
  const DAY = 24 * 60 * 60 * 1000;

  function login(title: string) {
    return { templateId: 'login', templateVersion: 1, title, fields: [], tags: [] };
  }

  /**
   * Installation A creates the vault and backs it up; installation B restores that backup, adds an
   * item and backs it up in turn. Each lets go of the vault's Web Lock before the next starts.
   */
  async function twoInstallations(options: { exportPassword?: string; bNow?: number } = {}) {
    const factoryA = new IDBFactory();
    const a = controller(factoryA, undefined, undefined, () => T0);
    await a.start();
    const words = must(a.newRecoveryPhrase());
    await a.create(PASSWORD, 'Device A');
    const id = await session(a).createItem(login('ACME'));
    const first = await a.exportBackup({ kind: 'password', password: PASSWORD });
    if (first.kind !== 'ok') throw new Error(first.kind);
    await a.close();

    const b = controller(new IDBFactory(), undefined, undefined, () => options.bNow ?? T0 + 1000);
    await b.start();
    b.openBackupFile(first.bytes);
    await b.openBackup({ kind: 'phrase', words });
    await b.restore(NEW_PASSWORD);
    const fromB = await session(b).createItem(login('From B'));
    const made = await b.exportBackup(
      { kind: 'password', password: NEW_PASSWORD },
      options.exportPassword,
    );
    if (made.kind !== 'ok') throw new Error(made.kind);
    await b.close();

    const again = controller(factoryA, undefined, undefined, () => T0 + 2000);
    await again.start();
    expect(await again.unlock(PASSWORD)).toBe('ok');
    return { a: again, words, bytes: made.bytes, id, fromB };
  }

  it('merges a backup of the same vault by the Recovery Phrase, in one commit', async () => {
    const { a, words, bytes, fromB } = await twoInstallations();
    expect(a.openBackupFile(bytes).kind).toBe('ok');
    expect(await a.openBackup({ kind: 'phrase', words })).toMatchObject({ kind: 'ok' });
    const merged = await a.mergeBackup();
    if (merged.kind !== 'ok') throw new Error(merged.kind);
    expect(merged.result).toMatchObject({ added: 1, replaced: 0, phraseChanged: false });
    expect(session(a).item(fromB)?.item?.title).toBe('From B');
    expect(a.afterRestore).toBeUndefined();
    // The opened backup went with the merge.
    expect(await a.mergeBackup()).toEqual({ kind: 'no-backup' });

    a.lock();
    expect(await a.unlock(PASSWORD)).toBe('ok');
    expect(session(a).item(fromB)?.item?.title).toBe('From B');
  });

  it('recommends Check Recovery Phrase after a merge opened with an export password (D43)', async () => {
    const { a, bytes } = await twoInstallations({ exportPassword: EXPORT_PASSWORD });
    a.openBackupFile(bytes);
    await a.openBackup({ kind: 'password', password: EXPORT_PASSWORD });
    expect((await a.mergeBackup()).kind).toBe('ok');
    expect(a.afterRestore).toBe('check-phrase');
  });

  it('says a backup of another vault is one before asking to merge it, and drops it (D13)', async () => {
    const { a } = await twoInstallations();
    const other = controller();
    await other.start();
    const words = must(other.newRecoveryPhrase());
    await other.create(PASSWORD, 'Other');
    const made = await other.exportBackup({ kind: 'password', password: PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    a.openBackupFile(made.bytes);
    expect(await a.openBackup({ kind: 'phrase', words })).toEqual({ kind: 'different-vault' });
    expect(await a.mergeBackup()).toEqual({ kind: 'no-backup' });
  });

  it('refuses a backup with records beyond the future-clock bound, saying when to retry (D64)', async () => {
    const { a, words, bytes, fromB } = await twoInstallations({ bNow: T0 + 3 * DAY });
    a.openBackupFile(bytes);
    await a.openBackup({ kind: 'phrase', words });
    const merged = await a.mergeBackup();
    expect(merged.kind).toBe('future-clock');
    expect(merged).toMatchObject({ retryAt: expect.any(Number) as number });
    expect((merged as { retryAt: number }).retryAt).toBeGreaterThan(T0 + DAY);
    expect(session(a).item(fromB)).toBeUndefined();
  });

  it('merges nothing once locked: the opened backup goes with the lock', async () => {
    const { a, words, bytes } = await twoInstallations();
    a.openBackupFile(bytes);
    await a.openBackup({ kind: 'phrase', words });
    a.lock();
    expect(await a.mergeBackup()).toEqual({ kind: 'no-backup' });
    expect(await a.unlock(PASSWORD)).toBe('ok');
    expect(await a.mergeBackup()).toEqual({ kind: 'no-backup' });
  });
});

describe('vault controller', () => {
  it('starts with no vault, creates one and requests persistence', async () => {
    const factory = new IDBFactory();
    const persist: boolean[] = [];
    const c = new VaultController({
      factory,
      locks: navigator.locks,
      kdf: fakeKdf(),
      storage: { persist: () => Promise.resolve(persist.push(true) > 0) } as StorageManager,
    });
    controllers.push(c);
    await c.start();
    expect(c.status.kind).toBe('no-vault');
    await createIn(c);
    expect(session(c).devices()).toHaveLength(1);
    expect(persist).toEqual([true]);
    expect((await factory.databases()).map((d) => d.name)).toEqual([
      `blindvault-${[...session(c).vaultId].map((b) => b.toString(16).padStart(2, '0')).join('')}`,
    ]);
  });

  it('locks, refuses a wrong password, and unlocks the same vault again', async () => {
    const c = await created();
    const vaultId = session(c).vaultId;
    const s = session(c);
    c.lock();
    expect(c.status.kind).toBe('locked');
    expect(s.locked).toBe(true);
    expect(await c.unlock('another password entirely')).toBe('wrong-password');
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(session(c).vaultId).toEqual(vaultId);
  });

  it('finds the vault at the next start, through its database', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    await first.close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('deletes an uncommitted database at start (D89)', async () => {
    const factory = new IDBFactory();
    (await VaultDatabase.open(new Uint8Array(16).fill(1), factory)).close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('is busy while another app window holds the installation guard (D97)', async () => {
    const guard = await acquireInstallationGuard();
    const c = controller();
    await c.start();
    expect(c.status.kind).toBe('busy');
    await guard?.release();
    await c.start();
    expect(c.status.kind).toBe('no-vault');
  });

  it('does not open a vault another app window holds, and takes it over (D51)', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    const firstSession = session(first);
    const second = controller(factory);
    await second.start();
    expect(second.status.kind).toBe('elsewhere');
    await second.takeOver();
    expect(second.status.kind).toBe('locked');
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(first.status.kind).toBe('elsewhere');
    expect(firstSession.locked).toBe(true);
    expect(await second.unlock(PASSWORD)).toBe('ok');
  });

  it('aborts a creation locked before its commit, persisting nothing (D104)', async () => {
    const factory = new IDBFactory();
    const c = controller(factory);
    await c.start();
    const pending = createIn(c);
    c.lock();
    await pending;
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
    // The installation guard is free again.
    const guard = await acquireInstallationGuard();
    expect(guard).not.toBeNull();
    await guard?.release();
  });

  it('aborts a creation locked while its password is derived (D104)', async () => {
    const factory = new IDBFactory();
    let answer = () => {
      // replaced once the request is posted
    };
    const slow = () => {
      const port = fakeKdf()();
      const post = port.postMessage.bind(port);
      port.postMessage = (message, transfer) => {
        answer = () => {
          post(message, transfer);
        };
      };
      return port;
    };
    const c = new VaultController({ factory, locks: navigator.locks, kdf: slow });
    controllers.push(c);
    await c.start();
    const pending = createIn(c);
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(c.status.kind).toBe('creating');
    c.lock();
    answer();
    await pending;
    expect(c.status.kind).toBe('no-vault');
    expect(await factory.databases()).toEqual([]);
  });

  it('fails a near miss and an unrelated password alike, storing and logging nothing (Gate A)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log);
    await c.start();
    await createIn(c);
    const vaultId = session(c).vaultId;
    c.lock();
    const stored = async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      try {
        return await db.localConfig();
      } finally {
        db.close();
      }
    };
    const before = await stored();
    const consoleCalls = (['log', 'info', 'warn', 'error', 'debug'] as const).map((method) =>
      vi.spyOn(console, method),
    );
    log.length = 0;
    // The stand-in KDF reads the first 32 bytes: each near miss differs within them.
    const nearMiss = `${PASSWORD.slice(0, 20)}X${PASSWORD.slice(21)}`;
    for (const attempt of [nearMiss, PASSWORD.slice(1), 'zz', PASSWORD.toUpperCase()]) {
      expect(await c.unlock(attempt)).toBe('wrong-password');
      expect(c.status).toEqual({ kind: 'locked' });
    }
    // Every attempt runs one full derivation at the stored parameters, near miss or not.
    expect(log).toEqual(['derive', 'derive', 'derive', 'derive']);
    for (const spy of consoleCalls) {
      expect(spy).not.toHaveBeenCalled();
      spy.mockRestore();
    }
    expect(await stored()).toEqual(before);
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('after lock, derives, asks the authenticator and writes nothing until a new unlock (CRYPTO-INV-010)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const authenticator = new FakeAuthenticator();
    const c = controller(factory, log, authenticator);
    await c.start();
    await createIn(c);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    const old = session(c);
    const vaultId = old.vaultId;
    const preferences = old.preferences;
    c.lock();
    expect(old.locked).toBe(true);
    const stored = async () => {
      const db = await VaultDatabase.open(vaultId, factory);
      try {
        return await db.localConfig();
      } finally {
        db.close();
      }
    };
    const before = await stored();
    log.length = 0;
    authenticator.calls.length = 0;

    expect(await c.changePassword(PASSWORD, 'a new password nobody will guess')).toBe('locked');
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    expect(await c.removePasskey()).toBe('by-hand');
    await c.setPreferences({ ...preferences, clipboardClearSeconds: 45 });
    expect(log).toEqual([]);
    expect(authenticator.calls).toEqual([]);
    expect(authenticator.forgotten).toEqual([]);
    expect(c.status).toEqual({ kind: 'locked' });
    expect(await stored()).toEqual(before);

    // A new unlock opens a new session; the old one stays locked.
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(session(c)).not.toBe(old);
    expect(old.locked).toBe(true);
  });

  it('aborts an unlock locked before it completes', async () => {
    const c = await created();
    c.lock();
    const pending = c.unlock(PASSWORD);
    c.lock();
    expect(await pending).toBe('ok');
    expect(c.status.kind).toBe('locked');
  });

  it('reports a password change locked before or during it, changing nothing', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log);
    await c.start();
    await createIn(c);
    // Locked while the KEKs are derived: the session refuses the re-wrap.
    const pending = c.changePassword(PASSWORD, 'a new long passphrase here');
    c.lock();
    expect(await pending).toBe('locked');
    expect(await c.changePassword(PASSWORD, 'a new long passphrase here')).toBe('locked');
    expect(await c.unlock('a new long passphrase here')).toBe('wrong-password');
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('changes the password only with the current one (D168)', async () => {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log);
    await c.start();
    await createIn(c);
    expect(await c.changePassword('not the password', 'a new long passphrase here')).toBe(
      'wrong-password',
    );
    log.length = 0;
    expect(await c.changePassword(PASSWORD, 'a new long passphrase here')).toBe('ok');
    // The current one is derived at the stored parameters; the new one is calibrated (D9).
    expect(log).toEqual(['derive', 'calibrate']);
    c.lock();
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    expect(await c.unlock('a new long passphrase here')).toBe('ok');
  });

  it('sets preferences and refuses one outside its range', async () => {
    const c = await created();
    const next = { autoLockMinutes: 10, hiddenLockSeconds: 0, clipboardClearSeconds: 60 };
    await c.setPreferences(next);
    expect(session(c).preferences).toEqual(next);
    await expect(c.setPreferences({ ...next, autoLockMinutes: 0 })).rejects.toThrow(RangeError);
  });

  it('reports a corrupt or newer Local Config instead of unlocking', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    const vaultId = session(first).vaultId;
    await first.close();
    const db = await VaultDatabase.open(vaultId, factory);
    await db.updateLocalConfig(() => new Uint8Array([0xa0]));
    db.close();
    const c = controller(factory);
    await c.start();
    expect(c.status.kind).toBe('corrupt');
    const lock = await acquireVaultLock(vaultId);
    expect(lock).not.toBeNull();
    await lock?.release();
  });
});

describe('passkey unlock (§5.5, D75, D84, D172)', () => {
  async function withPasskey(authenticator = new FakeAuthenticator(), factory = new IDBFactory()) {
    const c = controller(factory, undefined, authenticator);
    await c.start();
    await createIn(c);
    return { c, authenticator, factory };
  }

  it('sets up a passkey with the current password and unlocks with it', async () => {
    const { c, authenticator, factory } = await withPasskey();
    expect(c.hasPasskey).toBe(false);
    expect(await c.passkeysSupported()).toBe(true);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    expect(c.hasPasskey).toBe(true);
    expect(authenticator.forgotten).toEqual([]);
    const vaultId = session(c).vaultId;
    c.lock();
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(session(c).vaultId).toEqual(vaultId);
    // Known at the next start too, from the stored Local Config.
    await c.close();
    const next = controller(factory, undefined, authenticator);
    await next.start();
    expect(next.hasPasskey).toBe(true);
    expect(await next.unlockWithPasskey()).toBe('ok');
  });

  it('reports a synced passkey for the notice (D84)', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.flags = UP | UV | BE;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: true });
  });

  it('evaluates the PRF with a get when the create gave no output', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.prf = 'get';
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'ok', backupEligible: false });
    expect(authenticator.calls).toEqual(['create', 'get']);
  });

  it('refuses another current password and signals the new credential as unknown (D172, D120)', async () => {
    const { c, authenticator } = await withPasskey();
    expect(await c.setUpPasskey('not the password')).toEqual({ kind: 'wrong-password' });
    expect(c.hasPasskey).toBe(false);
    expect(session(c).passkeyCredentialId).toBeUndefined();
    expect(authenticator.forgotten).toEqual([new Uint8Array([1])]);
  });

  it('never derives a PRF KEK from a credential created without user verification (D75)', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.flags = UP;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'no-user-verification' });
    expect(c.hasPasskey).toBe(false);
    expect(authenticator.forgotten).toHaveLength(1);
  });

  it('rejects an unlock assertion without user verification (D75, CRYPTO-INV-021)', async () => {
    const { c, authenticator } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    c.lock();
    authenticator.flags = UP | BE;
    expect(await c.unlockWithPasskey()).toBe('no-user-verification');
    expect(c.status.kind).toBe('locked');
    authenticator.flags = UP | UV;
    expect(await c.unlockWithPasskey()).toBe('ok');
  });

  it('reports a cancelled prompt and a PRF the authenticator does not give', async () => {
    const authenticator = new FakeAuthenticator();
    authenticator.cancel = true;
    const { c } = await withPasskey(authenticator);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'cancelled' });
    authenticator.cancel = false;
    authenticator.prf = 'none';
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    authenticator.prf = 'create';
    await c.setUpPasskey(PASSWORD);
    c.lock();
    authenticator.cancel = true;
    expect(await c.unlockWithPasskey()).toBe('cancelled');
    expect(c.status.kind).toBe('locked');
    authenticator.cancel = false;
    authenticator.prf = 'none';
    expect(await c.unlockWithPasskey()).toBe('unavailable');
    expect(c.status.kind).toBe('locked');
  });

  it('rejects a passkey whose PRF output does not open the wrap', async () => {
    const { c, factory } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    await c.close();
    // Another authenticator answering for the same credential ID gives another PRF output.
    const other = new FakeAuthenticator();
    await other.create(new Uint8Array(32));
    const next = controller(factory, undefined, {
      supported: () => other.supported(),
      create: (input) => other.create(input),
      forget: (id) => other.forget(id),
      get: async (id, input) => ({
        ...(await other.get(id, input)),
        prfOutput: new Uint8Array(32).fill(0x33),
      }),
    });
    await next.start();
    expect(await next.unlockWithPasskey()).toBe('rejected');
    expect(next.status.kind).toBe('locked');
    expect(await next.unlock(PASSWORD)).toBe('ok');
  });

  it('aborts a setup locked during the prompt, signalling the credential (D104, D105)', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await withPasskey(authenticator);
    const create = authenticator.create.bind(authenticator);
    authenticator.create = (input) => {
      c.lock();
      return create(input);
    };
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'cancelled' });
    expect(c.status.kind).toBe('locked');
    expect(c.hasPasskey).toBe(false);
    expect(authenticator.forgotten).toHaveLength(1);
  });

  it('aborts an unlock locked during the prompt', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await withPasskey(authenticator);
    await c.setUpPasskey(PASSWORD);
    c.lock();
    const get = authenticator.get.bind(authenticator);
    authenticator.get = (id, input) => {
      c.lock();
      return get(id, input);
    };
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(c.status.kind).toBe('locked');
  });

  it('removes the passkey and asks the authenticator to forget it, or says to do it by hand (D120)', async () => {
    const { c, authenticator } = await withPasskey();
    await c.setUpPasskey(PASSWORD);
    expect(await c.removePasskey()).toBe('forgotten');
    expect(authenticator.forgotten).toEqual([new Uint8Array([1])]);
    expect(c.hasPasskey).toBe(false);
    c.lock();
    expect(await c.unlockWithPasskey()).toBe('ok');
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
    authenticator.signal = false;
    await c.setUpPasskey(PASSWORD);
    expect(await c.removePasskey()).toBe('by-hand');
  });

  it('offers no passkey without WebAuthn', async () => {
    const c = await created();
    expect(await c.passkeysSupported()).toBe(false);
    expect(await c.setUpPasskey(PASSWORD)).toEqual({ kind: 'unavailable' });
    expect(c.hasPasskey).toBe(false);
  });
});
