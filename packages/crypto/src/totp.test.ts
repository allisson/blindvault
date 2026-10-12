import { describe, expect, it } from 'vitest';

import { EncodingError, TotpRejectedError } from './errors';
import {
  type TotpValue,
  checkTotpValue,
  parseOtpauthUri,
  parseTotpSecret,
  totpCode,
  totpSecondsRemaining,
} from './totp';

// RFC 6238 Appendix B: ASCII "1234567890…" seeds of 20, 32 and 64 bytes, 8 digits, 30 s.
const SEEDS = {
  SHA1: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ',
  SHA256: 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZA',
  SHA512:
    'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQGEZDGNA',
} as const;

const RFC6238: [number, string, string, string][] = [
  [59, '94287082', '46119246', '90693936'],
  [1111111109, '07081804', '68084774', '25091201'],
  [1111111111, '14050471', '67062674', '99943326'],
  [1234567890, '89005924', '91819424', '93441116'],
  [2000000000, '69279037', '90698825', '38618901'],
  [20000000000, '65353130', '77737706', '47863826'],
];

const cases = RFC6238.flatMap(([t, sha1, sha256, sha512]) =>
  (
    [
      ['SHA1', sha1],
      ['SHA256', sha256],
      ['SHA512', sha512],
    ] as const
  ).map(([algorithm, code]) => ({ t, algorithm, code })),
);

describe('TOTP codes (RFC 6238, D127)', () => {
  it.each(cases)('$algorithm at T = $t s is $code', async ({ t, algorithm, code }) => {
    const value: TotpValue = { secret: SEEDS[algorithm], algorithm, digits: 8, period: 30 };
    expect(await totpCode(value, t * 1000)).toBe(code);
  });

  it('keeps leading zeros and truncates to 6 digits', async () => {
    const value: TotpValue = { secret: SEEDS.SHA1, algorithm: 'SHA1', digits: 6, period: 30 };
    expect(await totpCode(value, 1111111109 * 1000)).toBe('081804');
  });

  it('changes at the period boundary only', async () => {
    const value = parseTotpSecret(SEEDS.SHA1);
    expect(await totpCode(value, 59_999)).toBe(await totpCode(value, 30_000));
    expect(await totpCode(value, 60_000)).not.toBe(await totpCode(value, 59_999));
  });

  it('rejects an invalid value or time before computing', async () => {
    const value = parseTotpSecret(SEEDS.SHA1);
    await expect(totpCode({ ...value, digits: 9 }, 0)).rejects.toThrow(TotpRejectedError);
    await expect(totpCode(value, -1)).rejects.toThrow(EncodingError);
    await expect(totpCode(value, 1.5)).rejects.toThrow(EncodingError);
  });

  it('counts the seconds left in the period', () => {
    expect(totpSecondsRemaining(30, 0)).toBe(30);
    expect(totpSecondsRemaining(30, 29_999)).toBe(1);
    expect(totpSecondsRemaining(30, 30_000)).toBe(30);
  });
});

describe('TOTP value (record-content.md §4)', () => {
  it('normalizes a bare secret and writes the defaults', () => {
    expect(parseTotpSecret(' jbsw y3dp\tehpk 3pxp ')).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
  });

  it.each([
    ['an empty secret', '  ', 'secret'],
    ['padding', 'JBSWY3DP====', 'secret'],
    ['a digit outside base32', 'JBSWY3D1', 'secret'],
  ])('rejects %s', (_name, input, reason) => {
    expect(() => parseTotpSecret(input)).toThrow(expect.objectContaining({ reason }));
  });

  it.each([
    ['digits 5', { digits: 5 }, 'digits'],
    ['digits 9', { digits: 9 }, 'digits'],
    ['period 14', { period: 14 }, 'period'],
    ['period 301', { period: 301 }, 'period'],
    ['period 30.5', { period: 30.5 }, 'period'],
    ['an unknown algorithm', { algorithm: 'MD5' }, 'algorithm'],
    ['an empty issuer', { issuer: '' }, 'label'],
    ['a multi-line account name', { accountName: 'a\nb' }, 'label'],
    ['a lowercase secret', { secret: 'jbswy3dp' }, 'secret'],
  ])('checkTotpValue rejects %s', (_name, change, reason) => {
    const value = { ...parseTotpSecret('JBSWY3DP'), ...change } as TotpValue;
    expect(() => {
      checkTotpValue(value);
    }).toThrow(expect.objectContaining({ reason }));
  });
});

