# Spike result — browser storage (D55, D103, D105, D110)

Status: **restarting**. The storage run moved to the Samsung A54 and the MacBook Air M1; the day-0
results of 2026-10-10 (iPhone and Mac) were discarded. Day 0 is the day the markers are written
again; follow-ups on days 1, 4, 8 and 15 after it.

## Devices and contexts

| Device | Browser tab | Installed app |
| --- | --- | --- |
| MacBook Air M1 | Safari | Safari, File → Add to Dock |
| Samsung A54 | Chrome | Chrome, menu → Add to Home screen → Install |

Safari on the Mac is the WebKit case D55 and D103 are about. Chrome on Android has no comparable
deletion of storage after days without use, so the A54 is the control.

The iPhone is no longer in this run, so iOS behavior (Home Screen app storage, D110) is not
measured by it.

## Day 0 (2026-10-10, 20:26 UTC)

Follow-ups: 2026-10-11, 2026-10-14, 2026-10-18 and 2026-10-25. Site build: `swVersion` 1, built
2026-10-10T11:27:35Z.

| Context | Markers seen | `persist()` | `persisted` after | Quota (bytes) | Usage (bytes) |
| --- | --- | --- | --- | --- | --- |
| Mac, Safari 26.6.2 tab | own only | false | false | 82,463,372,084 | 235,008 |
| Mac, Dock app | own only | true | true | 82,463,372,084 | 123,364 |
| A54, Chrome tab | pending | | | | |
| A54, installed app | pending | | | | |

- **Mac, D103:** the Safari tab and the Dock app don't share storage; each sees only its own marker
  and visits.
- **Mac, persistent storage:** granted to the Dock app, refused to the tab, with no prompt.
- The Dock app's visit log shows four openings between 14:58 and 15:34 UTC, before day 0. They don't
  affect the run, which counts from the new marker.

## Separate findings from 2026-10-10 (iPhone)

These answer different questions from the storage run and are kept.

### D110 — same-device pairing on iPhone

Safari tab as A, Home Screen app as B, copy/paste, LAN-only. B decoded A's offer and produced its
answer (92 bytes, 138 base45 characters each, one mDNS host candidate). The run stopped there: going
back and forth between the two contexts on one phone, with copy and paste each way, was too hard for
the tester to finish. No connection state was recorded on either side.

- **D110 stands:** on iPhone, moving a tab's vault to the installed app goes through backup and
  restore, not pairing. Same-device pairing is not a path to offer even if it could connect.
- The first attempts failed because "Use pasted offer" was pressed with an empty box (the label
  suggested it read the clipboard); the spike's Paste buttons now read the clipboard.

### D105 — system UI and visibility

| Context | File picker | Camera prompt | WebAuthn prompt |
| --- | --- | --- | --- |
| iPhone, Safari tab | visible | visible | visible |

Each prompt was opened and cancelled; none reported the page as hidden. The PRF spike adds Chrome
and Firefox on Android, Windows and macOS: no WebAuthn prompt reported the page as hidden
(`prf.md`).
