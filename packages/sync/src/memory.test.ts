import { describe, expect, it } from 'vitest';

import { memoryPair } from './memory';
import { MAX_MESSAGE_LENGTH, MessageTooLongError, TransportClosedError } from './transport';

const bytes = (...values: number[]) => Uint8Array.from(values);
const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

async function closedBy(promise: Promise<unknown>): Promise<string> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof TransportClosedError) return error.by;
    throw error;
  }
  throw new Error('expected the transport to be closed');
}

describe('memory transport', () => {
  it('delivers messages in order, in both directions', async () => {
    const { a, b } = memoryPair();
    await a.send(bytes(1));
    await a.send(bytes(2, 2));
    await b.send(bytes(3));
    expect(await b.receive()).toEqual(bytes(1));
    expect(await b.receive()).toEqual(bytes(2, 2));
    expect(await a.receive()).toEqual(bytes(3));
  });

  it('waits for a message sent later', async () => {
    const { a, b } = memoryPair();
    const next = b.receive();
    await tick();
    await a.send(bytes(7));
    expect(await next).toEqual(bytes(7));
  });

  it('delivers a copy, so the sender can reuse its buffer', async () => {
    const { a, b } = memoryPair();
    const message = bytes(1, 2, 3);
    await a.send(message);
    message.fill(0);
    expect(await b.receive()).toEqual(bytes(1, 2, 3));
  });

  it('sends a message of the maximum length, and refuses a longer one', async () => {
    const { a, b } = memoryPair();
    await a.send(new Uint8Array(MAX_MESSAGE_LENGTH));
    expect(await b.receive()).toHaveLength(MAX_MESSAGE_LENGTH);
    await expect(a.send(new Uint8Array(MAX_MESSAGE_LENGTH + 1))).rejects.toBeInstanceOf(
      MessageTooLongError,
    );
    // The refused message was not delivered, and the transport stays open.
    await a.send(bytes(9));
    expect(await b.receive()).toEqual(bytes(9));
  });

  it('closes with an error on receiving a message longer than the maximum', async () => {
    const { a, b } = memoryPair({
      intercept: (direction, message) =>
        direction === 'a-to-b' && message[0] === 0xff
          ? [new Uint8Array(MAX_MESSAGE_LENGTH + 1)]
          : [message],
    });
    await a.send(bytes(1));
    await a.send(bytes(0xff));
    expect(await b.receive()).toEqual(bytes(1));
    expect(await closedBy(b.receive())).toBe('error');
    expect(await b.closed).toBe('error');
    expect(await a.closed).toBe('remote');
  });

  describe('intercept, for adversarial tests', () => {
    it('tampers with, drops and duplicates messages', async () => {
      const { a, b } = memoryPair({
        intercept: (_direction, message) => {
          if (message[0] === 1) return [bytes(1, 0xee)];
          if (message[0] === 2) return [];
          if (message[0] === 3) return [message, message];
          return [message];
        },
      });
      await a.send(bytes(1, 1));
      await a.send(bytes(2));
      await a.send(bytes(3));
      await a.send(bytes(4));
      expect(await b.receive()).toEqual(bytes(1, 0xee));
      expect(await b.receive()).toEqual(bytes(3));
      expect(await b.receive()).toEqual(bytes(3));
      expect(await b.receive()).toEqual(bytes(4));
    });

    it('reorders and injects messages, and tells the directions apart', async () => {
      const held: Uint8Array[] = [];
      const { a, b } = memoryPair({
        intercept: (direction, message) => {
          if (direction === 'b-to-a') return [bytes(0xaa), message];
          if (message[0] === 1) {
            held.push(message);
            return [];
          }
          return [message, ...held.splice(0)];
        },
      });
      await a.send(bytes(1));
      await a.send(bytes(2));
      await b.send(bytes(5));
      expect(await b.receive()).toEqual(bytes(2));
      expect(await b.receive()).toEqual(bytes(1));
      expect(await a.receive()).toEqual(bytes(0xaa));
      expect(await a.receive()).toEqual(bytes(5));
    });
  });

  describe('close', () => {
    it('lets the peer read what was sent before, then reports a remote close', async () => {
      const { a, b } = memoryPair();
      await a.send(bytes(1));
      await a.send(bytes(2));
      a.close();
      expect(await b.receive()).toEqual(bytes(1));
      expect(await b.receive()).toEqual(bytes(2));
      expect(await closedBy(b.receive())).toBe('remote');
      expect(await b.closed).toBe('remote');
    });

    it('rejects a pending receive on both sides', async () => {
      const { a, b } = memoryPair();
      const local = a.receive();
      const remote = b.receive();
      a.close();
      expect(await closedBy(local)).toBe('local');
      expect(await closedBy(remote)).toBe('remote');
    });

    it('refuses to send after a close, on either side', async () => {
      const { a, b } = memoryPair();
      a.close();
      expect(await closedBy(a.send(bytes(1)))).toBe('local');
      await tick();
      expect(await closedBy(b.send(bytes(1)))).toBe('remote');
    });

    it('drops a message that arrives after a local close', async () => {
      const { a, b } = memoryPair();
      // Not awaited: the message is still in flight when b closes.
      const sent = a.send(bytes(1));
      b.close();
      await sent;
      await tick();
      expect(await closedBy(b.receive())).toBe('local');
    });

    it('discards what a closed side had not read yet', async () => {
      const { a, b } = memoryPair();
      await a.send(bytes(1));
      await tick();
      b.close();
      expect(await closedBy(b.receive())).toBe('local');
    });

    it('is idempotent, and keeps the first cause', async () => {
      const { a, b } = memoryPair();
      a.close();
      a.close();
      await tick();
      b.close();
      expect(await a.closed).toBe('local');
      expect(await b.closed).toBe('remote');
    });

    it('closes both sides with an error when the link breaks', async () => {
      const { a, b, breakLink } = memoryPair();
      const pending = b.receive();
      breakLink();
      expect(await closedBy(pending)).toBe('error');
      expect(await a.closed).toBe('error');
      expect(await closedBy(a.send(bytes(1)))).toBe('error');
    });
  });
});
