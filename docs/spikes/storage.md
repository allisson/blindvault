# Spike result — browser storage (D55, D103, D105, D110)

Status: **ended after day 1** (D160). The storage run moved to the Samsung A54 and the MacBook Air
M1; the day-0 results of the morning of 2026-10-10 (iPhone and Mac) were discarded from the run.
The follow-ups planned for 2026-10-14, 10-18 and 10-25 are cancelled.

## Conclusion

- **D55 stands, on WebKit's documentation.** No result of a multi-day run could relax it: WebKit
  documents that a tab's script-writable storage is deleted after seven days of Safari use without
  user interaction on the site ("Full Third-Party Cookie Blocking and More", 2020), so a tab that
  survives a test does not show its storage is safe. An installed app has its own counter of days of
  use; Safari grants `persist()` by heuristics such as running as a Home Screen app ("Updates to
  Storage Policy", 2023).
- **D103 confirmed on iOS and macOS:** the tab and the installed app each saw only their own marker,
  on the Mac in this run and on the iPhone in the discarded morning snapshot of 2026-10-10 (commit
  `dc13261`: iPhone 14, Safari 26.6.1).
- **`persist()`:** refused to the tab and granted to the installed app with no prompt, on the
  iPhone, the Mac and the A54.
- **D110 stands** (below). D105 is recorded per browser here and in `prf.md`.

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
| A54, Chrome 155 tab | own only (written first) | false | false | 10,737,421,304 | 3,064 |
| A54, installed app | both | true | true | 10,737,422,354 | 4,114 |

- **Mac, D103:** the Safari tab and the Dock app don't share storage; each sees only its own marker
  and visits.
- **Mac, persistent storage:** granted to the Dock app, refused to the tab, with no prompt.
- **A54:** the Chrome tab and the installed app share storage: the app sees the tab's marker and
  visits. D103's separate installation is a Safari behavior; on Android Chrome the installed app
  opens the tab's vault directly.
- **A54, persistent storage:** refused to the tab, granted to the installed app minutes later with
  no prompt. Storage is per origin here, so the grant covers the tab's data too.
- The Dock app's visit log shows four openings between 14:58 and 15:34 UTC, before day 0. They don't
  affect the run, which counts from the new marker.

## Day 1 (2026-10-11, 20:48 UTC)

| Context | Markers seen | Marker age (days) | `persisted` | Quota (bytes) | Usage (bytes) |
| --- | --- | --- | --- | --- | --- |
| Mac, Safari 26.6.2 tab | own only | 1.02 | false | 82,463,372,084 | 131,315 |
| Mac, Dock app | own only | 1.02 | true | 82,463,372,084 | 147,862 |
| A54, Chrome 155 tab | not checked (see below) | | | | |
| A54, installed app | both | 1.02, 1.01 | true | 10,737,422,326 | 4,086 |

- All markers from day 0 are present in the contexts checked. Nothing was deleted after one day.
- **A54 tab not checked:** the result pasted for the tab reports `standalone: true` and
  `thisContext: "installed app"`, and its visit was recorded as the installed app. Chrome opened the
  URL in the installed app instead of a tab. The tab's last visit is still 2026-10-10 21:21 UTC. Not
  repeated, since the run ended that day.
- Mac Safari tab usage dropped from 235,008 to 131,315 bytes with the marker kept; usage is an
  estimate, not a deletion signal.

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
