import {
  type KdfPort,
  type KdfRequest,
  Keyring,
  MEMLIMIT,
  type RecordEnvelope,
  RecordType,
  deriveRecoveryKeys,
  parseRecoveryPhrase,
} from '@blindvault/crypto';
import {
  VaultDatabase,
  acquireInstallationGuard,
  acquireVaultLock,
  databaseName,
} from '@blindvault/storage';
import { parseLocalConfig } from '@blindvault/vault';
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

describe('Recovery Phrase regeneration (§5.4, D104, D185)', () => {
  async function regenerating(passkeys?: PasskeyPort) {
    const log: KdfRequest['op'][] = [];
    const factory = new IDBFactory();
    const c = controller(factory, log, passkeys);
    await c.start();
    const old = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'Test device');
    log.length = 0;
    return { c, log, factory, old };
  }

  it('shows a new phrase until the commit, then regenerates with the local password again', async () => {
    const { c, log, old } = await regenerating();
    const notified = vi.fn();
    c.subscribe(notified);
    const before = must(session(c).recovery);
    expect(c.showingPhrase).toBe(false);
    const words = must(c.newRegenerationPhrase());
    expect(words.split(' ')).toHaveLength(24);
    expect(c.showingPhrase).toBe(true);
    expect(notified).toHaveBeenCalled();

    const done = await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD });
    if (done.kind !== 'ok') throw new Error(done.kind);
    expect(log).toEqual(['derive']);
    expect(c.showingPhrase).toBe(false);
    expect(done.recovery.phraseId).not.toEqual(before.phraseId);
    expect(session(c).recovery).toEqual(done.recovery);
    expect(c.checkRecoveryPhrase(words)).toEqual({ kind: 'opens' });
    expect(c.checkRecoveryPhrase(old)).toEqual({ kind: 'wrong-phrase' });
    // The phrase went with the commit: a second regeneration needs a new one.
    expect(await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'no-phrase',
    });
  });

  it('keeps the phrase for another try after a wrong password, writing nothing', async () => {
    const { c, old } = await regenerating();
    const words = must(c.newRegenerationPhrase());
    expect(
      await c.regenerateRecoveryPhrase({ kind: 'password', password: 'not the password' }),
    ).toEqual({ kind: 'wrong-password' });
    expect(c.showingPhrase).toBe(true);
    expect(c.checkRecoveryPhrase(old)).toEqual({ kind: 'opens' });
    expect((await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).kind).toBe(
      'ok',
    );
    expect(c.checkRecoveryPhrase(words)).toEqual({ kind: 'opens' });
  });

  it('drops the phrase on cancel and on lock, also during the password derivation (D104)', async () => {
    const { c, old } = await regenerating();
    c.newRegenerationPhrase();
    c.cancelRegeneration();
    expect(c.showingPhrase).toBe(false);
    expect(await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'no-phrase',
    });

    c.newRegenerationPhrase();
    const pending = c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD });
    c.lock();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(c.showingPhrase).toBe(false);
    expect(c.newRegenerationPhrase()).toBeUndefined();
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(c.checkRecoveryPhrase(old)).toEqual({ kind: 'opens' });
    expect(await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'no-phrase',
    });
  });

  it('reports a block before asking for the password, and hands out no phrase then (D179)', async () => {
    const { c, log, factory } = await regenerating();
    c.newRegenerationPhrase();
    const { vaultId } = session(c);
    c.lock();
    const db = await VaultDatabase.open(vaultId, factory);
    const envelope = must(
      (await db.records()).find((r) => r.recordType === RecordType.recoveryEnvelope),
    );
    await db.commit({
      put: [],
      delete: [{ recordType: envelope.recordType, recordId: envelope.recordId }],
      localConfig: must(await db.localConfig()),
    });
    db.close();
    expect(await c.unlock(PASSWORD)).toBe('ok');
    log.length = 0;
    expect(c.newRegenerationPhrase()).toBeUndefined();
    expect(await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).toEqual({
      kind: 'no-phrase',
    });
    expect(log).toEqual([]);
  });

  it('accepts a passkey assertion with user verification instead (D181, D185)', async () => {
    const authenticator = new FakeAuthenticator();
    const { c } = await regenerating(authenticator);
    c.newRegenerationPhrase();
    expect(await c.regenerateRecoveryPhrase({ kind: 'passkey' })).toEqual({
      kind: 'unavailable',
    });
    await c.setUpPasskey(PASSWORD);
    authenticator.flags = UP;
    expect(await c.regenerateRecoveryPhrase({ kind: 'passkey' })).toEqual({
      kind: 'no-user-verification',
    });
    authenticator.flags = UP | UV;
    expect((await c.regenerateRecoveryPhrase({ kind: 'passkey' })).kind).toBe('ok');
  });

  it('hands out no regeneration phrase without an unlocked vault', async () => {
    const c = controller();
    await c.start();
    expect(c.newRegenerationPhrase()).toBeUndefined();
    expect(c.showingPhrase).toBe(false);
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

  /** Restores `bytes` by the phrase into a new installation. */
  async function restored(bytes: Uint8Array, words: string) {
    const c = await empty();
    if (c.openBackupFile(bytes).kind !== 'ok') throw new Error('not a backup');
    await c.openBackup({ kind: 'phrase', words });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'ok' });
    return c;
  }

  it('recommends re-admission once after a restore, until dismissed or locked (D30, D186)', async () => {
    const source = await backup();
    const c = await restored(source.bytes, source.words);
    expect(session(c).registered).toBe(false);
    expect(c.readmissionNotice).toBe(true);
    c.dismissReadmission();
    expect(c.readmissionNotice).toBe(false);
    // Another installation: this one lets go of the vault's Web Lock (D51).
    await c.close();

    const again = await restored(source.bytes, source.words);
    expect(again.readmissionNotice).toBe(true);
    again.lock();
    expect(again.readmissionNotice).toBe(false);
    expect(await again.unlock(NEW_PASSWORD)).toBe('ok');
    expect(again.readmissionNotice).toBe(false);
  });

  it('does not recommend re-admission when every other device is retired: the device is the only one (D119)', async () => {
    const source = await backup();
    const b = await restored(source.bytes, source.words);
    const [creator] = session(b).devices();
    expect(await b.retireDevice(must(creator).deviceId)).toBe('ok');
    const made = await b.exportBackup({ kind: 'password', password: NEW_PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    await b.close();

    const c = await restored(made.bytes, source.words);
    expect(session(c).registered).toBe(false);
    expect(c.readmissionNotice).toBe(false);
  });

  it('retires another device, refuses its own and a retired one, and nothing once locked (D41, D186)', async () => {
    const source = await backup();
    const c = await restored(source.bytes, source.words);
    const seen: string[] = [];
    c.subscribe(() => seen.push(c.status.kind));
    const creator = must(session(c).devices()[0]).deviceId;
    expect(await c.retireDevice(session(c).deviceId)).toBe('refused');
    expect(await c.retireDevice(creator)).toBe('ok');
    expect(seen).toEqual(['unlocked']);
    expect(session(c).devices()[0]?.device.retired).toBe(true);
    expect(await c.retireDevice(creator)).toBe('refused');
    c.lock();
    expect(await c.retireDevice(creator)).toBe('locked');
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

  it('restores nothing while a vault exists, unless it is locked and replaced explicitly (D183)', async () => {
    const source = await backup();
    const c = await created();
    // Unlocked, a backup opens for a merge (D182), never for a fresh restore.
    expect(c.openBackupFile(source.bytes).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toEqual({
      kind: 'different-vault',
    });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
    expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'no-backup' });
    // Locked, a backup opens to replace the vault, and only an explicit replacement restores it.
    c.lock();
    expect(c.openBackupFile(source.bytes).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: source.words })).toMatchObject({
      kind: 'ok',
    });
    expect(await c.restore(NEW_PASSWORD)).toEqual({ kind: 'no-backup' });
    expect(c.status.kind).toBe('locked');
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });
});

