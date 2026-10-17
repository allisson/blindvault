// The pairing messages of `pairing-protocol.md` §10.2, under the strict codec shared with the sync
// messages (`message-codec.ts`). `records-begin`, `record` and `records-end` are those of the full
// transfer (`sync-protocol.md` §2.1).

import { type CborValue } from '@blindvault/crypto';

import {
  type Field,
  type MessageCodec,
  boolField,
  bytesField,
  countField,
  decodeWith,
  encodeWith,
  envelopeField,
  textField,
} from './message-codec';

export {
  MAX_RECORD_COUNT,
  MESSAGE_VERSION,
  MessageError,
  type MessageRejection,
} from './message-codec';

/** The reasons of §10.3, in its order. */
export const ABORT_REASONS = [
  'cancelled',
  'sas-mismatch',
  'locked',
  'expired',
  'retired-peer',
  'different-vaults',
  'unsupported-format',
  'verification-failed',
  'version',
  'protocol-error',
] as const;

export type AbortReason = (typeof ABORT_REASONS)[number];

export type Message =
  | { readonly t: 'nonce'; readonly n: Uint8Array }
  | { readonly t: 'confirmed' }
  | { readonly t: 'master-key'; readonly mk: Uint8Array; readonly vid: Uint8Array }
  | { readonly t: 'received'; readonly name: string }
  | { readonly t: 'key-confirmation'; readonly mac: Uint8Array }
  | { readonly t: 'devices'; readonly own: boolean; readonly peer: boolean; readonly name: string }
  | { readonly t: 'records-begin'; readonly count: number }
  | { readonly t: 'record'; readonly r: Uint8Array }
  | { readonly t: 'records-end' }
  | { readonly t: 'committed' }
  | { readonly t: 'abort'; readonly reason: AbortReason };

export type MessageType = Message['t'];

const NAME_MAX = 64;

/** A display name: single-line, trimmed, 1 to 64 code points (`record-content.md` §1, §7). */
const nameField: Field = {
  fits: (value: CborValue | undefined) =>
    typeof value === 'string' &&
    value.length > 0 &&
    !/[\n\r]/.test(value) &&
    !/^\p{White_Space}|\p{White_Space}$/u.test(value) &&
    Array.from(value).length <= NAME_MAX,
};

const PAIRING: MessageCodec<Message> = {
  schema: {
    nonce: { n: bytesField(32) },
    confirmed: {},
    'master-key': { mk: bytesField(32), vid: bytesField(16) },
    received: { name: nameField },
    'key-confirmation': { mac: bytesField(32) },
    devices: { own: boolField, peer: boolField, name: nameField },
    'records-begin': { count: countField },
    record: { r: envelopeField },
    'records-end': {},
    committed: {},
    abort: { reason: textField },
  },
  abortReasons: ABORT_REASONS,
};

/** Encodes a message, refusing one that decoding would reject. */
export function encodeMessage(message: Message): Uint8Array {
  return encodeWith(PAIRING, message);
}

/**
 * Decodes a message under the rules of §10.2. Throws `MessageError`. Its byte strings are copies:
 * `bytes` can be wiped once decoded.
 */
export function decodeMessage(bytes: Uint8Array): Message {
  return decodeWith(PAIRING, bytes);
}
