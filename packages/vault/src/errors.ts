// Errors carry fixed messages only: never item content, a key or any other secret.

export class VaultError extends Error {
  override name = 'VaultError';
}

/** A Folder, Device or Local Config value fails `record-content.md` (verification failure). */
export class ContentInvalidError extends VaultError {
  override name = 'ContentInvalidError';
  constructor(readonly what: string) {
    super(`invalid content: ${what}`);
  }
}

/** No HLC can be issued: the HLC state is beyond the future-clock cap (D73). */
export class HlcReadOnlyError extends VaultError {
  override name = 'HlcReadOnlyError';
  constructor() {
    super('the device clock is behind its HLC state: the vault is read-only');
  }
}
