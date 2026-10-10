# Spike result — WebAuthn PRF (§5.5, D75, D84, D120)

Status: **in progress**. Samsung A54 (Chrome tab) measured; Windows Chrome cancelled at create, to
retry; the other devices pending.

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

## Pending

- A54 installed app; iPhone 14 (Safari, tab and installed app), MacBook Air M1 (Safari, Chrome,
  Firefox), Windows laptop (Chrome with Google Password Manager, Chrome with Bitwarden, Firefox).
