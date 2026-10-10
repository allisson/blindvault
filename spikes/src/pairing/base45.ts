// RFC 9285 base45: every character is in the QR alphanumeric set.
const ALPHABET = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

export function encode(bytes: Uint8Array): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 2) {
    const a = bytes[i] ?? 0;
    if (i + 1 < bytes.length) {
      let n = a * 256 + (bytes[i + 1] ?? 0);
      for (let k = 0; k < 3; k++) {
        out += ALPHABET[n % 45];
        n = Math.floor(n / 45);
      }
    } else {
      out += ALPHABET[a % 45];
      out += ALPHABET[Math.floor(a / 45)];
    }
  }
  return out;
}

export function decode(text: string): Uint8Array {
  const values = [...text].map((ch) => {
    const v = ALPHABET.indexOf(ch);
    if (v < 0) throw new Error(`invalid base45 character ${JSON.stringify(ch)}`);
    return v;
  });
  if (values.length % 3 === 1) throw new Error('invalid base45 length');
  const out: number[] = [];
  for (let i = 0; i < values.length; i += 3) {
    const [c = 0, d = 0, e] = values.slice(i, i + 3);
    if (e === undefined) {
      const n = c + d * 45;
      if (n > 0xff) throw new Error('invalid base45 pair');
      out.push(n);
    } else {
      const n = c + d * 45 + e * 45 * 45;
      if (n > 0xffff) throw new Error('invalid base45 triplet');
      out.push(n >> 8, n & 0xff);
    }
  }
  return Uint8Array.from(out);
}
