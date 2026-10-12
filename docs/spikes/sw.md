# Spike result — service-worker integrity (D63, D142)

Status: **done** (D162). Every browser of the matrix: Mac Safari,
Chrome and Firefox tabs, Windows Chrome and Firefox tabs, and the iPhone 14 and Samsung A54
installed apps. The phone browser tabs were not open during the deploy and were not measured.

Setup: `sw.html` registers `sw.js` with `updateViaCache: 'none'` and stays open, unreloaded, while
the site is redeployed from `swVersion = 1` to `swVersion = 2` with `swTakeover = true` (the new
worker calls `skipWaiting` and `clients.claim`). The worker logs its own `install` and `activate`
to IndexedDB; the page logs `updatefound`, the new worker's state changes and `controllerchange`.
The page also calls `registration.update()` when it becomes visible, as the product would, and on
"Check for update". Deploy of version 2 finished at 09:08:20 UTC on 2026-10-12.

## Samsung A54, Chrome 155 installed app (2026-10-12)

The page loaded at 09:04:24 and installed version 1 on load. The app was in the background from
09:05:31 to 09:09:10, across the deploy.

| Time (UTC) | Event |
| --- | --- |
| 09:09:10.209 | app visible again; the page calls `update()` |
| 09:09:10.734 | `updatefound` (the product locks the vault here) |
| 09:09:10.738 | version 2 runs its `install` code |
| 09:09:10.742 | version 2 `activate`, `controllerchange`: version 2 controls this window |

- **The changed worker's install code ran** with the old page still open, and **took control of the
  open window** through `skipWaiting` and `clients.claim`, 8 ms after `updatefound`.
- **`updatefound` fired first**, 4 ms before the new worker's install code and 8 ms before it took
  control. Whether a lock started at `updatefound` completes in that window is not measured.
- Detection came from the page's own `update()` on becoming visible, 50 s after the deploy finished.
  No update was found in the 50 s the app stayed in the background after the deploy; the spike
  doesn't show when the browser would have checked on its own.
- The manual checks afterwards found nothing new, as expected.

## iPhone 14, Safari 26.6 installed app (2026-10-12)

The page loaded at 09:08:12 and installed version 1 on load. The app was in the background from
09:10:13 to 09:14:52.

| Time (UTC) | Event |
| --- | --- |
| 09:14:52.598 | app visible again; the page calls `update()` |
| 09:14:52.863 | `updatefound` (the product locks the vault here) |
| 09:14:52.872 | version 2 runs its `install` code |
| 09:14:52.883 | version 2 `activate`, `controllerchange`: version 2 controls this window |

- Same result as the A54: the changed worker installed and took control of the open window,
  `updatefound` 9 ms before its install code and 20 ms before it took control.
- Detection again came from the page's `update()` on becoming visible; no update was found in the
  four and a half minutes the app stayed in the background after the deploy.

## MacBook Air M1, Safari 26.6 tab (2026-10-12)

The page loaded at 09:05:11 and installed version 1 on load. The tab was hidden from 09:05:19 to
09:12:25.

| Time (UTC) | Event |
| --- | --- |
| 09:12:25.102 | tab visible again; the page calls `update()` |
| 09:12:25.395 | `updatefound` (the product locks the vault here) |
| 09:12:25.401 | version 2 runs its `install` code |
| 09:12:25.407 | version 2 `activate`, `controllerchange`: version 2 controls this window |

- Same result in a desktop tab: install code ran and took control of the open tab, `updatefound`
  6 ms before the install code and 12 ms before the takeover.
- Detection again on becoming visible; nothing was found in the four minutes the tab stayed hidden
  after the deploy.

## MacBook Air M1, Chrome 155 tab (2026-10-12)

The page loaded at 09:05:04 and installed version 1 on load. The tab stayed visible the whole time
(no visibility change).

| Time (UTC) | Event |
| --- | --- |
| 09:12:56.678 | "Check for update": the page calls `update()` |
| 09:12:56.725 | `updatefound` (the product locks the vault here) |
| 09:12:56.732 | version 2 runs its `install` code |
| 09:12:56.736 | `controllerchange`: version 2 controls this window |
| 09:12:57.737 | version 2 `activate` logged, about 1 s after the takeover |

