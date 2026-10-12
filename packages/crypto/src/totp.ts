// TOTP (RFC 6238) over WebCrypto HMAC, and the `otpauth://` parser (D127, record-content.md §4).
// The parser is adapted from BlindPass `parseOtpauthUri`: it rejects what BlindPass defaulted
// (an unknown algorithm, out-of-range digits or period) and writes the defaults explicitly.

import { EncodingError, TotpRejectedError } from './errors';

// The package compiles without the DOM lib; WebCrypto is declared to the extent used here.
interface HmacSubtle {
  importKey(
    format: 'raw',
    key: Uint8Array,
    algorithm: { name: 'HMAC'; hash: string },
    extractable: false,
    usages: ['sign'],
  ): Promise<unknown>;
  sign(algorithm: 'HMAC', key: unknown, data: Uint8Array): Promise<ArrayBuffer>;
}
declare const crypto: { readonly subtle: HmacSubtle };

export type TotpAlgorithm = 'SHA1' | 'SHA256' | 'SHA512';

/** The `totp` field value of `record-content.md` §4. */
export interface TotpValue {
  readonly secret: string;
  readonly algorithm: TotpAlgorithm;
  readonly digits: number;
  readonly period: number;
  readonly issuer?: string;
  readonly accountName?: string;
}

const ALGORITHMS: Record<TotpAlgorithm, string> = {
  SHA1: 'SHA-1',
  SHA256: 'SHA-256',
  SHA512: 'SHA-512',
};
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const DEFAULTS = { algorithm: 'SHA1', digits: 6, period: 30 } as const;

function isAlgorithm(value: string): value is TotpAlgorithm {
  return Object.hasOwn(ALGORITHMS, value);
}

function inRange(value: number, min: number, max: number): boolean {
  return Number.isSafeInteger(value) && value >= min && value <= max;
}

function singleLine(value: string): boolean {
  return value.length > 0 && !/\p{Cc}/u.test(value);
}

/** Throws unless `value` holds every rule of `record-content.md` §4. */
export function checkTotpValue(value: TotpValue): void {
  if (!/^[A-Z2-7]+$/.test(value.secret)) throw new TotpRejectedError('secret');
  if (!isAlgorithm(value.algorithm)) throw new TotpRejectedError('algorithm');
  if (!inRange(value.digits, 6, 8)) throw new TotpRejectedError('digits');
  if (!inRange(value.period, 15, 300)) throw new TotpRejectedError('period');
  for (const text of [value.issuer, value.accountName]) {
    if (text !== undefined && !singleLine(text)) throw new TotpRejectedError('label');
  }
}

/** Removes whitespace and uppercases, the only normalization input gets. */
function normalizeSecret(input: string): string {
  return input.replace(/\p{White_Space}/gu, '').toUpperCase();
}

/** A bare base32 secret, with the defaults written explicitly. */
export function parseTotpSecret(input: string): TotpValue {
  const value: TotpValue = { secret: normalizeSecret(input), ...DEFAULTS };
  checkTotpValue(value);
  return value;
}

function decodeComponent(text: string): string {
  try {
    return decodeURIComponent(text);
  } catch {
    throw new TotpRejectedError('uri');
  }
}

/**
 * Parses `otpauth://totp/label?secret=…&issuer=…&algorithm=…&digits=…&period=…`. The `issuer`
 * parameter wins over a label prefix; the URI itself is not kept. Anything else is rejected.
 */
export function parseOtpauthUri(uri: string): TotpValue {
  const match = /^otpauth:\/\/totp\/([^?#]*)(?:\?([^#]*))?$/i.exec(uri.trim());
  if (!match) throw new TotpRejectedError('uri');
  const params = new Map<string, string>();
  for (const pair of (match[2] ?? '').split('&')) {
    if (pair === '') continue;
    const eq = pair.indexOf('=');
    const key = decodeComponent(eq === -1 ? pair : pair.slice(0, eq)).toLowerCase();
    const raw = eq === -1 ? '' : pair.slice(eq + 1);
    if (params.has(key)) throw new TotpRejectedError('uri');
    params.set(key, decodeComponent(raw.replace(/\+/g, ' ')));
  }
  const secret = params.get('secret');
  if (secret === undefined) throw new TotpRejectedError('secret');

  const algorithm = (params.get('algorithm') ?? DEFAULTS.algorithm).toUpperCase();
  if (!isAlgorithm(algorithm)) throw new TotpRejectedError('algorithm');
  const integer = (key: string, fallback: number, reason: 'digits' | 'period'): number => {
    const text = params.get(key);
    if (text === undefined) return fallback;
    if (!/^[0-9]{1,4}$/.test(text)) throw new TotpRejectedError(reason);
    return Number(text);
  };

  const label = decodeComponent(match[1] ?? '');
  const colon = label.indexOf(':');
  const labelIssuer = colon === -1 ? '' : label.slice(0, colon).trim();
  const accountName = (colon === -1 ? label : label.slice(colon + 1)).trim();
  const issuer = (params.get('issuer') ?? labelIssuer).trim();

  const value: TotpValue = {
    secret: normalizeSecret(secret),
    algorithm,
    digits: integer('digits', DEFAULTS.digits, 'digits'),
    period: integer('period', DEFAULTS.period, 'period'),
    ...(issuer === '' ? {} : { issuer }),
    ...(accountName === '' ? {} : { accountName }),
  };
  checkTotpValue(value);
  return value;
}

/** RFC 4648 base32 without padding; trailing bits that do not fill a byte are dropped. */
function decodeBase32(secret: string): Uint8Array {
  const out = new Uint8Array(Math.floor((secret.length * 5) / 8));
  let buffer = 0;
  let bits = 0;
  let index = 0;
  for (const char of secret) {
    buffer = ((buffer << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      out[index++] = (buffer >> bits) & 0xff;
    }
  }
  return out;
}

/** The code for the time step holding `nowMs` (Unix milliseconds). */
export async function totpCode(value: TotpValue, nowMs: number): Promise<string> {
  checkTotpValue(value);
  if (!Number.isSafeInteger(nowMs) || nowMs < 0) throw new EncodingError('time out of range');
  const counter = Math.floor(Math.floor(nowMs / 1000) / value.period);
  const message = new Uint8Array(8);
  const view = new DataView(message.buffer);
  view.setUint32(0, Math.floor(counter / 2 ** 32));
  view.setUint32(4, counter >>> 0);

  const keyBytes = decodeBase32(value.secret);
  const key = await crypto.subtle.importKey(
    'raw',
    keyBytes,
    { name: 'HMAC', hash: ALGORITHMS[value.algorithm] },
    false,
    ['sign'],
  );
  keyBytes.fill(0);
  const mac = new Uint8Array(await crypto.subtle.sign('HMAC', key, message));
  const offset = (mac[mac.length - 1] ?? 0) & 0x0f;
  const binary = new DataView(mac.buffer).getUint32(offset) & 0x7fffffff;
  mac.fill(0);
  return String(binary % 10 ** value.digits).padStart(value.digits, '0');
}

/** Seconds until the current code expires: 1 to `period`. */
export function totpSecondsRemaining(period: number, nowMs: number): number {
  return period - (Math.floor(nowMs / 1000) % period);
}
