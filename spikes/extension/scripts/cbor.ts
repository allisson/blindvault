// The few CBOR shapes a `none` attestation and a COSE key need: integers, byte and text strings,
// maps. Spike code only; the product uses cbor2 (D10).

type Value = number | string | Uint8Array | Map<number | string, Value>;

function head(major: number, n: number): number[] {
  const m = major << 5;
  if (n < 24) return [m | n];
  if (n < 0x100) return [m | 24, n];
  if (n < 0x10000) return [m | 25, n >> 8, n & 0xff];
  return [m | 26, (n >>> 24) & 0xff, (n >> 16) & 0xff, (n >> 8) & 0xff, n & 0xff];
}

export function encode(value: Value): Uint8Array {
  const out: number[] = [];
  const walk = (v: Value): void => {
    if (typeof v === 'number') {
      out.push(...(v >= 0 ? head(0, v) : head(1, -1 - v)));
    } else if (typeof v === 'string') {
      const b = new TextEncoder().encode(v);
      out.push(...head(3, b.length), ...b);
    } else if (v instanceof Uint8Array) {
      out.push(...head(2, v.length), ...v);
    } else {
      out.push(...head(5, v.size));
      for (const [k, x] of v) {
        walk(k);
        walk(x);
      }
    }
  };
  walk(value);
  return new Uint8Array(out);
}