- Same result: install code ran and took control of the open tab, `updatefound` 7 ms before the
  install code and 11 ms before the takeover.
- **Chrome did not check for the update on its own** in the 4.5 minutes the tab stayed open and
  visible after the deploy: the first `updatefound` followed the first manual `update()`. Without
  a navigation or a call to `update()`, the open window kept running under version 1.
- `controllerchange` came 1 s before the new worker's `activate` handler ran (it logs before calling
  `clients.claim`): a window already controlled by version 1 switches to version 2 as soon as
  `skipWaiting` makes it active, so `skipWaiting` alone takes over an open window; `clients.claim`
  matters only for uncontrolled ones.

## MacBook Air M1, Firefox 157 tab (2026-10-12)

The page loaded at 09:05:38 and installed version 1 on load. The tab stayed visible the whole time.

| Time (UTC) | Event |
| --- | --- |
| 09:13:38.111 | "Check for update": the page calls `update()` |
| 09:13:39.211 | `updatefound` (the product locks the vault here) |
| 09:13:39.213 | version 2 runs its `install` code |
| 09:13:39.218 | version 2 `activate`, `controllerchange`: version 2 controls this window |

- Same result: install code ran and took control of the open tab, `updatefound` 2 ms before the
  install code and 7 ms before the takeover, the narrowest gap so far.
- Like Chrome, Firefox did not check on its own in the 5 minutes the tab stayed open and visible
  after the deploy.

## Windows laptop, Firefox 157 tab (2026-10-12)

The page loaded at 09:07:20 and installed version 1 on load. The tab stayed visible the whole time.

| Time (UTC) | Event |
| --- | --- |
| 09:15:14.560 | "Check for update": the page calls `update()` |
| 09:15:15.669 | `updatefound` (the product locks the vault here) |
| 09:15:15.670 | version 2 runs its `install` code |
| 09:15:15.677 | `controllerchange`: version 2 controls this window |

- Same result as Firefox on the Mac: `updatefound` 1 ms before the install code and 8 ms before the
  takeover, and no update found on its own in the 7 minutes the tab stayed open after the deploy.
- The result was copied 23 ms after the takeover and reports the window as "not controlled",
  probably because the `sw-version` probe raced the worker change; `controllerchange` shows the
  takeover. Not confirmed with "Refresh status".

## Windows laptop, Chrome 155 tab (2026-10-12)

The page loaded at 09:07:00 and installed version 1 on load. The tab was hidden from 09:07:06 to
09:16:53.

| Time (UTC) | Event |
| --- | --- |
| 09:16:53.397 | tab visible again; the page calls `update()` |
| 09:16:53.440 | `updatefound` (the product locks the vault here) |
| 09:16:53.452 | version 2 runs its `install` code |
| 09:16:53.457 | version 2 `activate`, `controllerchange`: version 2 controls this window |

- Same result: `updatefound` 12 ms before the install code and 17 ms before the takeover; detection
  on becoming visible, nothing found in the 8.5 minutes the tab stayed hidden after the deploy.

## Conclusion (D63, D142)

Seven contexts, every engine of the matrix (Chromium, Gecko, WebKit) on desktop and both phones:

- **D142's threat is real everywhere.** A changed `sw.js` ran its install code while the old page
  was open and took control of the open window, with no reload.
- **`skipWaiting` alone takes over an open window.** A window already controlled by version 1
  switched to version 2 when `skipWaiting` made it active, before its `activate` handler ran (Mac
  Chrome, 1 s earlier); `clients.claim` only adds uncontrolled windows.
- **`updatefound` always came first:** 1–12 ms before the new worker's install code and 7–20 ms
  before the takeover. Detection works; the margin is a few milliseconds, so the lock has to run
  synchronously in the `updatefound` handler.
- **No browser looked for the changed `sw.js` on its own** while a page stayed open, visible or
  hidden, for 4 to 9.5 minutes after the deploy. Every update was found by the page's own
  `registration.update()`, on becoming visible or on demand.
- Not measured: when a new worker without `skipWaiting` activates on its own (`swTakeover = false`),
  and the phone browser tabs (same engines as the installed apps).
