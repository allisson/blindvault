import {
  Keyring,
  KdfWorkerError,
  MEMLIMIT,
  deriveDeviceKek,
  initCrypto,
  type KdfPort,
  type KdfRequest,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { SharedKdf, type KdfWorker, onlyUrl } from './kdf';

describe('Trusted Types policy of the Argon2id worker (D83)', () => {
  it('turns only the worker URL into a script URL', () => {
    const rule = onlyUrl('/assets/kdf.worker-abc.js');
    expect(rule('/assets/kdf.worker-abc.js')).toBe('/assets/kdf.worker-abc.js');
    expect(() => rule('/assets/other.js')).toThrow('not the Argon2id worker');
    expect(() => rule('https://outside.test/assets/kdf.worker-abc.js')).toThrow();
    expect(() => rule('data:text/javascript,1')).toThrow();
  });
});

/** A worker the test answers by hand: it records what it was sent, in order. */
class FakeWorker implements KdfWorker {
  onmessage: ((event: { readonly data: unknown }) => void) | null = null;
  onerror: (() => void) | null = null;
  readonly received: unknown[] = [];

  postMessage(message: unknown): void {
    this.received.push(message);
  }

  answer(data: unknown): void {
    this.onmessage?.({ data });
  }
}

const PARAMS = { opslimit: 2, memlimit: MEMLIMIT };

function key(byte: number): Uint8Array {
  return new Uint8Array(32).fill(byte);
}

function request(byte: number): KdfRequest {
  return {
    op: 'derive',
    password: new Uint8Array(8).fill(byte),
    salt: new Uint8Array(16),
    params: PARAMS,
  };
}

/** Sends `message` on `port` and collects what comes back. */
function send(port: KdfPort, message: KdfRequest) {
  const answers: unknown[] = [];
  let failed = false;
  port.onmessage = ({ data }) => answers.push(data);
  port.onerror = () => {
    failed = true;
  };
  port.postMessage(message, []);
  return { answers, failed: () => failed };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('the one Argon2id worker of the window (D142, D191)', () => {
  beforeAll(async () => {
    await initCrypto();
  });

  it('is ready once the worker answers, which proves its code loaded', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    let ready = false;
    void kdf.ready().then(() => {
      ready = true;
    });
    await settle();
    expect(worker.received).toEqual([null]);
    expect(ready).toBe(false);
    worker.answer({ ok: false });
    await settle();
    expect(ready).toBe(true);
  });

  it('is not ready when the worker fails to load', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    const ready = kdf.ready();
    await settle();
    worker.onerror?.();
    await expect(ready).rejects.toThrow('Argon2id worker');
  });

  it('serves one request at a time, in order, from the same worker', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    const first = send(kdf.port(), request(1));
    const second = send(kdf.port(), request(2));
    await settle();
    expect(worker.received).toHaveLength(1);
    worker.answer({ ok: true, key: key(1), params: PARAMS });
    await settle();
    expect(first.answers).toHaveLength(1);
    expect(worker.received).toHaveLength(2);
    expect((worker.received[1] as KdfRequest).password[0]).toBe(2);
    worker.answer({ ok: true, key: key(2), params: PARAMS });
    await settle();
    expect(second.answers).toEqual([{ ok: true, key: key(2), params: PARAMS }]);
  });

  it('zeroes and drops the key of a request released before its answer, as a lock does', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    const port = kdf.port();
    const sent = send(port, request(1));
    await settle();
    port.terminate();
    const late = key(7);
    worker.answer({ ok: true, key: late, params: PARAMS });
    expect(late.every((b) => b === 0)).toBe(true);
    expect(sent.answers).toEqual([]);
    // The worker goes on serving the next request.
    const next = send(kdf.port(), request(2));
    await settle();
    worker.answer({ ok: true, key: key(2), params: PARAMS });
    await settle();
    expect(next.answers).toHaveLength(1);
  });

  it('never sends a request released before its turn, and zeroes its password', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    send(kdf.port(), request(1));
    const waiting = kdf.port();
    const message = request(2);
    send(waiting, message);
    waiting.terminate();
    await settle();
    worker.answer({ ok: true, key: key(1), params: PARAMS });
    await settle();
    expect(worker.received).toHaveLength(1);
    expect(message.password.every((b) => b === 0)).toBe(true);
  });

  it('fails the current request and every later one once the worker fails, without a new worker', async () => {
    const worker = new FakeWorker();
    const kdf = new SharedKdf(worker);
    const current = send(kdf.port(), request(1));
    await settle();
    worker.onerror?.();
    expect(current.failed()).toBe(true);
    const message = request(2);
    const later = send(kdf.port(), message);
    await settle();
    expect(later.failed()).toBe(true);
    expect(worker.received).toHaveLength(1);
    expect(message.password.every((b) => b === 0)).toBe(true);
    // An answer after the failure reaches no one.
    const stray = key(9);
    worker.answer({ ok: true, key: stray, params: PARAMS });
    expect(stray.every((b) => b === 0)).toBe(true);
  });

  it('speaks the protocol of deriveDeviceKek, twice on the same worker', async () => {
    const worker = new FakeWorker();
    worker.postMessage = (message: unknown) => {
      worker.received.push(message);
      const m = message as Extract<KdfRequest, { op: 'derive' }>;
      const derived = key(m.password[0] ?? 0);
      m.password.fill(0);
      queueMicrotask(() => {
        worker.answer({ ok: true, key: derived, params: m.params });
      });
    };
    const kdf = new SharedKdf(worker);
    const keyring = new Keyring();
    for (const byte of [3, 4]) {
      const kek = await deriveDeviceKek(
        keyring,
        kdf.port(),
        new Uint8Array(8).fill(byte),
        new Uint8Array(16),
        PARAMS,
      );
      expect(kek).toBeDefined();
    }
    expect(worker.received).toHaveLength(2);
    // A worker that refuses still fails the request as before.
    worker.postMessage = () => {
      queueMicrotask(() => {
        worker.answer({ ok: false });
      });
    };
    await expect(
      deriveDeviceKek(keyring, kdf.port(), new Uint8Array(8), new Uint8Array(16), PARAMS),
    ).rejects.toBeInstanceOf(KdfWorkerError);
    keyring.wipeAll();
  });
});
