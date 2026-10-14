// An in-memory transport pair, so the pairing and sync protocols are tested without WebRTC
// (overview §2). `intercept` puts a man in the middle of every message, for the tests of Gate C:
// tampered, dropped, duplicated, reordered, replayed and injected messages.

import {
  Inbox,
  MAX_MESSAGE_LENGTH,
  MessageTooLongError,
  type Transport,
  TransportClosedError,
} from './transport';

export type Direction = 'a-to-b' | 'b-to-a';

export interface MemoryPairOptions {
  /**
   * Sees every message sent and returns the messages to deliver in its place, in order: the same
   * message, a changed one, none, several, or messages held back from earlier calls.
   */
  readonly intercept?: (direction: Direction, message: Uint8Array) => readonly Uint8Array[];
}

export interface MemoryPair {
  readonly a: Transport;
  readonly b: Transport;
  /** Fails the link: both sides close with an error. */
  readonly breakLink: () => void;
}

interface Side {
  readonly inbox: Inbox;
  readonly peer: Inbox;
}

export function memoryPair(options: MemoryPairOptions = {}): MemoryPair {
  const inboxA = new Inbox();
  const inboxB = new Inbox();
  const a: Side = { inbox: inboxA, peer: inboxB };
  const b: Side = { inbox: inboxB, peer: inboxA };

  // Delivery is asynchronous, as on a network, and keeps the order of sends and closes.
  const later = (task: () => void) => {
    queueMicrotask(task);
  };

  const shut = (side: Side, by: 'local' | 'error') => {
    if (!side.inbox.close(by)) return;
    // The peer sees the close as remote, whichever reason this side had; only `breakLink` fails
    // both sides with an error.
    later(() => side.peer.close('remote'));
  };

  const receiveInto = (side: Side, message: Uint8Array) => {
    if (message.length > MAX_MESSAGE_LENGTH) shut(side, 'error');
    else side.inbox.push(message);
  };
  const receiver = (side: Side): Side => (side === a ? b : a);

  const transport = (side: Side, direction: Direction): Transport => ({
    send(message) {
      const by = side.inbox.state;
      if (by) return Promise.reject(new TransportClosedError(by));
      if (message.length > MAX_MESSAGE_LENGTH) return Promise.reject(new MessageTooLongError());
      const copy = message.slice();
      later(() => {
        const delivered = options.intercept ? options.intercept(direction, copy) : [copy];
        for (const each of delivered) receiveInto(receiver(side), each.slice());
      });
      return Promise.resolve();
    },
    receive: () => side.inbox.receive(),
    close() {
      shut(side, 'local');
    },
    closed: side.inbox.closed,
  });

  return {
    a: transport(a, 'a-to-b'),
    b: transport(b, 'b-to-a'),
    breakLink: () => {
      a.inbox.close('error');
      b.inbox.close('error');
    },
  };
}
