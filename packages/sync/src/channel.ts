// The Noise channel of `pairing-protocol.md` §10.1: after the handshake, every transport message
// is one Noise transport message. The channel is itself a `Transport`, so the protocol above it
// reads and writes plaintext messages. A message that fails decryption, which includes a tampered,
// duplicated, dropped, injected or reordered one (the Noise nonces), closes the channel with an
// error; any close wipes both keys (CRYPTO-INV-010).

import type { NoiseTransport } from '@blindvault/crypto';

import {
  type ClosedBy,
  Inbox,
  MAX_MESSAGE_LENGTH,
  MessageTooLongError,
  type Transport,
  TransportClosedError,
} from './transport';

/** The longest plaintext of one channel message: 65,535 bytes less the 16-byte tag. */
export const MAX_CHANNEL_MESSAGE_LENGTH = MAX_MESSAGE_LENGTH - 16;

/**
 * Wraps `transport` with the keys of a finished handshake. The channel decrypts each message as it
 * arrives, so the messages that arrived before a remote close stay readable after the keys are
 * wiped.
 */
export function noiseChannel(transport: Transport, cipher: NoiseTransport): Transport {
  const inbox = new Inbox();

  const finish = (by: ClosedBy): void => {
    inbox.close(by);
    cipher.wipe();
    transport.close();
  };

  void (async () => {
    for (;;) {
      let message: Uint8Array;
      try {
        message = await transport.receive();
      } catch (error) {
        finish(error instanceof TransportClosedError ? error.by : 'error');
        return;
      }
      if (inbox.state) return;
      let plaintext: Uint8Array;
      try {
        plaintext = cipher.decrypt(message);
      } catch {
        finish('error');
        return;
      }
      inbox.push(plaintext);
    }
  })();

  return {
    async send(message: Uint8Array): Promise<void> {
      if (message.length > MAX_CHANNEL_MESSAGE_LENGTH) throw new MessageTooLongError();
      if (inbox.state) throw new TransportClosedError(inbox.state);
      await transport.send(cipher.encrypt(message));
    },
    receive: () => inbox.receive(),
    close: () => {
      finish('local');
    },
    closed: inbox.closed,
  };
}
