# Spike result — browser extension (D267, D281)

Status: **done** (D282). Measured on the MacBook Air M1 only, in Chrome 158 and Firefox 160, on
2026-11-21. The Windows laptop was not run, a limit D282 records.

Setup: the unpacked MV3 extension of `spikes/extension/` (`docs/spikes/README.md` §6), each browser
on a throwaway profile. Chrome loaded it through the DevTools protocol (`Extensions.loadUnpacked`,
since Chrome 158 no longer accepts `--load-extension`) and Firefox as a temporary add-on through
WebDriver BiDi, with a fixed `moz-extension` UUID. Scripts over the DevTools protocol and BiDi
clicked the spike pages; the Touch ID prompts and the macOS prompt of measure 3 were answered by
hand. Extension IDs: `ddgdiedbdcpldankhmieolobnpkiafaa` (Chrome) and
`6b1e2f0a-5d3c-4c8e-9a7b-1f2e3d4c5b6a` (Firefox).

## 1. Session host

A throwaway key unlocked in the host, its fingerprint recorded, the browser window minimized, no
script attached for 60 minutes, then the fingerprint read again.

| Browser | Host | `chrome.offscreen` | After 60 min | Pass |
| --- | --- | --- | --- | --- |
| Chrome 158 | offscreen document | present | same key at 60.2 min; the service worker stopped from minute 5 on, the offscreen document present throughout | yes |
| Firefox 160 | MV3 event page | absent | unloaded before its first heartbeat at 1 min: key lost | no |
| Firefox 160 | extension tab (fallback) | absent | same key at 60.1 min | yes |

- A sleeping machine was not measured.
- On Chrome, the service worker's state was read from the DevTools target list every 5 minutes,
  without attaching to it.

## 2. The `apps/web` build

| Browser | Context | First screen | Console errors | Argon2id calibration | Notes |
| --- | --- | --- | --- | --- | --- |
| Chrome 158 | extension tab | yes | none | 3,926 ms, opslimit 28, 64 MiB | `indexedDB.databases()` empty; the app registers its service worker in the extension origin (1 registration, page controlled) |
| Chrome 158 | offscreen document | — | — | 3,918 ms, opslimit 28, 64 MiB | |
| Firefox 160 | extension tab | yes | none | 6,667 ms, opslimit 23, 64 MiB | `navigator.serviceWorker` does not exist on `moz-extension:` |
| Firefox 160 | event page | — | — | 5,614 ms, opslimit 23, 64 MiB | |

- libsodium loads under the MV3 CSP with `'wasm-unsafe-eval'` in every context.
- Port: the service worker is web-only. Chrome registers it in the extension origin, and Firefox
  has none there.

## 3. Interception on the local relying party

`http://localhost:5310/` with a cross-origin iframe on `http://localhost:5311/`.

| Check | Chrome 158 | Firefox 160 |
| --- | --- | --- |
| Override before the page's code | yes, top frame and iframe | yes, top frame and iframe |
| Origin taken from `MessageSender` | yes (`origin` field), top frame and iframe | yes, top frame and iframe |
| Iframe `clientData` | `crossOrigin: true`, `topOrigin: http://localhost:5310` | same |
| Message forged by the page (`claimedOrigin: https://bank.example`) | ignored: the page got `SecurityError` | same |
| "Another authenticator" | handed to Chrome's WebAuthn, answered by a virtual authenticator (BE and BS false, valid signature) | handed to Firefox: the macOS passkey prompt opened and registered (UP, UV, BE, BS set); the log shows `outcome: browser` |

Under automation, Firefox's hand-back first failed with `NotAllowedError: CredentialsContainer
request is not allowed`, most likely because the confirm window had taken the focus; the run by
hand passed.

## 4. `webauthn.io`

A throwaway in-memory ES256 credential (attestation `none`, UP, UV, BE and BS set), a random user
name, register then authenticate.

| Check | Chrome 158 | Firefox 160 |
| --- | --- | --- |
| Register and sign in | yes ("You're logged in!") | yes |
| `instanceof PublicKeyCredential` | true | true |
| `getClientExtensionResults()` | `credProps.rk: true` | same |
| `toJSON()` | `authenticatorAttachment`, `clientExtensionResults`, `id`, `rawId`, `response`, `type` | same |

The `webauthn.io` credentials expire on their own after 24 hours.

## 5. WebAuthn PRF from an extension tab

A credential created with `prf.eval`, Touch ID, `userVerification: required`.

| Browser | create | get #1 | get #2 | get after a browser restart | `rpId` |
| --- | --- | --- | --- | --- | --- |
| Chrome 158 | `prf.enabled`, output `53490c1e…` | same | same | same | the extension ID |
| Firefox 160 | `SecurityError: The operation is insecure.`, no prompt | — | — | — | would be the UUID |

- Chrome: the same output all four times, so the Chrome extension can offer an unlock passkey. A
  virtual authenticator gave the same result before the Touch ID run.
- Firefox refuses WebAuthn on a `moz-extension:` page, whether the tab was opened by the
  automation or from the popup's link. The Firefox extension unlocks by password only (D281).

## 6. Storage and clipboard in the session host

| Check | Chrome 158 (offscreen document) | Firefox 160 (event page) |
| --- | --- | --- |
| IndexedDB marker survives a reload of the extension as an update | yes | yes |
| `navigator.storage.persist()` | false | true |
| Web Locks | acquired | acquired |
| `RTCPeerConnection` DataChannel to an extension tab | `pong:ping` | `pong:ping` |
| Popup copies, host clears after 10 s | cleared, through `execCommand('copy')`; `writeText` fails with `Document is not focused` | cleared, through `writeText` |

On Chrome, reloading an extension loaded through the DevTools protocol disabled it until developer
mode was turned on; this comes from the way the spike was loaded, not from the extension.

## Cleanup

The throwaway profiles hold the PRF credential and are deleted with the spike. The registration of
measure 3's hand-back on Firefox left a `localhost` passkey in the iCloud Keychain, deleted by hand.
