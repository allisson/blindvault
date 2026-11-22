// What a Keystore KEK prompt that opened nothing says (android.md §5, D292). In the Android app it
// is the only alternative to the local password, so a re-authentication's failures are its own.

import { type Messages } from '../i18n/messages';

export function keystoreError(m: Messages, outcome: string): string | undefined {
  switch (outcome) {
    case 'cancelled':
      return m.keystore.cancelled;
    case 'rejected':
      return m.keystore.rejected;
    case 'unavailable':
      return m.keystore.unavailable;
    case 'invalidated':
      return m.keystore.removedInvalidated;
    default:
      return undefined;
  }
}
