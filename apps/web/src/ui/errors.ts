import { ContentInvalidError, VaultLockedError } from '@blindvault/vault';

import { type Messages } from '../i18n/messages';

/** The message for a write the session refused; a lock is not an error the user needs to read. */
export function writeError(error: unknown, m: Messages): string | undefined {
  if (error instanceof VaultLockedError) return undefined;
  if (error instanceof ContentInvalidError) {
    return error.what === 'item cap' ? m.items.tooLarge : m.items.invalid;
  }
  return m.items.blocked;
}
