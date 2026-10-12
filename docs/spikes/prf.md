# Spike result — WebAuthn PRF (§5.5, D75, D84, D120)

Status: **done**. Measured on every browser of the matrix and in the installed apps on iOS and
Android; Bitwarden in Chrome on Windows is optional.

Setup: a throwaway passkey on the spike origin, `userVerification: required`, PRF evaluated with a
fixed 32-byte input at create and at get.

## Samsung A54, Chrome 155 (2026-10-10)

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works on the platform authenticator, and Chrome already returns the output at create, so
  setup needs no second prompt.
- BE and BS are set: the passkey is synced (Google Password Manager), so the PRF secret is available
  on the user's other devices signed in to the same account.
- Neither prompt reported the page as hidden (D105).
- `getClientCapabilities()` reports `extension:prf`, `signalUnknownCredential` and
  `signalAllAcceptedCredentials`.

## Windows laptop, Chrome 155 (2026-10-10)

`getClientCapabilities()` reports the same set as the A54, `extension:prf` included. Create failed
with `NotAllowedError` ("timed out or was not allowed"), so get had no credential to use. Cause: the
tester cancelled. The Bitwarden extension offered to save the passkey first, then Chrome offered
Google Password Manager; both were cancelled. A password-manager extension can take over the
WebAuthn prompt, so the product cannot assume which authenticator answers.

Retry, saved to Google Password Manager:

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

Same behavior as the A54: PRF works through Google Password Manager on Windows, with the output at
create and a stable output across assertions.

## Windows laptop, Firefox 157 (2026-10-10)

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | no | no | enabled, 32-byte output at create | no |
| get, twice | — | yes | no | no | 32-byte output, the same both times | no |

- PRF works. BE and BS are clear: the passkey is device-bound (Windows Hello), not synced, so its PRF
  secret exists only on this laptop.
- One earlier create attempt ended in `NotAllowedError` before the successful one.
- `getClientCapabilities()` reports `extension:prf`, but `signalUnknownCredential`,
  `signalAllAcceptedCredentials` and `conditionalCreate` are false: the product cannot rely on the
  signal API to clean up a stale passkey in Firefox.

## MacBook Air M1, Chrome 155, iCloud Keychain (2026-10-10)

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works with the passkey saved to iCloud Keychain from Chrome. BE and BS are set: synced through
  iCloud, so the PRF secret should reach the user's other Apple devices. Not checked: the test
  iPhone is signed in to a different Apple ID.

## MacBook Air M1, Firefox 157, iCloud Keychain (2026-10-10)

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works in Firefox with the passkey saved to iCloud Keychain, synced (BE and BS set), unlike
  Firefox on Windows, where the passkey stayed device-bound in Windows Hello.
- As on Windows, Firefox reports the signal API and `conditionalCreate` as unsupported.

## iPhone 14, Safari 26.6, iCloud Keychain (2026-10-12)

Safari tab. Bitwarden is enabled as a passkey provider on this iPhone and offered to save the
passkey first; saving there did not work. The passkey measured below was saved to iCloud Keychain.

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works in Safari on iOS, with the output at create and a stable output across assertions, the
  same behavior as Chrome on the A54.
- `getClientCapabilities()` reports `extension:prf`, `signalUnknownCredential`,
  `signalAllAcceptedCredentials`, `signalCurrentUserDetails` and `conditionalCreate`;
  `extension:largeBlob` is false.
- As with the extension on Windows, a third-party provider (Bitwarden) answers the WebAuthn prompt
  first on iOS too.
- The get used the passkey created in this session, so it does not show that the passkey created
  from Mac Chrome reaches the iPhone; that check needs both devices on the same Apple ID.

## MacBook Air M1, Safari 26.6, iCloud Keychain (2026-10-12)

Safari tab, passkey saved to iCloud Keychain.

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works in Safari on macOS, the same as on iOS, and `getClientCapabilities()` reports the same
  set as the iPhone (`extension:prf`, the signal API, `conditionalCreate`; no `largeBlob`).

## iPhone 14, installed app (Safari 26.6), iCloud Keychain (2026-10-12)

The installed app (`standalone: true`), passkey saved to iCloud Keychain.

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works in the installed app as in the Safari tab, with the same capabilities, and no prompt
  reported the app as hidden.

## Samsung A54, installed app (Chrome 155) (2026-10-12)

The installed app (`standalone: true`), passkey in Google Password Manager as in the tab.

| Step | Attachment | UV | BE | BS | PRF | Page hidden |
| --- | --- | --- | --- | --- | --- | --- |
| create | platform | yes | yes | yes | enabled, 32-byte output at create | no |
| get, twice | — | yes | yes | yes | 32-byte output, the same both times | no |

- PRF works in the installed app as in the Chrome tab. `getClientCapabilities()` reports
  `extension:prf` and the signal API, and, unlike Safari, `extension:largeBlob`.

## Conclusion

PRF works on every browser of the matrix (Chromium desktop and Android, Firefox desktop, Safari on
macOS and iOS) and in the installed apps on iOS and Android, with a 32-byte output at create and a
stable output across assertions. Every passkey was synced (BE and BS set) except Windows Hello in
Firefox, which is device-bound. A third-party provider (Bitwarden) can take the prompt first, on
Windows and on iOS, so the product cannot assume which authenticator answers.

## Pending

- Optional: Windows laptop, Chrome with Bitwarden.
- Why the Bitwarden save failed on iOS (error not captured), optional.
