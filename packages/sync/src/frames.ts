// The framing of `pairing-protocol.md` §10.1 (D201): a protocol message is cut into frames of
// `u8 last ‖ bytes`, each one Noise channel message. The framing is canonical: every frame but the
// final one carries exactly `FRAME_DATA_LENGTH` bytes, the final one 1 to `FRAME_DATA_LENGTH`, so
// each message has one framing and the reader rejects any other.

import { MAX_CHANNEL_MESSAGE_LENGTH } from './channel';

/** The message bytes in one frame: a channel message less the `last` byte. */
export const FRAME_DATA_LENGTH = MAX_CHANNEL_MESSAGE_LENGTH - 1;

/** The largest record envelope (`crypto-spec.md` §9.2) plus 64 bytes for the message map. */
export const MAX_PROTOCOL_MESSAGE_LENGTH = 1_049_194;

export class FrameError extends Error {
  override name = 'FrameError';
  constructor(detail: string) {
    super(`pairing frame rejected: ${detail}`);
  }
}

/** Cuts a message into its frames. */
export function toFrames(message: Uint8Array): Uint8Array[] {
  if (message.length === 0) throw new FrameError('empty message');
  if (message.length > MAX_PROTOCOL_MESSAGE_LENGTH) throw new FrameError('message too long');
  const frames: Uint8Array[] = [];
  for (let offset = 0; offset < message.length; offset += FRAME_DATA_LENGTH) {
    const data = message.subarray(offset, offset + FRAME_DATA_LENGTH);
    const frame = new Uint8Array(1 + data.length);
    frame[0] = offset + FRAME_DATA_LENGTH >= message.length ? 1 : 0;
    frame.set(data, 1);
    frames.push(frame);
  }
  return frames;
}

/** Joins frames back into messages, rejecting any framing but the canonical one. */
export class FrameReader {
  private parts: Uint8Array[] = [];
  private length = 0;

  /**
   * Adds the next frame; returns the message once its final frame arrives, else `null`. Throws
   * `FrameError`, after which the reader is not used again: the session aborts. The frames joined
   * are wiped, since a message may hold a key.
   */
  push(frame: Uint8Array): Uint8Array | null {
    if (frame.length === 0) throw new FrameError('empty frame');
    const last = frame[0];
    const data = frame.subarray(1);
    if (last !== 0 && last !== 1) throw new FrameError('last is neither 0 nor 1');
    if (data.length > FRAME_DATA_LENGTH) throw new FrameError('frame too long');
    if (last === 0 && data.length !== FRAME_DATA_LENGTH) {
      throw new FrameError('a frame before the final one is not full');
    }
    if (last === 1 && data.length === 0) throw new FrameError('empty final frame');
    this.length += data.length;
    if (this.length > MAX_PROTOCOL_MESSAGE_LENGTH) throw new FrameError('message too long');
    this.parts.push(data);
    if (last === 0) return null;

    const message = new Uint8Array(this.length);
    let offset = 0;
    for (const part of this.parts) {
      message.set(part, offset);
      offset += part.length;
      part.fill(0);
    }
    this.parts = [];
    this.length = 0;
    return message;
  }
}
