// Test-only helpers (excluded from coverage and from the package API).

import vectors from '../test-vectors/crypto-v1.json' with { type: 'json' };

export { vectors };

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function toHex(bytes: Uint8Array): string {
  return Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
}

/** The generator's fixed nonce `i`: 24 bytes of value `i` (tests/vectors/generate.py). */
export function vectorNonce(i: number): Uint8Array {
  return new Uint8Array(24).fill(i);
}

export interface HexHlc {
  physicalMs: number;
  counter: number;
  deviceId: string;
}

export function hlcFromHex(hlc: HexHlc): {
  physicalMs: number;
  counter: number;
  deviceId: Uint8Array;
} {
  return { physicalMs: hlc.physicalMs, counter: hlc.counter, deviceId: fromHex(hlc.deviceId) };
}
