# Phase 0 spikes — protocol

Throwaway measurement pages in `spikes/`, published to `https://allisson.github.io/blindvault/` by
the `Spikes (GitHub Pages)` workflow. They hold no vault data and make no network call apart from
STUN in the pairing spike. Each page ends with a JSON result and a **Copy result** button: paste it
in the conversation, and the result goes to `docs/spikes/<spike>.md` with any `Dn` revision.

The spike origin is a shared `github.io` origin, not the product's dedicated origin (D90). That is
acceptable for throwaway code holding no real data.

Device matrix (overview §18): Windows laptop (Chrome or Edge, Firefox), MacBook Air M1 (Safari,
Chrome, Firefox), Samsung A54 (Chrome), iPhone 14 (Safari).

Local runs: `pnpm --filter @blindvault/spikes dev` serves the pages on the LAN; camera, WebAuthn and
service workers need HTTPS or `localhost`, so phones use the Pages site.

## 1. Signal-less pairing (D4, D136) — `pairing.html`

Already measured locally (desktop engines, `127.0.0.1`, copy/paste, no STUN): every A × B pair of
Chromium, Firefox and WebKit connects, with and without mDNS candidates; payloads of 80–104 bytes,
120–156 base45 characters, QR version 5–7 (error correction M). See `pairing.md`.

| # | Setup | Mode | Measures |
| --- | --- | --- | --- |
| 1 | Mac Safari tab A ↔ Mac Chrome tab B | copy/paste, LAN-only | baseline on real browsers |
| 2 | iPhone (A) ↔ A54 (B), same Wi-Fi | QR both ways, LAN-only, camera not granted before gathering on A | mDNS on same Wi-Fi |
| 3 | same as 2 | "Grant camera before gathering" on both | IP host candidates instead of mDNS |
| 4 | same as 2 | QR, STUN on | srflx candidates, QR size |
| 5 | iPhone on Wi-Fi ↔ A54 on 4G (Wi-Fi off) | QR, STUN on | NAT traversal across networks |
| 6 | 2 and 5 again from the **installed** app on both phones | QR | camera scanning in the installed PWA |
| 7 | Windows Firefox ↔ A54 | copy/paste through any messaging app | cross-engine, copy/paste fallback |

Copy the result from **both** devices after each run, success or failure.

## 2. Argon2id (D9, D126) — `argon2id.html`

On every device of the matrix: button 1, then button 2, copy the result. Then button 3 (1 GiB) on
its own, and copy again; if the tab reloads or crashes, say so. Keep the screen on.

## 3. WebAuthn PRF — `prf.html`

On every device: button 1, then button 2 twice, copy the result. Delete the "BlindVault spike"
passkey afterwards. On the phones, repeat from the installed app.

## 4. Browser storage (D55, D103, D105, D110) — `storage.html`

Devices: MacBook Air M1 (Safari) and Samsung A54 (Chrome, the control). The iPhone run of
2026-10-10 was discarded.

1. **Day 0, Mac and A54:** open the page in a browser tab, press "Write day-0 marker" and "Request
   persistent storage", copy the result. Install the app (macOS Safari: File → Add to Dock; Android
   Chrome: menu → Add to Home screen → Install), open the page there, do the same, copy the result.
   Whether each context sees the other's marker answers D103. "Write day-0 marker" replaces an older
   marker of the same context.
2. **Days 1, 4, 8 and 15:** do not open the site on these two browsers in between (any page of
   `allisson.github.io` counts as a visit). On each day, open the page in each of the four contexts
   and copy the result: a missing marker means the browser deleted the storage.

Gate 0 can close on day 15 at the earliest.

## 5. Service-worker integrity (D63, D142) — `sw.html`

Per browser of the matrix (installed app too on the phones):

1. With the site at `swVersion = N`, open `sw.html` and leave it open.
2. A new deploy with `swVersion = N+1` (`swTakeover = true`) is run from the workflow.
3. Without reloading, press "Check for update" every minute for up to 5 minutes, then copy the
   result. It records whether `updatefound` fired and when, whether the new worker's install ran
   while the page was open, and whether `controllerchange` shows a takeover.
4. Optionally repeat with `swTakeover = false` to see when the new worker activates on its own.
