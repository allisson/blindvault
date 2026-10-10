# Spike result — signal-less pairing (D4, D136)

Status: **in progress**. Desktop engines measured locally; Windows Firefox ↔ A54 by QR on the same
Wi-Fi; Mac Chrome ↔ A54 across networks with STUN; iPhone and the installed apps pending.

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

## Windows Firefox (A) ↔ Samsung A54 Chrome (B), QR both ways (2026-10-10)

Same Wi-Fi, LAN-only (no STUN). Planned as copy/paste (README run 7), done with the cameras instead.

| | Windows Firefox 157 (A, offer) | A54 Chrome 155 (B, answer) |
| --- | --- | --- |
| Camera granted before gathering | no | yes (scanned first) |
| Candidates sent | 1 mDNS host | 1 IPv4 host, 1 IPv6 host |
| Payload | 104 bytes, 156 chars, QR version 7 | 99 bytes, 149 chars, QR version 6 |
| Scan time | 2.8 s, zxing-wasm (no native detector) | 2.2 s, native `BarcodeDetector` |
| Selected pair (local → remote) | mDNS host → IPv4 host | IPv4 host → peer-reflexive |

- **Connected**; data-channel round trips of 10–28 ms.
- Chrome on Android sent raw IP host candidates instead of mDNS because the camera permission was
  granted before gathering, as expected: scanning first reveals the LAN address to the other device.
- The laptop webcam read a version 6 QR from the phone screen in under 3 s with the WASM decoder.
- Windows reported `disconnected` by the time its result was copied, while the A54 still showed
  `connected`. The spike doesn't record why; the ping exchange had completed on both sides.
- Time to connect is not meaningful here (40 s on B, 154 s on A): it is dominated by the tester
  moving between devices.

## Mac Chrome (A, Wi-Fi) ↔ Samsung A54 Chrome (B, mobile data), QR, STUN (2026-10-10)

Different networks: the A54 had Wi-Fi off. STUN on (Google and Cloudflare).

| | Mac Chrome 155 (A, offer) | A54 Chrome 155 (B, answer) |
| --- | --- | --- |
| Candidates sent | 1 mDNS host, 1 IPv4 srflx | 1 IPv4 host, 2 IPv6 host, 1 IPv4 srflx |
| Payload | 99 bytes, 149 chars, QR version 6 | 125 bytes, 188 chars, QR version 8 |
| Gathering | 129 ms | 10,002 ms (the spike's 10 s cap) |
| Scan time | 5.9 s, native `BarcodeDetector` | 0.06 s, native `BarcodeDetector` |
| Selected pair (local → remote) | IPv4 srflx → IPv4 srflx | IPv4 srflx → IPv4 srflx |

- **Connected across NATs** through STUN alone, no relay; round trips of 58–78 ms.
- **Gathering on mobile data never reported complete:** the A54 waited the full 10 s cap. The
  spike doesn't record when the srflx candidate arrived, so how early gathering could stop is not
  measured. The product should not wait for `complete`; stopping once a srflx candidate arrives is
  the option to measure in Phase 4.
- The largest payload so far is 125 bytes (QR version 8), still under the original 200–300-byte
  estimate (§8.3).

