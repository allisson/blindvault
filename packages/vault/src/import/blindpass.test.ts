import { describe, expect, it } from 'vitest';

import { ImportRejectedError } from '../errors';
import { parseBlindPassExport } from './blindpass';

// The format is in docs/blindpass-format.md. The first file is BlindPass's own e2e fixture
// (`apps/web/e2e/fixtures/blindpass-export.json`).

const file = (items: unknown, extra: Record<string, unknown> = {}) =>
  JSON.stringify({
    version: 1,
    type: 'blindpass-export',
    exportedAt: '2024-01-01T00:00:00.000Z',
    items,
    ...extra,
  });

const one = (item: Record<string, unknown>) => {
  const [parsed] = parseBlindPassExport(file([item])).items;
  return parsed;
};

function refused(json: string, reason: string, item?: number) {
  try {
    parseBlindPassExport(json);
  } catch (e) {
    expect(e).toBeInstanceOf(ImportRejectedError);
    expect((e as ImportRejectedError).reason).toBe(reason);
    expect((e as ImportRejectedError).item).toBe(item);
    return;
  }
  expect.unreachable('the file was accepted');
}

describe('BlindPass plaintext export', () => {
  it('reads BlindPass e2e fixture', () => {
    const fixture = `{
  "version": 1,
  "type": "blindpass-export",
  "exportedAt": "2024-01-01T00:00:00.000Z",
  "items": [
    {
      "type": "login",
      "title": "GitHub",
      "username": "user@example.com",
      "password": "hunter2",
      "url": "https://github.com"
    }
  ]
}`;
    expect(parseBlindPassExport(fixture)).toEqual({
      items: [
        {
          title: 'GitHub',
          template: 'login',
          fields: [
            { key: 'Username', value: 'user@example.com', role: 'username' },
            { key: 'Password', value: 'hunter2', role: 'password' },
            { key: 'URL', value: 'https://github.com', role: 'url' },
          ],
        },
      ],
      skipped: 0,
    });
  });

  it('keeps custom fields after the template fields, and the notes', () => {
    expect(
      one({
        type: 'login',
        title: 'Bank',
        username: '',
        password: 'p',
        notes: 'n',
        customFields: [
          { label: 'PIN', value: '1234' },
          { label: 'Empty', value: '' },
        ],
      }),
    ).toEqual({
      title: 'Bank',
      template: 'login',
      fields: [
        { key: 'Password', value: 'p', role: 'password' },
        { key: 'PIN', value: '1234' },
      ],
      notes: 'n',
    });
  });

  it('reads a secure note as a note with its content', () => {
    expect(one({ type: 'secure_note', title: 'Wi-Fi', content: 'pass: x' })).toEqual({
      title: 'Wi-Fi',
      template: 'secure-note',
      fields: [],
      notes: 'pass: x',
    });
  });

  it('reads a card, its expiry as YYYY-MM when both parts are numbers', () => {
    const card = {
      type: 'payment_card',
      title: 'Visa',
      cardholderName: 'A B',
      number: '4111',
      cvv: '123',
    };
    expect(one({ ...card, expMonth: '3', expYear: '27' })).toEqual({
      title: 'Visa',
      template: 'card',
      fields: [
        { key: 'Cardholder', value: 'A B', role: 'cardholder' },
        { key: 'Number', value: '4111', role: 'number' },
        { key: 'Expiry', value: '2027-03', role: 'expiry' },
        { key: 'CVV', value: '123', role: 'cvv' },
      ],
    });
    expect(one({ ...card, expMonth: '12', expYear: '2031' })?.fields[2]?.value).toBe('2031-12');
    expect(one({ ...card, expMonth: 'Dec', expYear: '2031' })?.fields.slice(2, 4)).toEqual([
      { key: 'Expiry month', value: 'Dec' },
      { key: 'Expiry year', value: '2031' },
    ]);
  });

  it('reads an identity, city and country as extra fields', () => {
    expect(
      one({
        type: 'identity',
        title: 'Me',
        firstName: 'Ana',
        lastName: 'Lima',
        email: 'a@x.com',
        phone: '1',
        address: 'Rua 1',
        city: 'Recife',
        country: 'BR',
      })?.fields,
    ).toEqual([
      { key: 'First name', value: 'Ana', role: 'firstName' },
      { key: 'Last name', value: 'Lima', role: 'lastName' },
      { key: 'Email', value: 'a@x.com', role: 'email' },
      { key: 'Phone', value: '1', role: 'phone' },
      { key: 'Address', value: 'Rua 1', role: 'address' },
      { key: 'City', value: 'Recife' },
      { key: 'Country', value: 'BR' },
    ]);
  });

  it('reads a TOTP item as a TOTP category with an otpauth URI of its parameters', () => {
    expect(
      one({
        type: 'totp',
        title: 'GitHub 2FA',
        secret: 'JBSWY3DPEHPK3PXP',
        issuer: 'Git Hub',
        accountName: 'a@x.com',
        algorithm: 'SHA256',
        digits: 8,
        period: 60,
      }),
    ).toEqual({
      title: 'GitHub 2FA',
      category: 'TOTP',
      fields: [
        {
          key: 'TOTP',
          value:
            'otpauth://totp/Git%20Hub:a%40x.com?secret=JBSWY3DPEHPK3PXP&algorithm=SHA256&digits=8&period=60&issuer=Git+Hub',
        },
      ],
    });
    expect(one({ type: 'totp', title: 'T', secret: 'ABC' })?.fields[0]?.value).toBe(
      'otpauth://totp/?secret=ABC&algorithm=SHA1&digits=6&period=30',
    );
  });

  it('reads the three developer credential modes, and the legacy api_key type', () => {
    const base = { title: 'D', provider: 'AWS', environment: 'prod', baseUrl: 'https://aws.com' };
    expect(
      one({
        type: 'developer_credential',
        credentialMode: 'token',
        ...base,
        keyId: 'k',
        secret: 's',
      }),
    ).toEqual({
      title: 'D',
      template: 'developer-credential',
      fields: [
        { key: 'Provider', value: 'AWS', role: 'provider' },
        { key: 'Environment', value: 'prod' },
        { key: 'Base URL', value: 'https://aws.com', role: 'baseUrl' },
        { key: 'Key ID', value: 'k', role: 'keyId' },
        { key: 'Secret', value: 's', role: 'secret' },
      ],
    });
    expect(
      one({
        type: 'api_key',
        credentialMode: 'client_secret_pair',
        ...base,
        clientId: 'c',
        clientSecret: 's',
      })?.fields.slice(3),
    ).toEqual([
      { key: 'Client ID', value: 'c' },
      { key: 'Client secret', value: 's', role: 'secret' },
    ]);
    expect(
      one({
        type: 'developer_credential',
        credentialMode: 'ssh_key',
        title: 'S',
        privateKey: 'PRIV',
        publicKey: 'PUB',
        passphrase: 'pp',
        username: 'root',
        host: 'h',
        algorithm: 'ed25519',
        fingerprint: 'SHA256:x',
      })?.fields,
    ).toEqual([
      { key: 'Private key', value: 'PRIV', role: 'secret' },
      { key: 'Public key', value: 'PUB' },
      { key: 'Passphrase', value: 'pp' },
      { key: 'Username', value: 'root' },
      { key: 'Host', value: 'h' },
      { key: 'Algorithm', value: 'ed25519' },
      { key: 'Fingerprint', value: 'SHA256:x' },
    ]);
  });

  it('reads a BIP39 wallet, its phrase as the seed phrase', () => {
    expect(
      one({
        type: 'crypto_wallet',
        walletMode: 'bip39',
        title: 'W',
        mnemonic: 'abandon ability able',
        passphrase: 'p',
        walletName: 'Main',
        network: 'BTC',
        derivationPath: "m/44'/0'/0'",
        addressHint: 'bc1q',
        notes: null,
      })?.fields,
    ).toEqual([
      { key: 'Wallet name', value: 'Main', role: 'walletName' },
      { key: 'Network', value: 'BTC', role: 'network' },
      { key: 'Recovery phrase', value: 'abandon ability able', role: 'seedPhrase' },
      { key: 'Passphrase', value: 'p', role: 'passphrase' },
      { key: 'Derivation path', value: "m/44'/0'/0'", role: 'derivationPath' },
      { key: 'Address', value: 'bc1q', role: 'address' },
    ]);
  });

  it('refuses a file that is not a BlindPass plaintext export', () => {
    refused('{not json', 'not-this-format');
    refused('[]', 'not-this-format');
    refused(file([], { type: 'blindpass-export-encrypted' }), 'not-this-format');
    refused(JSON.stringify({ items: [] }), 'not-this-format');
    refused(file({}), 'not-this-format');
  });

  it('refuses a version other than 1', () => {
    refused(file([], { version: 2 }), 'unsupported-version');
    refused(file([], { version: '1' }), 'unsupported-version');
  });

  it('refuses the whole file for one invalid item, naming its index', () => {
    const ok = { type: 'secure_note', title: 'ok', content: '' };
    const bad: unknown[] = [
      null,
      { type: 'unknown', title: 't' },
      { type: 'login', username: 'u', password: 'p' },
      { type: 'login', title: 't', username: 'u', password: 1 },
      { type: 'login', title: 't', username: 'u', password: 'p', url: 5 },
      { type: 'login', title: 't', username: 'u', password: 'p', customFields: {} },
      { type: 'login', title: 't', username: 'u', password: 'p', customFields: ['x'] },
      { type: 'login', title: 't', username: 'u', password: 'p', customFields: [{ label: 'a' }] },
      { type: 'totp', title: 't', secret: 's', algorithm: 'MD5' },
      { type: 'totp', title: 't', secret: 's', digits: 9 },
      { type: 'totp', title: 't', secret: 's', period: 10.5 },
      { type: 'totp', title: 't', secret: 's', period: '30' },
      { type: 'developer_credential', title: 't', credentialMode: 'oauth', provider: 'p' },
      { type: 'crypto_wallet', title: 't', walletMode: 'xpub', mnemonic: 'm' },
    ];
    for (const item of bad) refused(file([ok, item]), 'invalid-item', 1);
  });
});
