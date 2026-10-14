import { describe, expect, expectTypeOf, it } from 'vitest';

import { MAX_MESSAGE_LENGTH, MessageTooLongError, TransportClosedError } from './transport';
import {
  type DataChannelEvent,
  type DataChannelLike,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  dataChannelTransport,
} from './webrtc';

type Listener = (event: DataChannelEvent) => void;

/** An RTCDataChannel stand-in: Node has no WebRTC. */
class FakeChannel implements DataChannelLike {
  readyState: RTCDataChannelState = 'open';
  binaryType: BinaryType = 'blob';
  bufferedAmount = 0;
  bufferedAmountLowThreshold = 0;
  readonly sent: Uint8Array[] = [];
  closeCalls = 0;
  failSend = false;
  private readonly listeners = new Map<string, Set<Listener>>();

  send(data: ArrayBuffer | ArrayBufferView<ArrayBuffer>): void {
    if (this.failSend) throw new Error('InvalidStateError');
    const view =
      data instanceof ArrayBuffer
        ? new Uint8Array(data)
        : new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    this.sent.push(view.slice());
  }

  close(): void {
    this.closeCalls += 1;
    this.readyState = 'closed';
  }

  addEventListener(type: string, listener: Listener): void {
    let set = this.listeners.get(type);
    if (!set) this.listeners.set(type, (set = new Set()));
    set.add(listener);
  }

  removeEventListener(type: string, listener: Listener): void {
    this.listeners.get(type)?.delete(listener);
  }

  emit(type: string, event: DataChannelEvent = {}): void {
    for (const listener of [...(this.listeners.get(type) ?? [])]) listener(event);
  }

  deliver(...values: number[]): void {
    this.emit('message', { data: Uint8Array.from(values).buffer });
  }

  listenerCount(): number {
    return [...this.listeners.values()].reduce((n, set) => n + set.size, 0);
  }
}

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

describe('DataChannel transport', () => {
  it("accepts the browser's RTCDataChannel (checked by tsc)", () => {
    expectTypeOf<RTCDataChannel>().toExtend<DataChannelLike>();
  });

  it('needs an open channel, and receives binary data as ArrayBuffer', () => {
    const connecting = new FakeChannel();
    connecting.readyState = 'connecting';
    expect(() => dataChannelTransport(connecting)).toThrow(TransportClosedError);
    const channel = new FakeChannel();
    dataChannelTransport(channel);
    expect(channel.binaryType).toBe('arraybuffer');
    expect(channel.bufferedAmountLowThreshold).toBe(LOW_WATER_MARK);
  });

  it('sends and receives messages in order', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    await transport.send(bytes(1, 2));
    await transport.send(bytes(3));
    expect(channel.sent).toEqual([bytes(1, 2), bytes(3)]);
    const pending = transport.receive();
    channel.deliver(4);
    channel.deliver(5, 5);
    expect(await pending).toEqual(bytes(4));
    expect(await transport.receive()).toEqual(bytes(5, 5));
  });

  it('sends a message of the maximum length, and refuses a longer one without sending it', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    await transport.send(new Uint8Array(MAX_MESSAGE_LENGTH));
    await expect(transport.send(new Uint8Array(MAX_MESSAGE_LENGTH + 1))).rejects.toBeInstanceOf(
      MessageTooLongError,
    );
    expect(channel.sent).toHaveLength(1);
    await transport.send(bytes(1));
    expect(channel.sent).toHaveLength(2);
  });

  it('closes with an error on receiving a message longer than the maximum', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    channel.deliver(1);
    channel.emit('message', { data: new ArrayBuffer(MAX_MESSAGE_LENGTH + 1) });
    channel.deliver(2);
    expect(await transport.receive()).toEqual(bytes(1));
    expect(await closedBy(transport.receive())).toBe('error');
    expect(channel.closeCalls).toBe(1);
  });

  it('closes with an error on receiving text or any other non-binary data', async () => {
    for (const data of ['text', new Blob([bytes(1)]), undefined]) {
      const channel = new FakeChannel();
      const transport = dataChannelTransport(channel);
      channel.emit('message', { data });
      expect(await closedBy(transport.receive())).toBe('error');
      expect(channel.closeCalls).toBe(1);
    }
  });

  it('waits while the send buffer is above the high-water mark, keeping the order', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    channel.bufferedAmount = HIGH_WATER_MARK + 1;
    const first = transport.send(bytes(1));
    const second = transport.send(bytes(2));
    await tick();
    expect(channel.sent).toEqual([]);
    channel.bufferedAmount = LOW_WATER_MARK;
    channel.emit('bufferedamountlow');
    await first;
    await second;
    expect(channel.sent).toEqual([bytes(1), bytes(2)]);
  });

  it('sends at once at the high-water mark', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    channel.bufferedAmount = HIGH_WATER_MARK;
    await transport.send(bytes(1));
    expect(channel.sent).toEqual([bytes(1)]);
  });

  it('rejects a send waiting on the buffer when the transport closes', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    channel.bufferedAmount = HIGH_WATER_MARK + 1;
    const waiting = transport.send(bytes(1));
    transport.close();
    expect(await closedBy(waiting)).toBe('local');
    expect(channel.sent).toEqual([]);
  });

  it('closes with an error when the channel refuses a send', async () => {
    const channel = new FakeChannel();
    const transport = dataChannelTransport(channel);
    channel.failSend = true;
    expect(await closedBy(transport.send(bytes(1)))).toBe('error');
    expect(await transport.closed).toBe('error');
  });

  describe('close', () => {
    it('reads what arrived before a remote close, then reports it', async () => {
      const channel = new FakeChannel();
      const transport = dataChannelTransport(channel);
      channel.deliver(1);
      channel.readyState = 'closed';
      channel.emit('close');
      expect(await transport.receive()).toEqual(bytes(1));
      expect(await closedBy(transport.receive())).toBe('remote');
      expect(await closedBy(transport.send(bytes(2)))).toBe('remote');
      expect(channel.closeCalls).toBe(0);
    });

    it('reports a channel error, and closes the channel', async () => {
      const channel = new FakeChannel();
      const transport = dataChannelTransport(channel);
      const pending = transport.receive();
      channel.emit('error');
      expect(await closedBy(pending)).toBe('error');
      expect(channel.closeCalls).toBe(1);
    });

    it('closes the channel on a local close, once, and stops listening', async () => {
      const channel = new FakeChannel();
      const transport = dataChannelTransport(channel);
      expect(channel.listenerCount()).toBeGreaterThan(0);
      const pending = transport.receive();
      transport.close();
      transport.close();
      expect(await closedBy(pending)).toBe('local');
      expect(await closedBy(transport.send(bytes(1)))).toBe('local');
      expect(channel.closeCalls).toBe(1);
      expect(channel.listenerCount()).toBe(0);
      // Events after the close change nothing.
      channel.deliver(1);
      channel.emit('error');
      expect(await transport.closed).toBe('local');
    });
  });
});
