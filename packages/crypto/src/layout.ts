// The layout encoding of crypto-spec.md §3 (D10) and the AADs of §8. Layouts are only built from
// values already validated, never parsed.

import { EncodingError } from './errors';
import { ID_LENGTH } from './sodium';

const U16_MAX = 0xffff;
const U32_MAX = 0xffffffff;

function checkInteger(value: number, max: number, name: string): void {
  if (!Number.isSafeInteger(value) || value < 0 || value > max) {
    throw new EncodingError(`${name} out of range`);
  }
}

export function u8(value: number): Uint8Array {
  checkInteger(value, 0xff, 'u8');
  return Uint8Array.of(value);
}

export function u16(value: number): Uint8Array {
  checkInteger(value, U16_MAX, 'u16');
  const out = new Uint8Array(2);
  new DataView(out.buffer).setUint16(0, value);
  return out;
}

export function u32(value: number): Uint8Array {
  checkInteger(value, U32_MAX, 'u32');
  const out = new Uint8Array(4);
  new DataView(out.buffer).setUint32(0, value);
  return out;
}

/** A `u64` limited to 2^53 − 1, the range of every u64 the format uses (`physicalMs`). */
export function u64(value: number): Uint8Array {
  checkInteger(value, Number.MAX_SAFE_INTEGER, 'u64');
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, BigInt(value));
  return out;
}

export function bool(value: boolean): Uint8Array {
  return Uint8Array.of(value ? 1 : 0);
}

/** An ASCII label, as its bytes with no terminator. */
export function label(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    if (code > 0x7f) throw new EncodingError('a label is ASCII');
    out[i] = code;
  }
  return out;
}

/** A 16-byte identifier, checked and copied. */
export function id(value: Uint8Array): Uint8Array {
  if (value.length !== ID_LENGTH) throw new EncodingError('an ID is 16 bytes');
  return value.slice();
}

/** `field(x) = u32(len(x)) ‖ x` */
export function field(value: Uint8Array): Uint8Array {
  const out = new Uint8Array(4 + value.length);
  out.set(u32(value.length), 0);
  out.set(value, 4);
  return out;
}

/** `layout(x1, …, xn) = field(x1) ‖ … ‖ field(xn)` */
export function layout(...values: Uint8Array[]): Uint8Array {
  const fields = values.map(field);
  const out = new Uint8Array(fields.reduce((total, f) => total + f.length, 0));
  let offset = 0;
  for (const f of fields) {
    out.set(f, offset);
    offset += f.length;
  }
  return out;
}

/** Hybrid logical clock value (crypto-spec.md §4, D19). */
export interface Hlc {
  readonly physicalMs: number;
  readonly counter: number;
  readonly deviceId: Uint8Array;
}

/** The cleartext record header (overview §6, D18, D21, D32). */
export interface RecordHeader {
  readonly recordFormatVersion: number;
  readonly recordType: number;
  readonly recordId: Uint8Array;
  readonly keyEpoch: number;
  readonly hlc: Hlc;
  readonly deleted: boolean;
}

/** `AAD_record` (crypto-spec.md §8): 105 bytes binding the whole header and the `vaultId`. */
export function recordAad(header: RecordHeader, vaultId: Uint8Array): Uint8Array {
  if (header.keyEpoch < 1) throw new EncodingError('keyEpoch starts at 1');
  return layout(
    u16(header.recordFormatVersion),
    u16(header.recordType),
    id(vaultId),
    id(header.recordId),
    u32(header.keyEpoch),
    u64(header.hlc.physicalMs),
    u32(header.hlc.counter),
    id(header.hlc.deviceId),
    bool(header.deleted),
  );
}

/** The purpose labels of local wraps (crypto-spec.md §8, D121). */
export const LocalPurpose = {
  mkWrapDeviceKek: 'bv.v1.mk-wrap.device-kek',
  mkWrapPrfKek: 'bv.v1.mk-wrap.prf-kek',
  localConfig: 'bv.v1.local-config',
} as const;

export type LocalPurpose = (typeof LocalPurpose)[keyof typeof LocalPurpose];

/** `AAD_local(purpose) = layout(purpose, vaultId, localConfigId)` (CRYPTO-INV-023). */
export function localAad(
  purpose: LocalPurpose,
  vaultId: Uint8Array,
  localConfigId: Uint8Array,
): Uint8Array {
  return layout(label(purpose), id(vaultId), id(localConfigId));
}
