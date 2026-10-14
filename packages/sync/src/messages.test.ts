import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/pairing-v1.json' with { type: 'json' };
import {
  ABORT_REASONS,
  type Message,
  MessageError,
  decodeMessage,
  encodeMessage,
} from './messages';

const v = vectors.messages;
const hex = (s: string) => Uint8Array.from(s.match(/../g) ?? [], (b) => parseInt(b, 16));
const BYTE_KEYS = new Set(['n', 'mk', 'vid', 'mac']);

/** The message of a vector, without `v`, with its byte strings as bytes. */
function expected(json: Record<string, unknown>): Message {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(json)) {
    if (key === 'v') continue;
    out[key] = BYTE_KEYS.has(key) ? hex(value as string) : value;
  }
  return out as unknown as Message;
}

function rejection(bytes: Uint8Array): string {
  try {
    decodeMessage(bytes);
  } catch (error) {
    if (error instanceof MessageError) return error.reason;
    throw error;
  }
  return 'accepted';
}

describe('pairing messages (pairing-protocol.md §10.2)', () => {
  it('knows the abort reasons of the vectors, in the order of §10.3', () => {
    expect(ABORT_REASONS).toEqual(v.abortReasons);
  });

  it.each(v.valid.map((c) => [c.case, c] as const))('decodes %s', (_case, c) => {
    expect(decodeMessage(hex(c.bytes))).toEqual(expected(c.message));
  });

  it.each(
    v.valid.filter((c) => !c.case.includes('unknown reason')).map((c) => [c.case, c] as const),
  )('encodes %s to the bytes of the vector', (_case, c) => {
    expect(encodeMessage(expected(c.message))).toEqual(hex(c.bytes));
  });

  it.each(v.invalid.map((c) => [c.case, c] as const))('rejects %s', (_case, c) => {
    expect(rejection(hex(c.bytes))).toBe(c.reason);
  });

  it('reads an unknown abort reason as protocol-error', () => {
    const unknown = v.valid.find((c) => c.case.includes('unknown reason'));
    expect(unknown).toBeDefined();
    if (unknown)
      expect(decodeMessage(hex(unknown.bytes))).toEqual({ t: 'abort', reason: 'protocol-error' });
  });

  it('refuses to encode a message that decoding would reject', () => {
    const bad: unknown[] = [
      { t: 'nonce', n: new Uint8Array(31) },
      { t: 'received', name: '' },
      { t: 'received', name: ' Firefox' },
      { t: 'received', name: 'a'.repeat(65) },
      { t: 'devices', own: true, peer: false, name: 'a\rb' },
      { t: 'abort', reason: 'out-of-coffee' },
      { t: 'hello' },
      { t: 'confirmed', extra: 1 },
      { t: 'received', name: undefined },
    ];
    for (const message of bad) {
      expect(() => encodeMessage(message as Message)).toThrow(MessageError);
    }
  });

  it('counts a name in code points, not UTF-16 units', () => {
    const key = '\u{1F511}';
    expect(decodeMessage(encodeMessage({ t: 'received', name: key.repeat(64) }))).toEqual({
      t: 'received',
      name: key.repeat(64),
    });
    expect(() => encodeMessage({ t: 'received', name: key.repeat(65) })).toThrow(MessageError);
  });
});
