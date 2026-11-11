// Reading an import file (overview §15, D123, D125, D130, D146): the source the user names picks
// the parser. The file stays in memory and is only mapped here; nothing derived from it is stored.

import {
  BlindPassRejectedError,
  DecryptionError,
  type KdfPort,
  KdfWorkerError,
  openBlindPassExport,
} from '@blindvault/crypto';
import {
  ImportRejectedError,
  type ImportRejection,
  type MappedImport,
  type SourceParse,
  mapImport,
  parseApplePasswordsCsv,
  parseBitwardenJson,
  parseBlindPassExport,
  parseChromeCsv,
  parseDashlaneExport,
  parseKeePassXcCsv,
  parseLastPassCsv,
  parseOnePasswordExport,
  parseProtonPassJson,
  parseProtonPassZip,
} from '@blindvault/vault';

/** Product names, untranslated: the picker and the landing folder's name show them. */
export const IMPORT_SOURCES = {
  blindpass: { name: 'BlindPass', accept: '.json,.blindpass' },
  bitwarden: { name: 'Bitwarden', accept: '.json' },
  protonpass: { name: 'Proton Pass', accept: '.json,.zip' },
  onepassword: { name: '1Password', accept: '.1pux' },
  dashlane: { name: 'Dashlane', accept: '.zip' },
  chrome: { name: 'Chrome', accept: '.csv' },
  lastpass: { name: 'LastPass', accept: '.csv' },
  apple: { name: 'Apple Passwords', accept: '.csv' },
  keepassxc: { name: 'KeePassXC', accept: '.csv' },
} as const;

export type ImportSource = keyof typeof IMPORT_SOURCES;

/** Any import file above it is rejected before parsing (D130). */
export const MAX_IMPORT_SIZE = 100 * 1024 * 1024;

export type ImportRead =
  | { readonly kind: 'ok'; readonly mapped: MappedImport }
  /** An encrypted `.blindpass` export: read it again with its passphrase. */
  | { readonly kind: 'passphrase' }
  | { readonly kind: 'wrong-passphrase' }
  /** The Argon2id worker failed, at 1 GiB of memory (D126). */
  | { readonly kind: 'kdf-failed' }
  | { readonly kind: 'rejected'; readonly reason: ImportRejection; readonly item?: number };

function text(bytes: Uint8Array): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new ImportRejectedError('not-this-format');
  }
}

function isEncryptedBlindPass(raw: string): boolean {
  try {
    const data: unknown = JSON.parse(raw);
    return (
      typeof data === 'object' &&
      data !== null &&
      (data as Record<string, unknown>).type === 'blindpass-export-encrypted'
    );
  } catch {
    return false;
  }
}

function parse(source: Exclude<ImportSource, 'blindpass'>, bytes: Uint8Array): SourceParse {
  switch (source) {
    case 'bitwarden':
      return parseBitwardenJson(text(bytes));
    case 'protonpass':
      // A zip starts with `PK`.
      return bytes[0] === 0x50 && bytes[1] === 0x4b
        ? parseProtonPassZip(bytes)
        : parseProtonPassJson(text(bytes));
    case 'onepassword':
      return parseOnePasswordExport(bytes);
    case 'dashlane':
      return parseDashlaneExport(bytes);
    case 'chrome':
      return parseChromeCsv(text(bytes));
    case 'lastpass':
      return parseLastPassCsv(text(bytes));
    case 'apple':
      return parseApplePasswordsCsv(text(bytes));
    case 'keepassxc':
      return parseKeePassXcCsv(text(bytes));
  }
}

/**
 * Parses and maps a source file. An encrypted `.blindpass` export asks for its passphrase first,
 * then derives its key in the worker at BlindPass's fixed parameters (D126).
 */
export async function readImport(
  source: ImportSource,
  bytes: Uint8Array,
  passphrase: string | undefined,
  kdf: () => KdfPort,
): Promise<ImportRead> {
  if (bytes.length > MAX_IMPORT_SIZE) return { kind: 'rejected', reason: 'too-large' };
  try {
    if (source !== 'blindpass') return { kind: 'ok', mapped: mapImport(parse(source, bytes)) };
    const raw = text(bytes);
    if (!isEncryptedBlindPass(raw))
      return { kind: 'ok', mapped: mapImport(parseBlindPassExport(raw)) };
    if (passphrase === undefined) return { kind: 'passphrase' };
    const json = await openBlindPassExport(kdf(), raw, passphrase);
    return { kind: 'ok', mapped: mapImport(parseBlindPassExport(json)) };
  } catch (error) {
    if (error instanceof ImportRejectedError || error instanceof BlindPassRejectedError) {
      const item = error instanceof ImportRejectedError ? error.item : undefined;
      return { kind: 'rejected', reason: error.reason, ...(item !== undefined ? { item } : {}) };
    }
    if (error instanceof DecryptionError) return { kind: 'wrong-passphrase' };
    if (error instanceof KdfWorkerError) return { kind: 'kdf-failed' };
    throw error;
  }
}
