# Spike result — signal-less pairing (D4, D136)

Status: **go for D4** (see Conclusion). Desktop engines measured locally; Windows Firefox ↔ A54
by QR on the same Wi-Fi; Mac Chrome ↔ A54 across networks with STUN; iPhone ↔ A54 by QR on the
same Wi-Fi (LAN-only) and across networks (STUN); both installed apps by QR. D136 revised by D161;
the mDNS-only case moves to Phase 4.

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


## iPhone 14 Safari (A) ↔ Samsung A54 Chrome (B), QR, LAN-only (2026-10-12)

Round 1 of 4. Same Wi-Fi, LAN-only (no STUN), camera not granted on the iPhone before gathering.

| | iPhone 14 Safari 26.6 (A, offer) | A54 Chrome 155 (B, answer) |
| --- | --- | --- |
| Camera granted before gathering | no | yes (scanned first) |
| Candidates sent | 1 mDNS host | 1 IPv4 host, 1 IPv6 host (2 lines dropped) |
| Payload | 92 bytes, 138 chars, QR version 6 | 99 bytes, 149 chars, QR version 6 |
| Gathering | 120 ms | 144 ms |
| Scan time | 2.2 s, zxing-wasm (no native detector) | 3.0 s, native `BarcodeDetector` |
| Selected pair (local → remote) | mDNS host → host | IPv4 host → peer-reflexive |

- **Connected**; data-channel round trips of 6–24 ms.
- Safari on iOS has no `BarcodeDetector`; the WASM decoder read the A54's version 6 QR in 2.2 s.
- The A54 learned the iPhone's address as peer-reflexive, from the iPhone's connectivity checks,
  not by resolving its `.local` name: the connection works because the scanning side (B) sends a raw
  IP host candidate. Same pattern as Windows Firefox ↔ A54.
- The A54 dropped 2 candidate lines that the payload doesn't carry (TCP, or a type other than
  host and srflx); the spike doesn't log which.
- No prompt reported the page as hidden.

## Samsung A54 Chrome (A) ↔ iPhone 14 Safari (B), QR, LAN-only (2026-10-12)

Round 2 of 4. Same Wi-Fi, LAN-only (no STUN), camera not requested on the A54 before gathering.
Ran three times: right after round 1, after resetting the camera permission for the origin, and in
an incognito tab. All three connected the same way.

| | A54 Chrome 155 (A, offer) | iPhone 14 Safari 26.6 (B, answer) |
| --- | --- | --- |
| Camera granted before gathering | no | yes (scanned first) |
| Candidates sent | IPv4 host (first run also IPv6 host, 2 lines dropped) | 1 IPv4 host |
| Payload | 80 bytes, 120 chars, QR version 5 (first run 99 bytes, version 6) | 80 bytes, 120 chars, QR version 5 |
| Gathering | 127–132 ms | 51–94 ms |
| Scan time | 2.0–2.6 s, native `BarcodeDetector` | 0.45–1.5 s, zxing-wasm |
| Selected pair (local → remote) | IPv4 host → IPv4 host | host → host (Safari hides the addresses in stats) |

- **Connected** all three times; data-channel round trips of 6–18 ms.
- **Chrome on the A54 sent a raw IPv4 host candidate without the camera permission**, in an
  incognito tab too, so a permission kept from round 1 is not the cause. This contradicts D136's
  premise for this browser: Chrome on Android exposed the LAN address with no capture permission.
  Not checked on another Android device or Chrome version.
- Safari on iOS sent a raw IPv4 host candidate once the camera was granted, as D136 expects;
  without it (round 1) it sent an mDNS name.
- No side sent an mDNS name, so this round did not test the iPhone resolving one.

### What rounds 1 and 2 show for D136

In the QR flow the scanning side grants the camera before gathering, and both Chrome and Safari then
send a raw IP host candidate. Each connection so far used that raw IP, and the showing side's mDNS
name was never resolved (the peer saw it as peer-reflexive). So QR pairing on the same Wi-Fi does
not depend on mDNS resolution. A case where both sides send only mDNS names (copy/paste with no
camera, or a reconnection payload) is still untested on real devices.

Round 3 (iPhone as A with the camera granted before gathering) was skipped: round 2 already showed
Safari on iOS sending a raw IP host candidate once the camera is granted.

## iPhone 14 Safari (A, Wi-Fi) ↔ Samsung A54 Chrome (B, mobile data), QR, STUN (2026-10-12)

Round 4 of 4. Different networks: the A54 had Wi-Fi off. STUN on (Google and Cloudflare).

| | iPhone 14 Safari 26.6 (A, offer) | A54 Chrome 155 (B, answer) |
| --- | --- | --- |
| Camera granted before gathering | no | yes (scanned first) |
| Candidates sent | 1 mDNS host, 1 IPv4 srflx | 1 IPv4 host, 2 IPv6 host, 1 IPv4 srflx (3 lines dropped) |
| Payload | 99 bytes, 149 chars, QR version 6 | 125 bytes, 188 chars, QR version 8 |
| Gathering | 111 ms | 10,001 ms (the spike's 10 s cap) |
| Scan time | 0.63 s, zxing-wasm | 1.4 s, native `BarcodeDetector` |
| Selected pair (local → remote) | IPv4 srflx → IPv4 srflx | IPv4 srflx → IPv4 srflx |

- **Connected across NATs** through STUN alone, no relay; round trips of 50–62 ms.
- Same shape as Mac Chrome ↔ A54: the A54 on mobile data again hit the 10 s gathering cap, and its
  answer is again the largest payload, 125 bytes (QR version 8), which the iPhone read in 0.63 s
  with the WASM decoder.

## iPhone 14 installed app (A) ↔ Samsung A54 installed app (B), QR, LAN-only (2026-10-12)

Both sides in the installed app (`standalone: true`). Same Wi-Fi, LAN-only, camera not granted on
the iPhone before gathering.

| | iPhone 14, installed app (A, offer) | A54, Chrome installed app (B, answer) |
| --- | --- | --- |
| Camera granted before gathering | no | yes (scanned first) |
| Candidates sent | 1 mDNS host | 1 IPv4 host, 1 IPv6 host (2 lines dropped) |
| Payload | 92 bytes, 138 chars, QR version 6 | 99 bytes, 149 chars, QR version 6 |
| Scan time | 1.4 s, zxing-wasm | 0.67 s, native `BarcodeDetector` |
| Selected pair (local → remote) | host → host | IPv4 host → peer-reflexive |

- **Connected**; data-channel round trips of 6–18 ms.
- Camera QR scanning works in the installed app on iOS and Android, with the same decoders and the
  same candidate behavior as the browser tabs (round 1). No prompt reported the app as hidden.

## Conclusion (D4)

**Go.** Two phones, iOS Safari and Chromium Android, establish a DataChannel by exchanging only the
compact QR payloads, both on the same Wi-Fi in LAN-only mode and across networks through STUN, with
no signaling server. D4 stands.

- Largest payload measured: 125 bytes (QR version 8), under the original 200–300-byte estimate.
- Safari on iOS has no `BarcodeDetector`; the WASM decoder read every QR in 0.45–2.2 s.
- Gathering on mobile data never completes within 10 s; Phase 4 should stop once a srflx candidate
  arrives instead of waiting for `complete` (still to measure).
- D136 needs a revision (see "What rounds 1 and 2 show for D136"): Chrome on the A54 exposes raw IP
  host candidates without any capture permission, and QR pairing never depended on resolving an mDNS
  name. A pairing or reconnection where both sides send only mDNS names is untested on real devices.
