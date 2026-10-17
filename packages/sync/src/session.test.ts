import { afterEach, describe, expect, it, vi } from 'vitest';

import vectors from '../test-vectors/pairing-v1.json' with { type: 'json' };
import { toFrames } from './frames';
import { memoryPair } from './memory';
import { encodeMessage } from './messages';
import { IDLE_TIMEOUT_MS, PairingError, PairingSession, SESSION_TIMEOUT_MS } from './session';

const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const flush = async () => {
  for (let i = 0; i < 20; i++) await Promise.resolve();
};

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingError) return [error.reason, error.by];
    throw error;
  }
  throw new Error('expected the session to end');
}

function sessions(options: Parameters<typeof memoryPair>[0] = {}) {
  const link = memoryPair(options);
  return { link, a: new PairingSession(link.a), b: new PairingSession(link.b) };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('pairing session (pairing-protocol.md §10, §11)', () => {
  it('carries messages both ways, in order', async () => {
    const { a, b } = sessions();
    await a.send({ t: 'nonce', n: new Uint8Array(32).fill(7) });
    await a.send({ t: 'confirmed' });
    await b.send({ t: 'received', name: 'Firefox on Linux' });
    expect(await b.receive()).toEqual({ t: 'nonce', n: new Uint8Array(32).fill(7) });
    expect(await b.receive()).toEqual({ t: 'confirmed' });
    expect(await a.receive()).toEqual({ t: 'received', name: 'Firefox on Linux' });
  });

  it('sends abort with its reason, and both sides end with it', async () => {
    const { a, b, link } = sessions();
    const error = await a.abort('cancelled');
    expect([error.reason, error.by]).toEqual(['cancelled', 'local']);
    expect(await failure(b.receive())).toEqual(['cancelled', 'remote']);
    expect(await link.a.closed).toBe('local');
    // a closed the link first: b's side sees the close as remote.
    expect(await link.b.closed).toBe('remote');
    expect((await a.ended).reason).toBe('cancelled');
    expect(b.error?.reason).toBe('cancelled');
    // Every later call rejects with the same error, and no second abort is sent.
    expect(await failure(a.send({ t: 'confirmed' }))).toEqual(['cancelled', 'local']);
    expect(await failure(b.receive())).toEqual(['cancelled', 'remote']);
    expect(await b.abort('locked')).toBe(b.error);
    expect(await a.abort('locked')).toBe(error);
  });

  it('reads an unknown abort reason as protocol-error, and ends', async () => {
    const { b, link } = sessions();
    const unknown = vectors.messages.valid.find((c) => c.case.includes('unknown reason'));
    if (!unknown) throw new Error('no vector');
    await link.a.send(Uint8Array.of(1, ...hex(unknown.bytes)));
    expect(await failure(b.receive())).toEqual(['protocol-error', 'remote']);
  });

  it.each([
    ['a message that is not CBOR', Uint8Array.of(1, 0xff), 'protocol-error'],
    ['a frame with last 2', Uint8Array.of(2, 0xa0), 'protocol-error'],
    ['an empty frame', new Uint8Array(), 'protocol-error'],
    [
      'a message of another version',
      Uint8Array.of(
        1,
        0xa2,
        0x61,
        0x74,
        0x69,
        ...new TextEncoder().encode('confirmed'),
        0x61,
        0x76,
        0x02,
      ),
      'version',
    ],
  ] as const)('aborts on %s, telling the peer', async (_case, frame, reason) => {
    const { a, b, link } = sessions();
    await link.b.send(frame);
    expect(await failure(a.receive())).toEqual([reason, 'local']);
    expect(await failure(b.receive())).toEqual([reason, 'remote']);
  });

  it('ends as closed when the link closes or breaks with no abort', async () => {
    const closed = sessions();
    closed.link.b.close();
    expect(await failure(closed.a.receive())).toEqual(['closed', 'remote']);
    expect(await failure(closed.a.send({ t: 'confirmed' }))).toEqual(['closed', 'remote']);
    const broken = sessions();
    broken.link.breakLink();
    expect(await failure(broken.a.send({ t: 'confirmed' }))).toEqual(['closed', 'remote']);
    // The session ended on its own when the link broke; a later abort sends nothing.
    expect(await broken.b.ended).toMatchObject({ reason: 'closed', by: 'remote' });
    expect(await broken.b.abort('locked')).toBe(broken.b.error);
  });

  it('ends when the link closes while no one reads, keeping the abort reason', async () => {
    const closed = sessions();
    closed.link.b.close();
    expect(await closed.a.ended).toMatchObject({ reason: 'closed', by: 'remote' });
    const aborted = sessions();
    await aborted.b.abort('sas-mismatch');
    expect(await aborted.a.ended).toMatchObject({ reason: 'sas-mismatch', by: 'remote' });
  });

  it('keeps a message that arrived before the close for the next receive', async () => {
    const { a, b } = sessions();
    await b.send({ t: 'committed' });
    b.close();
    await b.ended;
    await flush();
    expect(await a.receive()).toEqual({ t: 'committed' });
    expect(await failure(a.receive())).toEqual(['closed', 'remote']);
  });

  it('ends with its own abort reason when the link broke just before', async () => {
    const { a, link } = sessions();
    link.breakLink();
    const error = await a.abort('locked');
    expect([error.reason, error.by]).toEqual(['locked', 'local']);
  });

  it('wipes the bytes and frames of every message it sent (D202)', async () => {
    const link = memoryPair();
    const sent: Uint8Array[] = [];
    const a = new PairingSession({
      ...link.a,
      send: (frame) => {
        sent.push(frame);
        return link.a.send(frame);
      },
    });
    const b = new PairingSession(link.b);
    const mk = new Uint8Array(32).fill(9);
    await a.send({ t: 'master-key', mk, vid: new Uint8Array(16).fill(3) });
    expect(sent).toHaveLength(1);
    expect(sent.every((frame) => frame.every((byte) => byte === 0))).toBe(true);
    // The caller's own buffer is the caller's to wipe; the peer gets the message whole.
    expect(mk.every((byte) => byte === 9)).toBe(true);
    expect(await b.receive()).toEqual({
      t: 'master-key',
      mk: new Uint8Array(32).fill(9),
      vid: new Uint8Array(16).fill(3),
    });
  });

  it('closes a finished session with no abort', async () => {
    const { a, b } = sessions();
    await a.send({ t: 'committed' });
    a.close();
    a.close();
    expect(await b.receive()).toEqual({ t: 'committed' });
    expect(await failure(b.receive())).toEqual(['closed', 'remote']);
    expect(await failure(a.receive())).toEqual(['closed', 'local']);
  });

  it('refuses to send a message the codec rejects, and stays open', async () => {
    const { a, b } = sessions();
    await expect(a.send({ t: 'received', name: '' })).rejects.toThrow(
      'message rejected (protocol-error)',
    );
    await a.send({ t: 'confirmed' });
    expect(await b.receive()).toEqual({ t: 'confirmed' });
  });

  describe('timeouts', () => {
    it('expires the session at expiresAt, unless both confirmed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const link = memoryPair();
      const a = new PairingSession(link.a, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      const b = new PairingSession(link.b);
      const pending = b.receive();
      vi.advanceTimersByTime(SESSION_TIMEOUT_MS - 1);
      await flush();
      expect(a.error).toBeNull();
      vi.advanceTimersByTime(1);
      await flush();
      expect(a.error?.reason).toBe('expired');
      expect(await failure(pending)).toEqual(['expired', 'remote']);

      const confirmed = memoryPair();
      const c = new PairingSession(confirmed.a, { expiresAt: Date.now() + SESSION_TIMEOUT_MS });
      c.bothConfirmed();
      vi.advanceTimersByTime(SESSION_TIMEOUT_MS * 2);
      await flush();
      expect(c.error).toBeNull();
    });

    it('expires at once when expiresAt has passed', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
      const link = memoryPair();
      const a = new PairingSession(link.a, { expiresAt: Date.now() - 1 });
      vi.advanceTimersByTime(0);
      await flush();
      expect(a.error?.reason).toBe('expired');
    });

    it('after both confirmations, aborts after 60 seconds without a frame', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { a, b } = sessions();
      a.bothConfirmed();
      const first = a.receive();
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      await b.send({ t: 'confirmed' });
      await flush();
      expect(await first).toEqual({ t: 'confirmed' });
      // The wait restarts with each frame.
      const second = a.receive();
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS - 1);
      await flush();
      expect(a.error).toBeNull();
      vi.advanceTimersByTime(1);
      await flush();
      expect(await failure(second)).toEqual(['expired', 'local']);
      expect(await failure(b.receive())).toEqual(['expired', 'remote']);
    });

    it('has no idle limit before both confirmations', async () => {
      vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
      const { a } = sessions();
      void a.receive().catch(() => undefined);
      vi.advanceTimersByTime(IDLE_TIMEOUT_MS * 5);
      await flush();
      expect(a.error).toBeNull();
    });
  });

  it('joins a message of several frames before decoding it', async () => {
    const { a, b, link } = sessions();
    // { name: 70,000 × "a", t: "received", v: 1 }: two frames, then refused for its long name.
    const name = new TextEncoder().encode('a'.repeat(70_000));
    const bytes = Uint8Array.of(
      0xa3,
      0x64,
      ...new TextEncoder().encode('name'),
      0x7a,
      0x00,
      0x01,
      0x11,
      0x70,
      ...name,
      0x61,
      0x74,
      0x68,
      ...new TextEncoder().encode('received'),
      0x61,
      0x76,
      0x01,
    );
    const frames = toFrames(bytes);
    expect(frames).toHaveLength(2);
    for (const frame of frames) await link.b.send(frame);
    expect(await failure(a.receive())).toEqual(['protocol-error', 'local']);
    expect(await failure(b.receive())).toEqual(['protocol-error', 'remote']);
  });

  it('frames each message as one channel message', async () => {
    const seen: number[] = [];
    const { a, b } = sessions({
      intercept: (_d, m) => {
        seen.push(m.length);
        return [m];
      },
    });
    await a.send({ t: 'devices', own: true, peer: false, name: 'Chrome on macOS' });
    expect(await b.receive()).toMatchObject({ t: 'devices' });
    expect(seen).toEqual([
      toFrames(encodeMessage({ t: 'devices', own: true, peer: false, name: 'Chrome on macOS' }))[0]
        ?.length,
    ]);
  });
});
