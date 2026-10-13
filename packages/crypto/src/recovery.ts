// Recovery Phrase and Recovery KEK (crypto-spec.md §5, §5.1, D2, D16, D24). The phrase is BIP39
// encoding of 32 bytes of entropy only: the BIP39 PBKDF2 seed and passphrase are never used.

import { entropyToMnemonic, mnemonicToEntropy } from '@scure/bip39';
import { wordlist } from '@scure/bip39/wordlists/english.js';

import { PhraseRejectedError } from './errors';
import { KdfContext, deriveSubkey } from './kdf';
import { Keyring, type PrivateKey, type SymmetricKey, keyBytes } from './keys';
import { lib, randomBytes } from './sodium';

export const PHRASE_WORDS = 24;
const ENTROPY_LENGTH = 32;
const WORDS = new Set(wordlist);

export interface RecoveryPhrase {
  /** The 24 words, to show once. A JavaScript string cannot be wiped: drop it after use. */
  readonly words: string;
  readonly entropy: SymmetricKey;
}

/** A new phrase from 32 bytes of libsodium randomness. */
export function generateRecoveryPhrase(keyring: Keyring): RecoveryPhrase {
  const entropy = randomBytes(ENTROPY_LENGTH);
  const words = entropyToMnemonic(entropy, wordlist);
  return { words, entropy: keyring.adopt(entropy) };
}

/**
 * Parses a typed phrase: NFKD, lowercase, split on runs of Unicode `White_Space`. Anything but 24
 * words of the English list with a valid checksum is rejected before any derivation.
 */
export function parseRecoveryPhrase(keyring: Keyring, input: string): SymmetricKey {
  const words = input
    .normalize('NFKD')
    .toLowerCase()
    .split(/\p{White_Space}+/u)
    .filter((w) => w.length > 0);
  if (words.length !== PHRASE_WORDS) throw new PhraseRejectedError('word-count');
  const unknown = words.findIndex((w) => !WORDS.has(w));
  if (unknown >= 0) throw new PhraseRejectedError('unknown-word', unknown + 1);
  let entropy: Uint8Array;
  try {
    entropy = mnemonicToEntropy(words.join(' '), wordlist);
  } catch {
    throw new PhraseRejectedError('checksum');
  }
  return keyring.adopt(entropy);
}

export interface RecoveryKeys {
  /** `K_envelope`: wraps the Master Key in the Recovery Envelope. */
  readonly envelopeKey: SymmetricKey;
  readonly keyslotPublicKey: Uint8Array;
  /** Exists only while the phrase is in use (restore): release it right after. */
  readonly keyslotPrivateKey: PrivateKey;
}

/**
 * Entropy → Recovery KEK → `K_envelope` and the keyslot key pair. The Recovery KEK is used only
 * through its subkeys and is wiped before returning.
 */
export function deriveRecoveryKeys(keyring: Keyring, entropy: SymmetricKey): RecoveryKeys {
  const scratch = new Keyring();
  try {
    const kek = deriveSubkey(scratch, entropy, KdfContext.phrase, 1);
    const envelopeKey = deriveSubkey(keyring, kek, KdfContext.recoveryKek, 1);
    const seed = deriveSubkey(scratch, kek, KdfContext.recoveryKek, 2);
    const pair = lib().crypto_box_seed_keypair(keyBytes(seed));
    return {
      envelopeKey,
      keyslotPublicKey: pair.publicKey,
      keyslotPrivateKey: keyring.adoptPrivate(pair.privateKey),
    };
  } finally {
    scratch.wipeAll();
  }
}
