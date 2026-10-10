# Spike result — Safari storage (D55, D103, D105, D110)

Status: **in progress**. Day 0 recorded; D110 (same-device pairing), D105 (system UI) and days 1, 4,
8 and 15 pending.

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
- The iPhone app's usage is about 300 times that of the other contexts. The spike doesn't show
  what holds it; it was opened twice (two visits recorded).

## Pending

- D110: pairing between the Safari tab and the installed app on the same iPhone, copy/paste mode.
- D105: the three system-UI buttons on every device.
- Days 1, 4, 8 and 15: whether each context still has its marker.
