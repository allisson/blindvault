# Browser matrix (Security Gate)

The browsers and capabilities of overview §18, with what proves each one works in BlindVault itself.
The Security Gate box "Browser matrix tested and recorded" closes once no cell reads **to check**.

## Sources

- **auto:** the Playwright suite on the build named below, in Playwright's own engines. It proves
  the app's code path, not the shipped browser: Playwright's WebKit is not Safari, and its camera
  and authenticator are fakes.
- **app vX:** the app itself, by hand on a real device, at that version (D212).
- **spike:** a Phase 0 throwaway page on the real browser, not the app (`docs/spikes/`).
- **to check:** still to run by hand on the device (below).

## Automated run

| | |
| --- | --- |
| Commit | `d02981e` |
| App | 0.7.3 |
| Playwright | 1.63.0, on macOS 26.6.2 (MacBook Air M1) |
| Engines | Chromium 153.0.8010.12, Firefox 155.0, WebKit 26.6 |
| Date | 2026-11-13 |
| Result | `packages/sync` 36 passed; `apps/web` 592 passed, 23 skipped, 0 failed |

The 23 skips, by design: the opt-in load and large-backup specs (2 × 3 engines); the passkey specs
and the passkey recommendation in onboarding in Firefox and WebKit (7 × 2, Chromium-only virtual
authenticator); the coarse-pointer layout in Firefox and WebKit (2, Chromium-only touch emulation);
offline use in WebKit (1, `pwa.spec.ts`).

## Matrix

| Capability | Chromium desktop | Firefox desktop | Safari macOS | Safari iOS | Chromium Android |
| --- | --- | --- | --- | --- | --- |
| IndexedDB | auto; app v0.3.0 | auto | auto (WebKit); to check | app v0.3.0; to check | app v0.3.0; to check |
| Persistent storage | spike; to check | to check | spike; to check | spike; to check | spike; to check |
| DataChannel | auto; app v0.3.0 | auto | auto (WebKit); to check | app v0.3.0; to check | app v0.3.0; to check |
| WebAuthn | auto (virtual); to check | spike; to check | spike; to check | spike; to check | spike; to check |
| WebAuthn PRF | auto (virtual); spike; to check | spike; to check | spike; to check | spike; to check | spike; to check |
| PWA installation | auto (manifest); to check | to check | spike (Dock); to check | app v0.3.0; to check | spike; to check |
| Camera | auto (fake); app v0.3.0 | auto (fake) | auto (WebKit, fake); to check | app v0.3.0; to check | app v0.3.0; to check |
| QR scanning | auto (fake); app v0.3.0 | auto (fake) | auto (WebKit, fake); to check | app v0.3.0; to check | app v0.3.0; to check |

What each source covers:

- **auto.** IndexedDB: every spec that creates a vault. DataChannel: `pairing.spec.ts`,
  `sync.spec.ts`, `pairing-stun.spec.ts`. Camera and QR: `pairing-qr.spec.ts`, with a fake camera
  showing the other side's QR. WebAuthn and PRF: `passkey.spec.ts`, Chromium only, with the CDP
  virtual authenticator. PWA: `pwa.spec.ts` checks the manifest, the cache and offline use
  (offline skipped in WebKit), not an install. Persistent storage: `storage-state.spec.ts` drives a
  stubbed `navigator.storage`, so it tests the UI, not the browser.
- **app v0.3.0 (D212).** iPhone 14 installed app (iOS 26.6.2) ↔ Galaxy A54 Chrome 155 tab, QR by
  camera both ways; MacBook Air M1 Chrome 155 tab restored a 42,003-record vault and paired it into
  each phone by QR.
- **spike.** `prf.md`: PRF works on every browser of the matrix and in the installed apps on iOS and
  Android. `storage.md`: `persist()` refused to tabs and granted to installed apps on the Mac (Safari
  Dock app), the iPhone and the A54. `pairing.md`: DataChannel, camera and QR on every phone pair.

## To check by hand

On the release candidate, in each context: Chromium desktop, Firefox desktop, Safari macOS (tab and
Dock app), Safari iOS (installed app), Chrome Android (tab and installed app). Record the browser
version and the result in the matrix.

1. **Install** the app where the browser offers it, and open it.
2. **Create a vault**, lock, unlock: IndexedDB.
3. **Settings › This device:** whether storage reads "kept" (persistent storage).
4. **Set up a passkey** with the platform authenticator, lock, unlock with it: WebAuthn and PRF.
5. **Pair with another device by QR** with the camera: camera, QR scanning and DataChannel.
6. **Sync** once with the paired device.

A capability a browser lacks must degrade as the overview says, with the app's own message: record
the message as the result.
