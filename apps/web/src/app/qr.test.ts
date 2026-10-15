import { describe, expect, it } from 'vitest';
import wasmData from 'zxing-wasm/reader/zxing_reader.wasm?inline';

import { QUIET_ZONE, qrMatrix, qrPath } from './qr';
import { type Pixels, createQrReader } from './qr-reader';

// A pairing payload's text is base45 (RFC 9285), the QR alphanumeric alphabet (D4, D208).
const PAYLOAD = 'NCFOXN%TS3DH3ZSUZK+.V0ETD%65NL-AH-R6IOOK.IR9B+9D-4D19B2:KZ3P*BQUVB:KZ$N0EG';

/** The reader with the WASM module itself, as a test has no server to fetch it from. */
function reader() {
  const base64 = wasmData.slice(wasmData.indexOf(',') + 1);
  const wasm = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return createQrReader({ wasmBinary: wasm.buffer });
}

/** The matrix drawn as RGBA pixels, `scale` per module, with the quiet zone. */
function pixels(matrix: readonly (readonly boolean[])[], scale = 4): Pixels {
  const size = (matrix.length + 2 * QUIET_ZONE) * scale;
  const data = new Uint8ClampedArray(size * size * 4).fill(255);
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (!dark) return;
      for (let y = 0; y < scale; y++) {
        for (let x = 0; x < scale; x++) {
          const at = ((r + QUIET_ZONE) * scale + y) * size + (c + QUIET_ZONE) * scale + x;
          data.fill(0, at * 4, at * 4 + 3);
        }
      }
    });
  });
  return { data, width: size, height: size };
}

describe('QR code of a payload text (D208)', () => {
  it('encodes the base45 text in the alphanumeric mode, error correction M', () => {
    const matrix = qrMatrix(PAYLOAD);
    // 74 alphanumeric characters at M fit version 4: 33 modules a side.
    expect(PAYLOAD).toHaveLength(74);
    expect(matrix).toHaveLength(33);
    for (const row of matrix) expect(row).toHaveLength(33);
  });

  it('measured payloads of 156 and 188 characters fit versions 7 and 8 (spike, D4)', () => {
    expect(qrMatrix('A'.repeat(156))).toHaveLength(45);
    expect(qrMatrix('A'.repeat(188))).toHaveLength(49);
  });

  it('refuses a text outside the alphanumeric alphabet: never a payload', () => {
    expect(() => qrMatrix('lowercase')).toThrow();
    expect(() => qrMatrix('')).toThrow();
  });

  it('draws one path of unit squares, offset by the quiet zone', () => {
    const matrix = qrMatrix(PAYLOAD);
    const path = qrPath(matrix);
    const dark = matrix.flat().filter(Boolean).length;
    expect(path.match(/M/g)).toHaveLength(dark);
    // The top-left finder pattern starts at the quiet zone.
    expect(path.startsWith(`M${String(QUIET_ZONE)} ${String(QUIET_ZONE)}h1v1h-1z`)).toBe(true);
  });

  it('reads back the same text from the drawn code', async () => {
    const read = reader();
    expect(await read(pixels(qrMatrix(PAYLOAD)))).toBe(PAYLOAD);
    const long = 'A1 $%*+-./:'.repeat(17);
    expect(await read(pixels(qrMatrix(long), 3))).toBe(long);
  });

  it('reads nothing from an image with no code, or a code cut in half', async () => {
    const read = reader();
    const blank = { data: new Uint8ClampedArray(64 * 64 * 4).fill(255), width: 64, height: 64 };
    expect(await read(blank)).toBeUndefined();
    const whole = pixels(qrMatrix(PAYLOAD));
    const half = whole.data.slice();
    half.fill(255, half.length / 2);
    expect(await read({ ...whole, data: half })).toBeUndefined();
  });
});
