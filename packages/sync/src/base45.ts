// Base45 (RFC 9285): every character is in the QR alphanumeric set, so the pairing payload fills a
// QR code in alphanumeric mode (`pairing-protocol.md` §3.4). Decoding is strict: a text that is not
// the encoding of some bytes is rejected, so every byte string has exactly one text.

const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export class Base45Error extends Error {
  override name = 'Base45Error';
}

export function encodeBase45(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const first = bytes[i] ?? 0;
    const second = bytes[i + 1];
    let n = second === undefined ? first : first * 256 + second;
    const digits = second === undefined ? 2 : 3;
    for (let k = 0; k < digits; k++) {
      out += ALPHABET.charAt(n % 45);
      n = Math.floor(n / 45);
    }
  }
  return out;
}

export function decodeBase45(text: string): Uint8Array {
  if (text.length % 3 === 1) throw new Base45Error('invalid base45 length');
  const out = new Uint8Array(Math.floor(text.length / 3) * 2 + (text.length % 3 === 2 ? 1 : 0));
  let o = 0;
  for (let i = 0; i < text.length; i += 3) {
    const group = text.slice(i, i + 3);
    let n = 0;
    for (let k = group.length - 1; k >= 0; k--) {
      const value = ALPHABET.indexOf(group.charAt(k));
      if (value < 0) throw new Base45Error('invalid base45 character');
      n = n * 45 + value;
    }
    if (group.length === 3) {
      if (n > 0xffff) throw new Base45Error('invalid base45 group');
      out[o++] = n >> 8;
      out[o++] = n & 0xff;
    } else {
      if (n > 0xff) throw new Base45Error('invalid base45 group');
      out[o++] = n;
    }
  }
  return out;
}
