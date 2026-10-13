import { beforeAll, describe, expect, it } from 'vitest';

import { PhraseRejectedError } from './errors';
import { Keyring, adoptKey, keyBytes, privateKeyBytes } from './keys';
import {
  PHRASE_WORDS,
  deriveRecoveryKeys,
  generateRecoveryPhrase,
  parseRecoveryPhrase,
} from './recovery';
import { initCrypto, lib } from './sodium';
import { fromHex, toHex, vectors } from './test-helpers';

beforeAll(initCrypto);

const bip39 = vectors.bip39;
const reasons: Record<string, string> = {
  'bad checksum': 'checksum',
  '23 words': 'word-count',
  'word not in list': 'unknown-word',
};

describe('Recovery Phrase (crypto-spec.md §5.1, D2)', () => {
  it('parses the vector mnemonic to its entropy', () => {
    const keyring = new Keyring();
    expect(toHex(keyBytes(parseRecoveryPhrase(keyring, bip39.mnemonic)))).toBe(bip39.entropy);
  });

  it('accepts uppercase, tabs, newlines and runs of whitespace', () => {
    const keyring = new Keyring();
    expect(toHex(keyBytes(parseRecoveryPhrase(keyring, bip39.acceptedInput)))).toBe(bip39.entropy);
    const nbsp = bip39.mnemonic.split(' ').join(' 　');
    expect(toHex(keyBytes(parseRecoveryPhrase(keyring, nbsp)))).toBe(bip39.entropy);
  });

  it.each(bip39.rejectedInput)('rejects $case before any derivation', ({ case: name, input }) => {
    const keyring = new Keyring();
    expect(() => parseRecoveryPhrase(keyring, input)).toThrow(
      expect.objectContaining({ name: 'PhraseRejectedError', reason: reasons[name] }),
    );
    expect(keyring.size).toBe(0);
  });

  it.each([
    [1, 'zzz'],
    [7, 'Zebrax'],
    [24, 'abandonn'],
  ])('names position %i of the first word not in the list, not the word', (position, word) => {
    const words = bip39.mnemonic.split(' ');
    words[position - 1] = word;
    if (position === 1) words[5] = 'qqq';
    const thrown = (() => {
      try {
        parseRecoveryPhrase(new Keyring(), words.join(' '));
      } catch (error) {
        return error;
      }
      return undefined;
    })();
    expect(thrown).toMatchObject({ reason: 'unknown-word', position });
    expect((thrown as Error).message).not.toContain(word.toLowerCase());
  });

  it('gives no position for the other reasons', () => {
    for (const { input } of bip39.rejectedInput) {
      try {
        parseRecoveryPhrase(new Keyring(), input);
      } catch (error) {
        const e = error as PhraseRejectedError;
        if (e.reason !== 'unknown-word') expect(e.position).toBeUndefined();
      }
    }
  });

  it.each([
    ['empty input', ''],
    ['25 words', `${bip39.mnemonic} trust`],
    ['a 12-word phrase', bip39.mnemonic.split(' ').slice(0, 12).join(' ')],
  ])('rejects %s', (_name, input) => {
    expect(() => parseRecoveryPhrase(new Keyring(), input)).toThrow(PhraseRejectedError);
  });

  it('generates 24 words from 32 random bytes that parse back to the same entropy', () => {
    const keyring = new Keyring();
    const phrase = generateRecoveryPhrase(keyring);
    expect(phrase.words.split(' ')).toHaveLength(PHRASE_WORDS);
    const parsed = parseRecoveryPhrase(keyring, phrase.words);
    expect(lib().memcmp(keyBytes(parsed), keyBytes(phrase.entropy))).toBe(true);
    expect(generateRecoveryPhrase(keyring).words).not.toBe(phrase.words);
  });
});

describe('Recovery KEK chain (crypto-spec.md §5, D2, D16)', () => {
  it('reproduces K_envelope and the keyslot key pair from the entropy', () => {
    const keyring = new Keyring();
    const keys = deriveRecoveryKeys(keyring, adoptKey(keyring, fromHex(bip39.entropy)));
    expect(toHex(keyBytes(keys.envelopeKey))).toBe(bip39.envelopeKey);
    expect(toHex(keys.keyslotPublicKey)).toBe(bip39.keyslotPublicKey);
    expect(toHex(keys.keyslotPublicKey)).toBe(vectors.kdf.keyslotKeyPair.publicKey);
    expect(toHex(privateKeyBytes(keys.keyslotPrivateKey))).toBe(
      vectors.kdf.keyslotKeyPair.secretKey,
    );
  });

  it('keeps neither the Recovery KEK nor the keyslot seed', () => {
    const keyring = new Keyring();
    const entropy = adoptKey(keyring, fromHex(bip39.entropy));
    const keys = deriveRecoveryKeys(keyring, entropy);
    // entropy, K_envelope and the keyslot private key; nothing else was added.
    expect(keyring.size).toBe(3);
    keyring.release(keys.keyslotPrivateKey);
    expect(() => privateKeyBytes(keys.keyslotPrivateKey)).toThrow();
  });
});