describe('otpauth:// parser (adapted from BlindPass, D127)', () => {
  it('parses a full URI', () => {
    expect(
      parseOtpauthUri(
        'otpauth://totp/GitHub%3Auser%40example.com?secret=JBSWY3DPEHPK3PXP&issuer=GitHub&algorithm=SHA1&digits=6&period=30',
      ),
    ).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      issuer: 'GitHub',
      accountName: 'user@example.com',
    });
  });

  it('writes the defaults explicitly and omits empty labels', () => {
    expect(parseOtpauthUri('otpauth://totp/?secret=jbswy3dpehpk3pxp')).toEqual({
      secret: 'JBSWY3DPEHPK3PXP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
    });
  });

  it('takes the issuer from the label prefix when the parameter is absent', () => {
    expect(parseOtpauthUri('otpauth://totp/ACME%20Co:john?secret=JBSWY3DP')).toMatchObject({
      issuer: 'ACME Co',
      accountName: 'john',
    });
  });

  it('prefers the issuer parameter, decodes + as a space, and accepts any case of the scheme', () => {
    expect(
      parseOtpauthUri(
        'OTPAUTH://TOTP/Old:me?SECRET=JBSWY3DP&issuer=My+Bank&algorithm=sha512&digits=8&period=60',
      ),
    ).toEqual({
      secret: 'JBSWY3DP',
      algorithm: 'SHA512',
      digits: 8,
      period: 60,
      issuer: 'My Bank',
      accountName: 'me',
    });
  });

  it.each([
    ['another scheme', 'https://example.com', 'uri'],
    ['an HOTP URI', 'otpauth://hotp/test?secret=JBSWY3DP&counter=0', 'uri'],
    ['a fragment', 'otpauth://totp/test?secret=JBSWY3DP#x', 'uri'],
    ['not a URI', 'not-a-uri', 'uri'],
    ['malformed percent-encoding', 'otpauth://totp/%E0%A4%A?secret=JBSWY3DP', 'uri'],
    ['a duplicated parameter', 'otpauth://totp/t?secret=JBSWY3DP&secret=JBSWY3DP', 'uri'],
    ['no secret', 'otpauth://totp/test?issuer=Test', 'secret'],
    ['an empty secret', 'otpauth://totp/test?secret=', 'secret'],
    [
      'an unknown algorithm (BlindPass defaulted it)',
      'otpauth://totp/t?secret=JBSWY3DP&algorithm=MD5',
      'algorithm',
    ],
    [
      'digits out of range (BlindPass kept them)',
      'otpauth://totp/t?secret=JBSWY3DP&digits=10',
      'digits',
    ],
    ['non-numeric digits', 'otpauth://totp/t?secret=JBSWY3DP&digits=6x', 'digits'],
    ['a period out of range', 'otpauth://totp/t?secret=JBSWY3DP&period=5', 'period'],
    ['a negative period', 'otpauth://totp/t?secret=JBSWY3DP&period=-30', 'period'],
    ['a multi-line issuer', 'otpauth://totp/t?secret=JBSWY3DP&issuer=a%0Ab', 'label'],
  ])('rejects %s', (_name, uri, reason) => {
    expect(() => parseOtpauthUri(uri)).toThrow(expect.objectContaining({ reason }));
  });

  it('ignores empty pairs and keeps unknown parameters out of the value', () => {
    expect(parseOtpauthUri('otpauth://totp/t?&secret=JBSWY3DP&image=x&flag')).toEqual({
      secret: 'JBSWY3DP',
      algorithm: 'SHA1',
      digits: 6,
      period: 30,
      accountName: 't',
    });
  });
});
