# Spike result — Safari storage (D55, D103, D105, D110)

Status: **in progress**. Day 0, D110 and D105 (iPhone tab) recorded; days 1, 4, 8 and 15 pending.

Day 0 was 2026-10-10. Follow-up days: 2026-10-11, 2026-10-14, 2026-10-18 and 2026-10-25. The site
is not opened on these devices between follow-ups.

## Devices

- iPhone 14, Safari 26.6.1 (the user agent reports `iPhone OS 18_7`).
- MacBook Air M1, Safari 26.6.2 (the user agent reports `Intel Mac OS X 10_15_7`).

Site build: `swVersion` 1, built 2026-10-10T00:09:19Z.

## Day 0 (2026-10-10)

| Context | Markers seen | `persist()` | `persisted` after | Quota (bytes) | Usage (bytes) |
| --- | --- | --- | --- | --- | --- |
| iPhone, Safari tab | own only | false | false | 41,231,686,042 | 339 |
| iPhone, Home Screen app | own only | true | true | 41,231,686,042 | 106,805 |
| Mac, Safari tab | own only | false | false | 82,463,372,084 | 321 |
| Mac, Dock app | own only | true | true | 82,463,372,084 | 327 |

- **D103 confirmed on both platforms:** the tab and the installed app don't share storage. Each sees
  only its own day-0 marker and its own visits.
- **Persistent storage:** granted to the installed app, refused to the tab, on both iOS and macOS,
  with no prompt.
- Quota is the same in the tab and the app on each device.
- The iPhone app's usage is about 300 times that of the other contexts. The iPhone tab reached
  106,563 bytes later on day 0, after the pairing page was opened in it, so the difference comes
  from what was loaded, not from tab versus app.

## D110 — same-device pairing on iPhone (2026-10-10)

Safari tab as A, Home Screen app as B, copy/paste, LAN-only. B decoded A's offer and produced its
answer (92 bytes, 138 base45 characters each, one mDNS host candidate). The run stopped there: going
back and forth between the two contexts on one phone, with copy and paste each way, was too hard for
the tester to finish. No connection state was recorded on either side.

- **D110 stands:** on iPhone, moving a tab's vault to the installed app goes through backup and
  restore, not pairing. Same-device pairing is not a path to offer even if it could connect.
- The first attempts failed because "Use pasted offer" was pressed with an empty box (the label
  suggested it read the clipboard); the spike's Paste buttons now read the clipboard.

## D105 — system UI and visibility (2026-10-10)

| Context | File picker | Camera prompt | WebAuthn prompt |
| --- | --- | --- | --- |
| iPhone, Safari tab | visible | visible | visible |

Each prompt was opened and cancelled; none reported the page as hidden. The other devices are not
measured yet.

## Pending

- D105 on the other devices (optional; the iPhone was the case D105 was written for).
- Days 1, 4, 8 and 15: whether each context still has its marker.