describe('forgotten password reset (§14, D173, D184)', () => {
  const NEW_PASSWORD = 'a new local password for this device';

  async function lockedWithItem(factory = new IDBFactory()) {
    const c = controller(factory);
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'This device');
    const id = await session(c).createItem({
      templateId: 'login',
      templateVersion: 1,
      title: 'Only here',
      fields: [],
      tags: [],
    });
    c.lock();
    return { c, words, id };
  }

  async function localConfigBytes(factory: IDBFactory) {
    const [name] = (await factory.databases()).map((d) => d.name ?? '');
    const db = must((await VaultDatabase.openExisting(factory, must(name))) ?? undefined);
    try {
      return must(await db.localConfig());
    } finally {
      db.close();
    }
  }

  it('sets a new local password with the Recovery Phrase and unlocks, keeping every change', async () => {
    const factory = new IDBFactory();
    const { c, words, id } = await lockedWithItem(factory);
    const pending = c.resetPassword(words, NEW_PASSWORD);
    expect(c.status.kind).toBe('resetting');
    expect(await pending).toEqual({ kind: 'ok' });
    expect(session(c).item(id)?.item?.title).toBe('Only here');

    c.lock();
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    await c.close();
    const again = controller(factory);
    await again.start();
    expect(await again.unlock(NEW_PASSWORD)).toBe('ok');
    expect(session(again).item(id)?.item?.title).toBe('Only here');
  });

  it('reports input that is not a phrase and a phrase that does not open the vault, writing nothing', async () => {
    const factory = new IDBFactory();
    const { c, words } = await lockedWithItem(factory);
    const before = await localConfigBytes(factory);
    const typo = words.split(' ');
    typo[4] = 'notaword';
    expect(await c.resetPassword(typo.join(' '), NEW_PASSWORD)).toEqual({
      kind: 'invalid',
      reason: 'unknown-word',
      position: 5,
    });
    const other = controller();
    await other.start();
    const otherWords = must(other.newRecoveryPhrase());
    expect(await c.resetPassword(otherWords, NEW_PASSWORD)).toEqual({ kind: 'wrong-phrase' });
    expect(c.status.kind).toBe('locked');
    expect(await localConfigBytes(factory)).toEqual(before);
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('writes nothing when locked during the password derivation (D104)', async () => {
    const factory = new IDBFactory();
    const { c, words } = await lockedWithItem(factory);
    const before = await localConfigBytes(factory);
    const pending = c.resetPassword(words, NEW_PASSWORD);
    c.lock();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(c.status.kind).toBe('locked');
    expect(await localConfigBytes(factory)).toEqual(before);
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('resets nothing unless the vault is locked', async () => {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase());
    expect(await c.resetPassword(words, NEW_PASSWORD)).toEqual({ kind: 'unavailable' });
    await c.create(PASSWORD, 'This device');
    expect(await c.resetPassword(words, NEW_PASSWORD)).toEqual({ kind: 'unavailable' });
    c.lock();
    expect(await c.resetPassword(words, NEW_PASSWORD)).toEqual({ kind: 'ok' });
  });
});

describe('replacing the vault by a backup (§10, D89, D96, D120, D153, D154, D183)', () => {
  const NEW_PASSWORD = 'a new local password for this device';

  function login(title: string) {
    return { templateId: 'login', templateVersion: 1, title, fields: [], tags: [] };
  }

  /** A vault with one item and its backup by the phrase, made in an installation of its own. */
  async function backupOf(title: string) {
    const c = controller();
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'Source');
    await session(c).createItem(login(title));
    const made = await c.exportBackup({ kind: 'password', password: PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    const vaultId = session(c).vaultId;
    await c.close();
    return { words, bytes: made.bytes, vaultId };
  }

  /** The installation's vault, locked, with one item. */
  async function lockedVault(factory = new IDBFactory(), passkeys?: FakeAuthenticator) {
    const c = controller(factory, undefined, passkeys);
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'This device');
    await session(c).createItem(login('Held'));
    if (passkeys) expect(await c.setUpPasskey(PASSWORD)).toMatchObject({ kind: 'ok' });
    const vaultId = session(c).vaultId;
    c.lock();
    return { c, words, vaultId };
  }

  async function open(c: VaultController, file: { bytes: Uint8Array; words: string }) {
    expect(c.openBackupFile(file.bytes).kind).toBe('ok');
    expect(await c.openBackup({ kind: 'phrase', words: file.words })).toMatchObject({
      kind: 'ok',
    });
  }

  function titles(c: VaultController) {
    return session(c)
      .items()
      .map((i) => i.item?.title);
  }

  async function names(factory: IDBFactory) {
    return (await factory.databases()).map((d) => d.name).sort();
  }

  async function localConfigOf(factory: IDBFactory, vaultId: Uint8Array) {
    const db = await VaultDatabase.open(vaultId, factory);
    try {
      return parseLocalConfig(must(await db.localConfig()));
    } finally {
      db.close();
    }
  }

  it('replaces the locked vault by a backup of another vault, deleting the old database after the commit (D89, D96)', async () => {
    const other = await backupOf('Other');
    const factory = new IDBFactory();
    const { c, vaultId } = await lockedVault(factory);
    await open(c, other);
    const pending = c.restore(NEW_PASSWORD, { replace: true });
    expect(c.status.kind).toBe('replacing');
    expect(await pending).toEqual({ kind: 'ok' });
    expect(session(c).vaultId).toEqual(other.vaultId);
    expect(titles(c)).toEqual(['Other']);
    expect(await names(factory)).toEqual([databaseName(other.vaultId)]);
    // D96: the replaced vaultId left the cleartext part with the old database.
    expect((await localConfigOf(factory, other.vaultId)).replacesVaultId).toBeUndefined();
    expect(c.leftoverPasskey).toBe(false);

    await c.close();
    const again = controller(factory);
    await again.start();
    expect(again.status.kind).toBe('locked');
    expect(await again.unlock(PASSWORD)).toBe('wrong-password');
    expect(await again.unlock(NEW_PASSWORD)).toBe('ok');
    expect(session(again).vaultId).toEqual(other.vaultId);
    expect(session(again).vaultId).not.toEqual(vaultId);
  });

  it('replaces a vault whose password is forgotten by a backup of the same vault, in its own database (D153)', async () => {
    const factory = new IDBFactory();
    const c = controller(factory);
    await c.start();
    const words = must(c.newRecoveryPhrase());
    await c.create(PASSWORD, 'This device');
    await session(c).createItem(login('Backed up'));
    const made = await c.exportBackup({ kind: 'password', password: PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    await session(c).createItem(login('Only here'));
    const vaultId = session(c).vaultId;
    const before = await localConfigOf(factory, vaultId);
    c.lock();

    await open(c, { bytes: made.bytes, words });
    expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'ok' });
    // The changes made only on this device since the backup are gone, as the warning says.
    expect(titles(c)).toEqual(['Backed up']);
    expect(await names(factory)).toEqual([databaseName(vaultId)]);
    const after = await localConfigOf(factory, vaultId);
    expect(after.localConfigId).not.toEqual(before.localConfigId);
    expect(after.replacesVaultId).toBeUndefined();

    c.lock();
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    expect(await c.unlock(NEW_PASSWORD)).toBe('ok');
    expect(titles(c)).toEqual(['Backed up']);
  });

  it('leaves the old vault intact when locked before the commit (D104, D153)', async () => {
    for (const same of [false, true]) {
      const factory = new IDBFactory();
      const { c, words, vaultId } = await lockedVault(factory);
      if (same) {
        expect(await c.unlock(PASSWORD)).toBe('ok');
        const made = await c.exportBackup({ kind: 'password', password: PASSWORD });
        if (made.kind !== 'ok') throw new Error(made.kind);
        c.lock();
        await open(c, { bytes: made.bytes, words });
      } else {
        await open(c, await backupOf('Other'));
      }
      const pending = c.restore(NEW_PASSWORD, { replace: true });
      c.lock();
      expect(await pending).toEqual({ kind: 'locked' });
      expect(c.status.kind).toBe('locked');
      // The opened backup went with the lock.
      expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'no-backup' });
      expect(await c.unlock(PASSWORD)).toBe('ok');
      expect(session(c).vaultId).toEqual(vaultId);
      expect(titles(c)).toEqual(['Held']);
      await c.close();
      const again = controller(factory);
      await again.start();
      expect(await names(factory)).toEqual([databaseName(vaultId)]);
    }
  });

  it('replaces nothing while another app window holds the installation guard (D97)', async () => {
    const factory = new IDBFactory();
    const { c, vaultId } = await lockedVault(factory);
    await open(c, await backupOf('Other'));
    const guard = must((await acquireInstallationGuard(navigator.locks)) ?? undefined);
    try {
      expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'busy' });
    } finally {
      await guard.release();
    }
    expect(c.status.kind).toBe('locked');
    expect(await names(factory)).toEqual([databaseName(vaultId)]);
    expect(await c.unlock(PASSWORD)).toBe('ok');
  });

  it('keeps the new vault when the old database cannot be deleted: startup deletes it (D89, D96)', async () => {
    const other = await backupOf('Other');
    const factory = new IDBFactory();
    const { c, vaultId } = await lockedVault(factory);
    await open(c, other);
    const remove = vi.spyOn(factory, 'deleteDatabase').mockImplementationOnce(() => {
      throw new Error('interrupted');
    });
    expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'ok' });
    remove.mockRestore();
    expect(session(c).vaultId).toEqual(other.vaultId);
    expect(await names(factory)).toEqual(
      [databaseName(vaultId), databaseName(other.vaultId)].sort(),
    );
    expect((await localConfigOf(factory, other.vaultId)).replacesVaultId).toEqual(vaultId);

    await c.close();
    const again = controller(factory);
    await again.start();
    expect(await names(factory)).toEqual([databaseName(other.vaultId)]);
    expect((await localConfigOf(factory, other.vaultId)).replacesVaultId).toBeUndefined();
    expect(await again.unlock(NEW_PASSWORD)).toBe('ok');
  });

  it('asks the authenticator to forget the old vault’s passkey, or says to do it by hand (D120, D153)', async () => {
    for (const signal of [true, false]) {
      const authenticator = new FakeAuthenticator();
      authenticator.signal = signal;
      const { c } = await lockedVault(new IDBFactory(), authenticator);
      expect(c.hasPasskey).toBe(true);
      await open(c, await backupOf('Other'));
      expect(await c.restore(NEW_PASSWORD, { replace: true })).toEqual({ kind: 'ok' });
      expect(authenticator.forgotten).toEqual([new Uint8Array([1])]);
      expect(c.hasPasskey).toBe(false);
      expect(c.leftoverPasskey).toBe(!signal);
      c.dismissLeftoverPasskey();
      expect(c.leftoverPasskey).toBe(false);
    }
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

describe('re-founding (§14, D28, D89, D93, D96, D120, D187)', () => {
  const NEW_PASSWORD = 'a new local password after re-founding';
  const ITEM = { templateId: 'login', templateVersion: 1, title: 'ACME', fields: [], tags: [] };

  /** A controller whose next derivation waits for `answer()` once `hold` is set. */
  function held(factory: IDBFactory, passkeys?: PasskeyPort) {
    const gate: { hold: boolean; answer: () => void } = { hold: false, answer: () => undefined };
    const kdf = () => {
      const port = fakeKdf()();
      const post = port.postMessage.bind(port);
      port.postMessage = (message, transfer) => {
        if (!gate.hold) {
          post(message, transfer);
          return;
        }
        gate.answer = () => {
          post(message, transfer);
        };
      };
      return port;
    };
    const c = new VaultController({
      factory,
      locks: navigator.locks,
      kdf,
      ...(passkeys ? { passkeys } : {}),
    });
    controllers.push(c);
    return { c, gate };
  }

  async function vault(factory = new IDBFactory(), passkeys?: PasskeyPort) {
    const { c, gate } = held(factory, passkeys);
    await c.start();
    await createIn(c);
    await session(c).createItem(ITEM);
    return { c, gate, factory, oldVaultId: session(c).vaultId };
  }

  async function names(factory: IDBFactory) {
    return (await factory.databases()).map((d) => d.name).sort();
  }

  it('re-founds after the password, then keeps only the new vault, under the new password (D28, D89, D96)', async () => {
    const { c, factory, oldVaultId } = await vault();
    const old = session(c);
    expect(c.newRefoundingPhrase()).toBeUndefined();
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    const words = must(c.newRefoundingPhrase());
    expect(words.split(' ')).toHaveLength(24);
    expect(c.showingPhrase).toBe(true);
    expect(await c.refound(NEW_PASSWORD, 'Fallback name')).toEqual({ kind: 'ok' });

    expect(old.locked).toBe(true);
    const fresh = session(c);
    expect(fresh.vaultId).not.toEqual(oldVaultId);
    expect(fresh.items().map((i) => i.item?.title)).toEqual(['ACME']);
    expect(fresh.devices().map((d) => d.device.displayName)).toEqual(['Test device']);
    expect(fresh.checkRecoveryPhrase(words)).toBe('opens');
    expect(c.showingPhrase).toBe(false);
    expect(c.afterRefounding).toBe(true);
    expect(await names(factory)).toEqual([databaseName(fresh.vaultId)]);
    const db = await VaultDatabase.open(fresh.vaultId, factory);
    expect(parseLocalConfig(must(await db.localConfig())).replacesVaultId).toBeUndefined();
    db.close();

    c.lock();
    expect(c.afterRefounding).toBe(false);
    expect(await c.unlock(PASSWORD)).toBe('wrong-password');
    expect(await c.unlock(NEW_PASSWORD)).toBe('ok');
  });

  it('refuses a wrong password before any phrase, and drops everything on cancel (D187)', async () => {
    const { c } = await vault();
    expect(await c.beginRefounding({ kind: 'password', password: 'not it' })).toBe(
      'wrong-password',
    );
    expect(c.newRefoundingPhrase()).toBeUndefined();
    expect(await c.refound(NEW_PASSWORD, 'X')).toEqual({ kind: 'not-started' });
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    expect(await c.refound(NEW_PASSWORD, 'X')).toEqual({ kind: 'no-phrase' });
    expect(c.newRefoundingPhrase()).toBeDefined();
    c.cancelRefounding();
    expect(c.showingPhrase).toBe(false);
    expect(c.newRefoundingPhrase()).toBeUndefined();
    expect(await c.refound(NEW_PASSWORD, 'X')).toEqual({ kind: 'not-started' });
  });

  it('accepts a passkey assertion as the proof (D187)', async () => {
    const passkeys = new FakeAuthenticator();
    const { c, factory } = await vault(new IDBFactory(), passkeys);
    expect((await c.setUpPasskey(PASSWORD)).kind).toBe('ok');
    const credential = must(session(c).passkeyCredentialId);
    expect(await c.beginRefounding({ kind: 'passkey' })).toBe('ok');
    c.newRefoundingPhrase();
    expect(await c.refound(NEW_PASSWORD, 'X')).toEqual({ kind: 'ok' });
    // The old vault's passkey wrap went with its Local Config: the authenticator is asked to forget it (D120).
    expect(passkeys.forgotten).toEqual([credential]);
    expect(c.leftoverPasskey).toBe(false);
    expect(session(c).passkeyCredentialId).toBeUndefined();
    expect(await names(factory)).toHaveLength(1);
  });

  it('leaves the old vault intact when locked before the commit, also during the derivation (D93, D104)', async () => {
    const { c, gate, factory, oldVaultId } = await vault();
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    c.newRefoundingPhrase();
    c.lock();
    expect(c.showingPhrase).toBe(false);
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(c.newRefoundingPhrase()).toBeUndefined();

    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    c.newRefoundingPhrase();
    gate.hold = true;
    const pending = c.refound(NEW_PASSWORD, 'X');
    await new Promise((resolve) => setTimeout(resolve, 5));
    c.lock();
    gate.hold = false;
    gate.answer();
    expect(await pending).toEqual({ kind: 'locked' });
    expect(await names(factory)).toEqual([databaseName(oldVaultId)]);
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(session(c).vaultId).toEqual(oldVaultId);
    expect(
      session(c)
        .items()
        .map((i) => i.item?.title),
    ).toEqual(['ACME']);
  });

  it('re-founds nothing while another app window holds the installation guard (D97)', async () => {
    const { c, factory, oldVaultId } = await vault();
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    c.newRefoundingPhrase();
    const guard = must((await acquireInstallationGuard(navigator.locks)) ?? undefined);
    try {
      expect(await c.refound(NEW_PASSWORD, 'X')).toEqual({ kind: 'busy' });
    } finally {
      await guard.release();
    }
    expect(session(c).vaultId).toEqual(oldVaultId);
    expect(c.showingPhrase).toBe(true);
    expect(await names(factory)).toEqual([databaseName(oldVaultId)]);
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

describe('backup reminder (§13.4, D188)', () => {
  const DAY = 24 * 60 * 60 * 1000;
  const T0 = new Date(2026, 2, 4, 12).getTime();

  it('reminds a new vault, until dismissed or a backup is made; a lock brings it back while due', async () => {
    const c = controller(new IDBFactory(), undefined, undefined, () => T0);
    await c.start();
    expect(c.backupReminder).toBeUndefined();
    await createIn(c);
    expect(c.backupReminder).toEqual({ kind: 'never' });
    c.dismissBackupReminder();
    expect(c.backupReminder).toBeUndefined();
    c.lock();
    expect(c.backupReminder).toBeUndefined();
    expect(await c.unlock(PASSWORD)).toBe('ok');
    expect(c.backupReminder).toEqual({ kind: 'never' });
    expect((await c.exportBackup({ kind: 'password', password: PASSWORD })).kind).toBe('ok');
    expect(c.backupReminder).toBeUndefined();
  });

  it('reminds again 30 days after the last backup, read back from IndexedDB at a later start', async () => {
    let now = T0;
    const factory = new IDBFactory();
    const c = controller(factory, undefined, undefined, () => now);
    await c.start();
    await createIn(c);
    expect((await c.exportBackup({ kind: 'password', password: PASSWORD })).kind).toBe('ok');
    await c.close();

    now = T0 + 30 * DAY - 1;
    const before = controller(factory, undefined, undefined, () => now);
    await before.start();
    expect(await before.unlock(PASSWORD)).toBe('ok');
    expect(before.backupReminder).toBeUndefined();
    await before.close();

    now = T0 + 30 * DAY;
    const after = controller(factory, undefined, undefined, () => now);
    await after.start();
    expect(await after.unlock(PASSWORD)).toBe('ok');
    expect(after.backupReminder).toEqual({ kind: 'stale', at: T0 });
  });

  it('does not carry a dismissal over to the vault that re-founds this one (D187)', async () => {
    const c = controller(new IDBFactory(), undefined, undefined, () => T0);
    await c.start();
    await createIn(c);
    c.dismissBackupReminder();
    expect(c.backupReminder).toBeUndefined();
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    must(c.newRefoundingPhrase());
    expect(await c.refound('a new local password after re-founding', 'Test device')).toEqual({
      kind: 'ok',
    });
    expect(c.backupReminder).toEqual({ kind: 'never' });
  });

  it('reminds when the last backup predates a regenerated Recovery Phrase (D185)', async () => {
    let now = T0;
    const c = controller(new IDBFactory(), undefined, undefined, () => now);
    await c.start();
    await createIn(c);
    expect((await c.exportBackup({ kind: 'password', password: PASSWORD })).kind).toBe('ok');
    now = T0 + DAY;
    must(c.newRegenerationPhrase());
    expect((await c.regenerateRecoveryPhrase({ kind: 'password', password: PASSWORD })).kind).toBe(
      'ok',
    );
    expect(c.backupReminder).toEqual({ kind: 'old-phrase', at: T0 });
  });
});

describe('code loaded before the first unlock (D142, D191)', () => {
  it('shows no start screen until the code has loaded', async () => {
    let loaded = (): void => undefined;
    const c = new VaultController({
      factory: new IDBFactory(),
      locks: navigator.locks,
      kdf: fakeKdf(),
      preload: () =>
        new Promise<void>((resolve) => {
          loaded = resolve;
        }),
    });
    controllers.push(c);
    const started = c.start();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(c.status.kind).toBe('starting');
    loaded();
    await started;
    expect(c.status.kind).toBe('no-vault');
  });

  it('asks for a reload, and opens and creates nothing, when the code failed to load', async () => {
    const factory = new IDBFactory();
    const c = new VaultController({
      factory,
      locks: navigator.locks,
      kdf: fakeKdf(),
      preload: () => Promise.reject(new Error('chunk failed')),
    });
    controllers.push(c);
    await c.start();
    expect(c.status.kind).toBe('incomplete');
    expect(c.newRecoveryPhrase()).toBeUndefined();
    await c.create(PASSWORD, 'Test device');
    await c.unlock(PASSWORD);
    expect(c.status.kind).toBe('incomplete');
    expect(await factory.databases()).toEqual([]);
  });

  it('does not open an existing vault either', async () => {
    const factory = new IDBFactory();
    const first = await created(factory);
    await first.close();
    const c = new VaultController({
      factory,
      locks: navigator.locks,
      kdf: fakeKdf(),
      preload: () => Promise.reject(new Error('worker failed')),
    });
    controllers.push(c);
    await c.start();
    expect(c.status.kind).toBe('incomplete');
    await c.unlock(PASSWORD);
    expect(c.status.kind).toBe('incomplete');
  });
});

describe('asset update offered only between flows (D152, D191)', () => {
  it('is allowed with no vault, locked and unlocked, and not while a phrase is shown', async () => {
    const c = controller();
    expect(c.updateAllowed).toBe(false);
    await c.start();
    expect(c.updateAllowed).toBe(true);
    c.newRecoveryPhrase();
    expect(c.updateAllowed).toBe(false);
    await c.create(PASSWORD, 'Test device');
    expect(c.status.kind).toBe('unlocked');
    expect(c.updateAllowed).toBe(true);
    c.newRegenerationPhrase();
    expect(c.updateAllowed).toBe(false);
    c.cancelRegeneration();
    expect(c.updateAllowed).toBe(true);
    c.lock();
    expect(c.updateAllowed).toBe(true);
  });

  it('is not allowed during a restore or a merge, and says so to its subscribers', async () => {
    const c = await created();
    const made = await c.exportBackup({ kind: 'password', password: PASSWORD });
    if (made.kind !== 'ok') throw new Error(made.kind);
    const seen: boolean[] = [];
    c.subscribe(() => seen.push(c.updateAllowed));
    expect(c.openBackupFile(made.bytes).kind).toBe('ok');
    expect(c.updateAllowed).toBe(false);
    c.cancelRestore();
    expect(c.updateAllowed).toBe(true);
    expect(seen).toEqual([false, true]);
    c.lock();
    expect(c.openBackupFile(made.bytes).kind).toBe('ok');
    expect(c.updateAllowed).toBe(false);
    c.lock();
    expect(c.updateAllowed).toBe(true);
  });

  it('is not allowed during a re-founding, from its proof on', async () => {
    const c = await created();
    expect(await c.beginRefounding({ kind: 'password', password: PASSWORD })).toBe('ok');
    expect(c.updateAllowed).toBe(false);
    c.cancelRefounding();
    expect(c.updateAllowed).toBe(true);
  });

  it('is not allowed in another window, nor while another one is busy', async () => {
    const factory = new IDBFactory();
    await created(factory);
    const second = controller(factory);
    await second.start();
    expect(second.status.kind).toBe('elsewhere');
    expect(second.updateAllowed).toBe(false);
    const guard = await acquireInstallationGuard(navigator.locks);
    const third = controller(new IDBFactory());
    await third.start();
    expect(third.status.kind).toBe('busy');
    expect(third.updateAllowed).toBe(false);
    await guard?.release();
  });
});
