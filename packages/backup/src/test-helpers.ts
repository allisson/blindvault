// Test-only helpers (excluded from coverage and from the package API).

import { createHash } from 'node:crypto';

import vectors from '../test-vectors/backup-v1.json' with { type: 'json' };

export { vectors };

export function fromHex(hex: string): Uint8Array {
  if (hex.length % 2 !== 0 || !/^[0-9a-f]*$/.test(hex)) throw new Error(`bad hex: ${hex}`);
  const out = new Uint8Array(hex.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(hex.slice(2 * i, 2 * i + 2), 16);
  return out;
}

export function fromBase64(b64: string): Uint8Array {
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

export function blake2b512(bytes: Uint8Array): string {
  return createHash('blake2b512').update(bytes).digest('hex');
}

type Valid = (typeof vectors.valid)[number];

/** A valid vector file by name. */
export function validFile(name: string): Uint8Array {
  const v = vectors.valid.find((x: Valid) => x.name === name);
  if (!v) throw new Error(`no valid vector ${name}`);
  return fromBase64(v.file);
}

export interface Edit {
  base: string;
  keep?: number;
  append?: string;
  flip?: number;
}

/** A rejected file, given whole or as an edit of a valid one (tests/vectors/generate.py). */
export function rejectedFile(v: { file?: string; edit?: Edit }): Uint8Array {
  if (v.file !== undefined) return fromBase64(v.file);
  if (!v.edit) throw new Error('vector without a file');
  let f = validFile(v.edit.base).slice();
  if (v.edit.flip !== undefined) f[v.edit.flip] = (f[v.edit.flip] ?? 0) ^ 1;
  if (v.edit.keep !== undefined) f = f.slice(0, v.edit.keep);
  const tail = fromHex(v.edit.append ?? '');
  const out = new Uint8Array(f.length + tail.length);
  out.set(f);
  out.set(tail, f.length);
  return out;
}
