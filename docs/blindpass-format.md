# BlindPass Export Format

> The input BlindVault reads to import from BlindPass (overview §15, D123, D126). BlindPass defines
> this format, not BlindVault: this document records it as BlindPass writes it, from
> `packages/vault/src/export/index.ts`, `packages/vault/src/item/schema.ts` and
> `packages/crypto/src/lib/{kdf,symmetric,random}.ts` in the BlindPass source. `overview.md`
> prevails on what BlindVault does with it.

BlindPass exports items only: no collections, folders, tags, history or attachments (D123). It
writes two files, both UTF-8 JSON:

| File | `type` | Content |
| --- | --- | --- |
| `blindpass-export-<vault>.json` | `blindpass-export` | The items in the clear |
| `blindpass-export-<vault>.blindpass` | `blindpass-export-encrypted` | The `.json` file, encrypted under a passphrase |

The file name is not part of the format: BlindVault tells the two apart by `type`, never by the
extension.

## 1. Plaintext export (`.json`)

```json
{
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
}
```

| Key | Value |
| --- | --- |
| `version` | The number `1`. Any other value is an unsupported version. |
| `type` | The string `blindpass-export`. |
| `exportedAt` | ISO 8601 time of the export. Informational: BlindPass does not read it back. |
| `items` | Array of items (section 3). |

BlindPass writes it with `JSON.stringify(payload, null, 2)`; whitespace carries no meaning.

## 2. Encrypted export (`.blindpass`)

```json
{"version":1,"type":"blindpass-export-encrypted","kekSalt":"…","nonce":"…","ciphertext":"…"}
```

| Key | Value |
| --- | --- |
| `version` | The number `1`. |
| `type` | The string `blindpass-export-encrypted`. |
| `kekSalt` | Base64 of the 16-byte Argon2id salt (`crypto_pwhash_SALTBYTES`). |
| `nonce` | Base64 of the 24-byte nonce (`crypto_secretbox_NONCEBYTES`). |
| `ciphertext` | Base64 of `crypto_secretbox_easy(plaintext, nonce, key)`: the MAC (16 bytes) followed by the encrypted plaintext. |

Base64 is the standard alphabet with padding (`btoa`, RFC 4648 §4).

**Key.** `key = crypto_pwhash(32, passphrase, kekSalt, opslimit, memlimit, crypto_pwhash_ALG_ARGON2ID13)`,
the passphrase as its UTF-8 bytes, with libsodium's `SENSITIVE` limits:

| Parameter | Value |
| --- | --- |
| `opslimit` | `crypto_pwhash_OPSLIMIT_SENSITIVE` = 4 |
| `memlimit` | `crypto_pwhash_MEMLIMIT_SENSITIVE` = 1,073,741,824 bytes (1 GiB) |
| Output | 32 bytes (`crypto_secretbox_KEYBYTES`) |

The file stores neither limit: BlindPass fixes them in code, so BlindVault holds them as constants
and never reads them from the file (D126).

**Plaintext.** `crypto_secretbox_open_easy` returns the UTF-8 bytes of a plaintext export (section
1), the same JSON BlindPass writes to a `.json` file. A failed MAC means a wrong passphrase or a
damaged file; the two cannot be told apart.

## 3. Items

Each item is a JSON object discriminated by `type`. Every type has `title` and an optional
`customFields`, an array of `{ "label": string, "value": string }`. A key marked `?` is optional; the
others are required.

| `type` | Keys |
| --- | --- |
| `login` | `title`, `username`, `password`, `url?`, `notes?` |
| `secure_note` | `title`, `content` |
| `payment_card` | `title`, `cardholderName`, `number`, `expMonth`, `expYear`, `cvv?`, `notes?` |
| `identity` | `title`, `firstName`, `lastName`, `email?`, `phone?`, `address?`, `city?`, `country?`, `notes?` |
| `totp` | `title` (non-empty), `secret` (non-empty; BlindPass does not check that it is base32), `issuer?`, `accountName?`, `algorithm?` (`SHA1`, `SHA256` or `SHA512`; absent means `SHA1`), `digits?` (integer 6 to 8; absent means 6), `period?` (integer 15 to 300 seconds; absent means 30), `notes?` |
| `developer_credential` | `title`, `notes?` and one `credentialMode` (below) |
| `crypto_wallet` | `title`, `walletMode: "bip39"`, `mnemonic` (12, 15, 18, 21 or 24 words), `passphrase?`, `walletName?`, `network?`, `derivationPath?` (`m/…`, e.g. `m/44'/0'/0'/0`), `addressHint?` (at most 20 characters), `notes?` |

`developer_credential` modes:

| `credentialMode` | Keys |
| --- | --- |
| `token` | `provider` (non-empty), `environment?`, `baseUrl?` (URL), `secret` (non-empty), `keyId?` |
| `client_secret_pair` | `provider` (non-empty), `environment?`, `baseUrl?` (URL), `clientId` (non-empty), `clientSecret` (non-empty) |
| `ssh_key` | `privateKey`, `publicKey`, `username`, `host` (all non-empty), `passphrase?`, `algorithm?`, `fingerprint?`, with at least one of `algorithm` and `fingerprint` |

**Legacy type.** Older BlindPass exports name `developer_credential` `api_key`; BlindPass reads
`api_key` as `developer_credential`.

**Blank optionals.** For `baseUrl` and the optional string keys of `ssh_key` and `crypto_wallet`,
BlindPass treats a blank or whitespace-only string as absent.

**A TOTP is its own item.** BlindPass stores a TOTP as a separate `totp` item, not as a field of the
login it belongs to; BlindVault imports it as a `totp` field under D124.

**Validation.** BlindPass rejects the whole file when the JSON does not parse, `type` or `version`
does not match, `items` is not an array or any item does not match its type. BlindVault rejects
such a file the same way, with a message the user can read (overview §15).
