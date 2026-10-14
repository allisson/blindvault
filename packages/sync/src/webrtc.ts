// The transport over an open WebRTC DataChannel (`pairing-protocol.md` §4): reliable and ordered,
// binary messages only. Opening the connection, from the payloads and the rebuilt SDP, is not done
// here. DTLS is transport only and is never trusted (§8.2).

import {
  Inbox,
  MAX_MESSAGE_LENGTH,
  MessageTooLongError,
  type Transport,
  TransportClosedError,
} from './transport';

/** Above this many buffered bytes, `send` waits for the channel to drain. */
export const HIGH_WATER_MARK = 1_048_576;
/** The channel's `bufferedAmountLowThreshold`: `send` resumes once the buffer is down to it. */
export const LOW_WATER_MARK = 262_144;

export interface DataChannelEvent {
  readonly data?: unknown;
}

/** The part of `RTCDataChannel` the transport uses, so tests can stand in for it. */
export interface DataChannelLike {
  readonly readyState: RTCDataChannelState;
  binaryType: BinaryType;
  readonly bufferedAmount: number;
  bufferedAmountLowThreshold: number;
  send(data: ArrayBufferView<ArrayBuffer>): void;
  close(): void;
  addEventListener(type: string, listener: (event: DataChannelEvent) => void): void;
  removeEventListener(type: string, listener: (event: DataChannelEvent) => void): void;
}

const EVENTS = ['message', 'close', 'error', 'bufferedamountlow'] as const;

/** Wraps an open DataChannel. Throws `TransportClosedError` when the channel is not open. */
export function dataChannelTransport(channel: DataChannelLike): Transport {
  if (channel.readyState !== 'open') throw new TransportClosedError('error');
  channel.binaryType = 'arraybuffer';
  channel.bufferedAmountLowThreshold = LOW_WATER_MARK;

  const inbox = new Inbox();
  // Sends waiting for the buffer to drain, in order.
  let drained: (() => void)[] = [];
  let queue: Promise<void> = Promise.resolve();

  const shut = (by: 'local' | 'remote' | 'error') => {
    if (!inbox.close(by)) return;
    for (const type of EVENTS) channel.removeEventListener(type, listeners[type]);
    for (const wake of drained.splice(0)) wake();
    if (by !== 'remote') channel.close();
  };

  const listeners: Record<(typeof EVENTS)[number], (event: DataChannelEvent) => void> = {
    message(event) {
      if (!(event.data instanceof ArrayBuffer) || event.data.byteLength > MAX_MESSAGE_LENGTH) {
        shut('error');
        return;
      }
      inbox.push(new Uint8Array(event.data));
    },
    close() {
      shut('remote');
    },
    error() {
      shut('error');
    },
    bufferedamountlow() {
      const wake = drained;
      drained = [];
      for (const each of wake) each();
    },
  };
  for (const type of EVENTS) channel.addEventListener(type, listeners[type]);

  const sendNow = async (message: Uint8Array<ArrayBuffer>) => {
    while (!inbox.state && channel.bufferedAmount > HIGH_WATER_MARK) {
      await new Promise<void>((resolve) => drained.push(resolve));
    }
    const by = inbox.state;
    if (by) throw new TransportClosedError(by);
    try {
      channel.send(message);
    } catch {
      shut('error');
      throw new TransportClosedError('error');
    }
  };

  return {
    send(message) {
      const by = inbox.state;
      if (by) return Promise.reject(new TransportClosedError(by));
      if (message.length > MAX_MESSAGE_LENGTH) return Promise.reject(new MessageTooLongError());
      const copy = message.slice();
      const sent = queue.then(() => sendNow(copy));
      queue = sent.catch(() => undefined);
      return sent;
    },
    receive: () => inbox.receive(),
    close() {
      shut('local');
    },
    closed: inbox.closed,
  };
}
