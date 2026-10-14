import { describe, expect, it } from 'vitest';

import vectors from '../test-vectors/pairing-v1.json' with { type: 'json' };
import {
  FRAME_DATA_LENGTH,
  FrameError,
  FrameReader,
  MAX_PROTOCOL_MESSAGE_LENGTH,
  toFrames,
} from './frames';

const v = vectors.framing;

/** The message bytes of the vectors: byte `i` is `i mod 251`. */
function message(length: number): Uint8Array {
  return Uint8Array.from({ length }, (_, i) => i % 251);
}

/** Frames built from their description, cutting `message(total)` in order. */
function frames(described: readonly { last: number | null; length: number }[]): Uint8Array[] {
  const total = described.reduce((sum, f) => sum + f.length, 0);
  const data = message(total);
  let offset = 0;
  return described.map((f) => {
    const part = data.subarray(offset, offset + f.length);
    offset += f.length;
    if (f.last === null) return new Uint8Array();
    return Uint8Array.of(f.last, ...part);
  });
}

/** Bytes as hex: `toEqual` walks a `Uint8Array` element by element, seconds for the 1 MB vector. */
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

function read(list: readonly Uint8Array[]): Uint8Array[] {
  const reader = new FrameReader();
  const out: Uint8Array[] = [];
  for (const frame of list) {
    const joined = reader.push(frame);
    if (joined) out.push(joined);
  }
  return out;
}

describe('framing (pairing-protocol.md §10.1, D201)', () => {
  it('uses the lengths of the vectors', () => {
    expect(FRAME_DATA_LENGTH).toBe(v.frameDataLength);
    expect(MAX_PROTOCOL_MESSAGE_LENGTH).toBe(vectors.messages.maxMessageLength);
  });

  it.each(v.valid.map((c) => [c.messageLength, c] as const))(
    'cuts a message of %i bytes as the vector does, and joins it back',
    (length, c) => {
      const built = toFrames(message(length));
      expect(built.map((f) => ({ last: f[0], length: f.length - 1 }))).toEqual(c.frames);
      expect(built.map(toHex)).toEqual(frames(c.frames).map(toHex));
      expect(read(built).map(toHex)).toEqual([toHex(message(length))]);
    },
  );

  it.each(v.invalid.map((c) => [c.case, c] as const))('rejects %s', (_case, c) => {
    expect(() => read(frames(c.frames))).toThrow(FrameError);
  });

  it('rejects a frame longer than a channel message', () => {
    expect(() => read([new Uint8Array(FRAME_DATA_LENGTH + 2).fill(1)])).toThrow(FrameError);
  });

  it('reads several messages in a row', () => {
    const one = message(3);
    const two = message(FRAME_DATA_LENGTH + 5);
    expect(read([...toFrames(one), ...toFrames(two), ...toFrames(one)])).toEqual([one, two, one]);
  });

  it('refuses to cut an empty message or one over the maximum', () => {
    expect(() => toFrames(new Uint8Array())).toThrow(FrameError);
    expect(() => toFrames(new Uint8Array(MAX_PROTOCOL_MESSAGE_LENGTH + 1))).toThrow(FrameError);
  });

  it('wipes the frames it joined', () => {
    const reader = new FrameReader();
    const built = toFrames(message(FRAME_DATA_LENGTH + 2));
    const first = built[0] ?? new Uint8Array();
    expect(reader.push(first)).toBeNull();
    expect(reader.push(built[1] ?? new Uint8Array())).toEqual(message(FRAME_DATA_LENGTH + 2));
    expect(first.subarray(1).every((b) => b === 0)).toBe(true);
  });
});
