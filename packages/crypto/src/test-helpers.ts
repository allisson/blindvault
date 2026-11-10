// Test-only helpers (excluded from coverage and from the package API).

import vectors from '../test-vectors/crypto-v1.json' with { type: 'json' };

import { type KdfPort, type KdfRequest, handleKdfRequest } from './kdf-worker';

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

/** A clock that advances 2 s per reading: every timed derivation looks slow, so calibration stops at 2. */
export function slowClock(): () => number {
  let t = 0;
  return () => (t += 2000);
}

/** Runs the worker handler in-process, answering asynchronously like a real worker. */
export function inProcessPort(answer?: (request: KdfRequest) => unknown) {
  const state = { posted: 0, terminated: 0, transferred: [] as ArrayBuffer[] };
  const port: KdfPort & { state: typeof state } = {
    state,
    onmessage: null,
    onerror: null,
    postMessage(message, transfer) {
      state.posted += 1;
      state.transferred.push(...transfer);
      const data = answer ? answer(message) : handleKdfRequest(message, slowClock());
      queueMicrotask(() => port.onmessage?.({ data }));
    },
    terminate() {
      state.terminated += 1;
    },
  };
  return port;
}
