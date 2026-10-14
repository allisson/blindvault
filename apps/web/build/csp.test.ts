import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { HEADER_CSP, META_CSP } from './csp';

// The configurations a self-hosted deployment copies (docs/self-hosting.md, D195).
const CONFIGS = {
  Caddyfile: readFileSync(new URL('../../../deploy/Caddyfile', import.meta.url), 'utf8'),
  nginx: readFileSync(new URL('../../../deploy/nginx/blindvault.conf', import.meta.url), 'utf8'),
};

/** The values of header `name` in a configuration, in either syntax. */
function header(config: string, name: string): string[] {
  const pattern = new RegExp(
    `^\\s*(?:add_header\\s+)?${name}\\s+"?([^"\\n]*?)"?(?:\\s+always)?;?\\s*$`,
    'gim',
  );
  return [...config.matchAll(pattern)].map((m) => m[1] ?? '');
}

describe('content security policy (D83, D91, D193, D195)', () => {
  it('is the policy of overview §11, and the header adds frame-ancestors', () => {
    expect(META_CSP).toBe(
      "default-src 'none'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self'; img-src 'self' data: blob:; worker-src 'self'; manifest-src 'self'; connect-src 'self'; object-src 'none'; base-uri 'none'; form-action 'none'; require-trusted-types-for 'script'",
    );
    expect(HEADER_CSP).toBe(`${META_CSP}; frame-ancestors 'none'`);
  });

  it.each(Object.entries(CONFIGS))('is sent by the %s configuration as a header', (_, config) => {
    expect(header(config, 'Content-Security-Policy')).toEqual([HEADER_CSP]);
  });

  it.each(Object.entries(CONFIGS))(
    'comes with the other headers of the %s configuration',
    (_, config) => {
      expect(header(config, 'Referrer-Policy')).toEqual(['no-referrer']);
      expect(header(config, 'X-Content-Type-Options')).toEqual(['nosniff']);
      expect(header(config, 'Cross-Origin-Opener-Policy')).toEqual(['same-origin']);
    },
  );

  it('finds no header in a configuration that lacks it', () => {
    expect(
      header('add_header Referrer-Policy "no-referrer" always;\n', 'Content-Security-Policy'),
    ).toEqual([]);
    expect(header('Content-Security-Policy-Report-Only "x"\n', 'Content-Security-Policy')).toEqual(
      [],
    );
  });
});
