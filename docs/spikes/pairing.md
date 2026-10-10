# Spike result — signal-less pairing (D4, D136)

Status: **in progress**. Desktop engines measured locally; phones, STUN and cameras pending.

## Local desktop run (2026-10-09)

Setup: MacBook Air M1, Playwright 1.63 (Chromium, Firefox, WebKit), two pages served from
`http://127.0.0.1:4174/pairing.html`, copy/paste, LAN-only (no STUN). Spike payload format:
`spikes/src/pairing/payload.ts` (version, flags, 8-byte session ID, 32-byte SHA-256 DTLS
fingerprint, ICE ufrag and pwd, UDP host and srflx candidates; mDNS names as 16-byte UUIDs).

| Run | Pairs connected | Offer / answer payload | base45 chars | QR version (M) |
| --- | --- | --- | --- | --- |
| mDNS candidates (browser default) | 9 / 9 | 92–104 bytes | 138–156 | 6–7 |
| mDNS disabled (IPv4 host candidates; WebKit keeps mDNS) | 9 / 9 | 80–92 bytes | 120–138 | 5–6 |

- Firefox payloads are 12 bytes longer than Chromium and WebKit: longer ICE credentials.
- Every pair used a UDP host candidate; WebKit often reports the remote side as `prflx`.
- Environment note: Playwright's Firefox gathers no ICE candidate on a page served as `localhost`
  (only on `127.0.0.1`); not seen in a normal Firefox yet, to check on the Windows laptop.

These numbers are below the original 200–300-byte estimate (§8.3) before any commitment or
capability bytes are added. No decision is revised until the device runs are in.
