import {
  Keyring,
  type NoiseTransport,
  generateDeviceIdentity,
  initCrypto,
  startNoiseXX,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { MAX_CHANNEL_MESSAGE_LENGTH, noiseChannel } from './channel';
import { type MemoryPairOptions, memoryPair } from './memory';
import {
  type ClosedBy,
  MessageTooLongError,
  type Transport,
  TransportClosedError,
} from './transport';

beforeAll(initCrypto);

const bytes = (...values: number[]) => Uint8Array.from(values);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

/** Two NoiseTransports from a real Noise_XX handshake. */
function ciphers(): { a: NoiseTransport; b: NoiseTransport } {
  const keyring = new Keyring();
  const prologue = new Uint8Array(8);
  const i = startNoiseXX({ initiator: true, prologue, identity: generateDeviceIdentity(keyring) });
  const r = startNoiseXX({ initiator: false, prologue, identity: generateDeviceIdentity(keyring) });
  r.readMessage(i.writeMessage());
  i.readMessage(r.writeMessage());
  r.readMessage(i.writeMessage());
  if (!i.result || !r.result) throw new Error('handshake not finished');
  return { a: i.result.transport, b: r.result.transport };
}

function channels(options: MemoryPairOptions = {}) {
  const link = memoryPair(options);
  const keys = ciphers();
  return {
    ...link,
    keys,
    a: noiseChannel(link.a, keys.a),
    b: noiseChannel(link.b, keys.b),
  };
}

async function closedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TransportClosedError) return error.by;
    throw error;
  }
  throw new Error('expected the channel to be closed');
}

describe('Noise channel', () => {
  it('carries messages both ways, in order, encrypted on the link', async () => {
    const seen: Uint8Array[] = [];
    const { a, b } = channels({
      intercept: (_d, m) => {
        seen.push(m);
        return [m];
      },
    });
    await a.send(bytes(1, 2, 3));
    await a.send(bytes(4));
    await b.send(bytes(5));
    expect(await b.receive()).toEqual(bytes(1, 2, 3));
    expect(await b.receive()).toEqual(bytes(4));
    expect(await a.receive()).toEqual(bytes(5));
    expect(seen.map((m) => m.length)).toEqual([19, 17, 17]);
    expect(seen[0]?.subarray(0, 3)).not.toEqual(bytes(1, 2, 3));
  });

  it('sends 65,519 bytes and refuses one more without closing', async () => {
    const { a, b } = channels();
    const max = new Uint8Array(MAX_CHANNEL_MESSAGE_LENGTH).fill(7);
    await a.send(max);
    expect(await b.receive()).toEqual(max);
    await expect(a.send(new Uint8Array(MAX_CHANNEL_MESSAGE_LENGTH + 1))).rejects.toBeInstanceOf(
      MessageTooLongError,
    );
    await a.send(bytes(1));
    expect(await b.receive()).toEqual(bytes(1));
  });

  it.each(['tamper', 'duplicate', 'drop', 'inject'] as const)(
    'closes with an error on a %sd message, and wipes its keys',
    async (attack) => {
      let count = 0;
      const { a, b, keys } = channels({
        intercept: (direction, m) => {
          if (direction !== 'a-to-b') return [m];
          count += 1;
          if (count !== 2) return [m];
          if (attack === 'tamper') return [Uint8Array.from(m, (x, i) => (i === 0 ? x ^ 1 : x))];
          if (attack === 'duplicate') return [m, m];
          if (attack === 'drop') return [];
          return [new Uint8Array(m.length), m];
        },
      });
      await a.send(bytes(1));
      await a.send(bytes(2));
      await a.send(bytes(3));
      expect(await b.receive()).toEqual(bytes(1));
      if (attack === 'duplicate') expect(await b.receive()).toEqual(bytes(2));
      expect(await closedBy(b.receive())).toBe('error');
      expect(await b.closed).toBe('error');
      expect(keys.b.wiped).toBe(true);
      expect(await closedBy(b.send(bytes(9)))).toBe('error');
      expect(await a.closed).toBe('remote');
    },
  );

  it('reads what arrived before a remote close, then reports it and wipes its keys', async () => {
    const { a, b, keys } = channels();
    await a.send(bytes(1));
    await a.send(bytes(2));
    a.close();
    expect(keys.a.wiped).toBe(true);
    expect(await b.receive()).toEqual(bytes(1));
    expect(await b.receive()).toEqual(bytes(2));
    expect(await closedBy(b.receive())).toBe('remote');
    expect(keys.b.wiped).toBe(true);
    expect(await a.closed).toBe('local');
  });

  it('rejects a pending receive and later sends on a local close', async () => {
    const { a, keys } = channels();
    const pending = a.receive();
    a.close();
    a.close();
    expect(await closedBy(pending)).toBe('local');
    expect(await closedBy(a.send(bytes(1)))).toBe('local');
    expect(keys.a.wiped).toBe(true);
  });

  it('closes with an error and wipes both sides when the link breaks', async () => {
    const { a, b, keys, breakLink } = channels();
    breakLink();
    expect(await a.closed).toBe('error');
    expect(await b.closed).toBe('error');
    expect(keys.a.wiped && keys.b.wiped).toBe(true);
  });

  it('reports the close of a link closed under it', async () => {
    const link = memoryPair();
    const keys = ciphers();
    const a = noiseChannel(link.a, keys.a);
    link.a.close();
    expect(await a.closed).toBe('local');
    await tick();
    expect(keys.a.wiped).toBe(true);
  });

  describe('over a transport that misbehaves', () => {
    /** A transport whose next receive the test settles by hand. */
    function manual() {
      let settle: { resolve: (m: Uint8Array) => void; reject: (e: unknown) => void } | undefined;
      let onClosed: (by: ClosedBy) => void = () => undefined;
      const transport: Transport = {
        send: () => Promise.resolve(),
        receive: () =>
          new Promise<Uint8Array>((resolve, reject) => {
            settle = { resolve, reject };
          }),
        close: () => {
          onClosed('local');
        },
        closed: new Promise<ClosedBy>((resolve) => {
          onClosed = resolve;
        }),
      };
      return { transport, settle: () => settle };
    }

    it('closes with an error when receive fails with anything but a close', async () => {
      const { transport, settle } = manual();
      const keys = ciphers();
      const channel = noiseChannel(transport, keys.a);
      await tick();
      settle()?.reject(new Error('broken'));
      expect(await channel.closed).toBe('error');
      expect(keys.a.wiped).toBe(true);
    });

    it('drops a message that arrives after a local close', async () => {
      const { transport, settle } = manual();
      const keys = ciphers();
      const channel = noiseChannel(transport, keys.a);
      await tick();
      channel.close();
      settle()?.resolve(keys.b.encrypt(bytes(1)));
      await tick();
      expect(await closedBy(channel.receive())).toBe('local');
    });
  });
});
