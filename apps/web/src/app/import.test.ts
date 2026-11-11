import { BLINDPASS_KDF_PARAMS, type KdfPort, initCrypto } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { IMPORT_SOURCES, type ImportSource, MAX_IMPORT_SIZE, readImport } from './import';

beforeAll(initCrypto);

const bytes = (s: string) => new TextEncoder().encode(s);
const BITWARDEN = JSON.stringify({
  encrypted: false,
  folders: [{ id: 'f', name: 'Work' }],
  items: [{ id: '1', type: 1, name: 'Google', folderId: 'f', login: { password: 'p' } }],
});
const SEALED = JSON.stringify({
  version: 1,
  type: 'blindpass-export-encrypted',
  kekSalt: 'ht1882pF5SjMHIB35iyfRQ==',
  nonce: 'gdGrmt11vJbaivGpiOyIxzpRmwwXYYmj',
  ciphertext: 'n0zlPO3ut0kIp0d1Sdmopx9pkT1HXkk/PF+kT/IDwqwnBw7hKEH1qYifO0+XxEVQ',
});

/** A worker that answers `data` without deriving. */
function port(data: unknown): () => KdfPort {
  return () => {
    const p: KdfPort = {
      onmessage: null,
      onerror: null,
      postMessage: () => {
        queueMicrotask(() => p.onmessage?.({ data }));
      },
      terminate: () => undefined,
    };
    return p;
  };
}
const none = port(undefined);

describe('import file (overview §15, D123, D130, D146)', () => {
  it('parses and maps the file of the source named, with its preview counts', async () => {
    const read = await readImport('bitwarden', bytes(BITWARDEN), undefined, none);
    expect(read).toMatchObject({ kind: 'ok', mapped: { skipped: 0, attachments: 0, notes: 0 } });
    if (read.kind !== 'ok') throw new Error(read.kind);
    expect(read.mapped.items.map((i) => [i.item.title, i.folder])).toEqual([['Google', ['Work']]]);
    const csv = await readImport(
      'chrome',
      bytes('name,url,username,password\nA,,u,p'),
      undefined,
      none,
    );
    expect(csv).toMatchObject({ kind: 'ok', mapped: { items: [{ item: { title: 'A' } }] } });
  });

  it('rejects a file above 100 MB before parsing, and a file of another format or encoding', async () => {
    const big = new Uint8Array(MAX_IMPORT_SIZE + 1);
    for (const source of Object.keys(IMPORT_SOURCES) as ImportSource[]) {
      expect(await readImport(source, big, undefined, none)).toEqual({
        kind: 'rejected',
        reason: 'too-large',
      });
      expect(
        await readImport(source, new Uint8Array([0xff, 0xfe, 0x00]), undefined, none),
      ).toMatchObject({
        kind: 'rejected',
      });
    }
    const latin1 = new Uint8Array([
      ...bytes('name,url,username,password\nA'),
      0xe9,
      ...bytes(',,u,p'),
    ]);
    expect(await readImport('chrome', latin1, undefined, none)).toEqual({
      kind: 'rejected',
      reason: 'not-this-format',
    });
    expect(await readImport('bitwarden', bytes('[1]'), undefined, none)).toEqual({
      kind: 'rejected',
      reason: 'not-this-format',
    });
    expect(await readImport('protonpass', bytes('{}'), undefined, none)).toEqual({
      kind: 'rejected',
      reason: 'not-this-format',
    });
  });

  it('rejects an encrypted Bitwarden or Proton Pass export with its own reason (D146)', async () => {
    const encrypted = bytes(JSON.stringify({ encrypted: true, items: [] }));
    for (const source of ['bitwarden', 'protonpass'] as const) {
      expect(await readImport(source, encrypted, undefined, none)).toEqual({
        kind: 'rejected',
        reason: 'encrypted-export',
      });
    }
  });

  it('asks for the passphrase of an encrypted .blindpass export, and reads a plaintext one', async () => {
    expect(await readImport('blindpass', bytes(SEALED), undefined, none)).toEqual({
      kind: 'passphrase',
    });
    const wrong = port({ ok: true, key: new Uint8Array(32), params: BLINDPASS_KDF_PARAMS });
    expect(await readImport('blindpass', bytes(SEALED), 'x', wrong)).toEqual({
      kind: 'wrong-passphrase',
    });
    expect(await readImport('blindpass', bytes(SEALED), 'x', port({ ok: false }))).toEqual({
      kind: 'kdf-failed',
    });
    const newer = bytes(SEALED.replace('"version":1', '"version":2'));
    expect(await readImport('blindpass', newer, 'x', none)).toEqual({
      kind: 'rejected',
      reason: 'unsupported-version',
    });
    expect(await readImport('blindpass', bytes('{"items":1}'), undefined, none)).toMatchObject({
      kind: 'rejected',
    });
  });
});
