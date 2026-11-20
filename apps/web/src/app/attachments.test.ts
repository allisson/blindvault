import { MAX_ATTACHMENT_SIZE, blobLength, initCrypto } from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { checkPick, downloadName, saveAttachment } from './attachments';

beforeAll(async () => {
  await initCrypto();
});

function storage(estimate: StorageEstimate | Error): Pick<StorageManager, 'estimate'> {
  return {
    estimate: () =>
      estimate instanceof Error ? Promise.reject(estimate) : Promise.resolve(estimate),
  };
}

describe('checkPick (attachments.md §7, D196)', () => {
  it('refuses an empty file and one above 10 MiB before any estimate', async () => {
    let asked = 0;
    const counting: Pick<StorageManager, 'estimate'> = {
      estimate: () => {
        asked++;
        return Promise.resolve({ usage: 0, quota: 1e12 });
      },
    };
    expect(await checkPick(0, counting)).toEqual({ kind: 'empty' });
    expect(await checkPick(MAX_ATTACHMENT_SIZE + 1, counting)).toEqual({ kind: 'too-large' });
    expect(asked).toBe(0);
    expect(await checkPick(1, counting)).toEqual({ kind: 'ok' });
    expect(await checkPick(MAX_ATTACHMENT_SIZE, counting)).toEqual({ kind: 'ok' });
    expect(asked).toBe(2);
  });

  it('refuses a file whose blob would take usage above the quota, and takes one that fits exactly', async () => {
    const size = 1000;
    const quota = 10_000;
    const fits = quota - blobLength(size);
    expect(await checkPick(size, storage({ usage: fits, quota }))).toEqual({ kind: 'ok' });
    expect(await checkPick(size, storage({ usage: fits + 1, quota }))).toEqual({
      kind: 'no-room',
      usage: fits + 1,
      quota,
    });
  });

  it('takes the file without a storage manager, an estimate, or a usage and quota', async () => {
    expect(await checkPick(5, undefined)).toEqual({ kind: 'ok' });
    expect(await checkPick(5, {} as StorageManager)).toEqual({ kind: 'ok' });
    expect(await checkPick(5, storage({ quota: 1 }))).toEqual({ kind: 'ok' });
    expect(await checkPick(5, storage({ usage: 1e12 }))).toEqual({ kind: 'ok' });
    expect(await checkPick(5, storage(new Error('refused')))).toEqual({ kind: 'ok' });
  });
});

describe('downloadName (attachments.md §7)', () => {
  it('replaces each control and reserved character with _', () => {
    const controls = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join('');
    expect(downloadName(`${controls}\u007f/\\:*?"<>|.txt`)).toBe(`${'_'.repeat(0x2a)}.txt`);
    expect(downloadName('../etc/passwd')).toBe('.._etc_passwd');
  });

  it('keeps any other name as it is', () => {
    expect(downloadName('Relatório 2026 (final).pdf')).toBe('Relatório 2026 (final).pdf');
    expect(downloadName('.hidden')).toBe('.hidden');
  });

  it('names an empty name, or one of only dots, attachment', () => {
    expect(downloadName('')).toBe('attachment');
    expect(downloadName('.')).toBe('attachment');
    expect(downloadName('..')).toBe('attachment');
    expect(downloadName('_')).toBe('_');
  });
});

describe('saveAttachment (attachments.md §7, D273)', () => {
  function fakes() {
    const events: string[] = [];
    const blobs = new Map<string, Blob>();
    const anchor = {
      href: '',
      download: '',
      click: () => {
        events.push(`click ${anchor.href} ${anchor.download}`);
      },
    };
    const env = {
      document: {
        createElement: (tag: string) => {
          events.push(`create ${tag}`);
          return anchor as unknown as HTMLAnchorElement;
        },
      },
      URL: {
        createObjectURL: (blob: Blob) => {
          blobs.set('blob:1', blob);
          events.push('url');
          return 'blob:1';
        },
        revokeObjectURL: (url: string) => {
          events.push(`revoke ${url}`);
        },
      },
    };
    return { env, events, blobs };
  }

  it('saves an octet-stream Blob under the sanitized name, revokes its URL after the click, and wipes the bytes', async () => {
    const { env, events, blobs } = fakes();
    const bytes = new Uint8Array([1, 2, 3]);
    saveAttachment(bytes, 'a:b.html', env);
    expect(events).toEqual(['url', 'create a', 'click blob:1 a_b.html', 'revoke blob:1']);
    const blob = blobs.get('blob:1');
    expect(blob?.type).toBe('application/octet-stream');
    if (!blob) throw new Error('no blob');
    expect(new Uint8Array(await blob.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(bytes).toEqual(new Uint8Array(3));
  });

  it('revokes the URL and wipes the bytes when the click throws', () => {
    const { env, events } = fakes();
    env.document.createElement = () => {
      throw new Error('no document');
    };
    const bytes = new Uint8Array([4, 5]);
    expect(() => {
      saveAttachment(bytes, 'x', env);
    }).toThrow('no document');
    expect(events).toEqual(['url', 'revoke blob:1']);
    expect(bytes).toEqual(new Uint8Array(2));
  });
});
