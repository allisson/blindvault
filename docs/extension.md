# BlindVault — Browser extension

> Normative for the browser extension; `overview.md` prevails on design. Implements D267, D268,
> D270, D282, D283, D284, D285 and D286. Measurements behind it are in `docs/spikes/extension.md`.
> Terms follow `GLOSSARY.md` (session host, fill, matching item, passkey, unlock passkey).

## 1. Model

The extension is a full installation of BlindVault, not a client of an open PWA (D267). It has its
own origin (`chrome-extension://<id>`, `moz-extension://<uuid>`), vault database, Local Config and
Device record, and joins the vault by pairing like any device. It cannot read the PWA's storage,
and the PWA cannot read its storage (D90).

| Part | Where | Holds keys | Role |
| --- | --- | --- | --- |
| Session host | an extension tab, pinned, running the whole `apps/web` app | yes, while unlocked | unlocks, holds the vault, answers the RPC, fills, signs |
| Popup | `popup.html`, a second entry of the `apps/web` build | never | lists matching items, asks for a fill or a copy, locks, opens the session host |
| Confirmation window | `confirm.html`, a third entry of the build, opened as a `popup`-type window | never | the user's click on every passkey use, the locked-vault notice |
| Service worker | `apps/extension` | never | relays commands and passkey requests to the session host; holds no state |
| MAIN-world script | `apps/extension`, registered only while passkeys are on | never | replaces `navigator.credentials.create/get` in the page |
| Isolated content script | `apps/extension`, registered only while passkeys are on | never | carries a passkey request from the MAIN-world script to the service worker |

Chrome's offscreen document is used only to clear the clipboard (§6.3); it never holds a key or a
secret (D283).

## 2. Package and build

`apps/extension` holds the manifests, the service worker, the content scripts and the build that
embeds `apps/web`'s output. `apps/web` stays the only UI: the popup and the confirmation window are
entries of its build, and platform differences sit behind its ports (D267).

**Ports.** The `apps/web` code takes from a platform port what differs in the extension:

- the service worker and its update flow (D63, D190, D191) are web only; the extension registers
  none, its code coming from the package (D282);
- the update prompt is the version lock of §8;
- the clipboard clear is the one of §6.3;
- the lock triggers are those of §3.2;
- the first screen adds the extension's onboarding text (§9).

The build picks the platform: `vite build --mode extension` builds the extension's, any other mode
the web's, and the mode is replaced at build time, so each build carries only its own code. The
ports live in `apps/web/src/platform/`, the extension's included: the session host is an
`apps/web` page, and it calls the `chrome.*` and `browser.*` APIs through interfaces of the
project's own, with no type package.

**Manifests.** One per browser, Manifest V3, generated from one source:

| Key | Chrome | Firefox |
| --- | --- | --- |
| `permissions` | `activeTab`, `scripting`, `idle`, `clipboardWrite`, `offscreen`, `unlimitedStorage` | `activeTab`, `scripting`, `idle`, `clipboardWrite` |
| `optional_host_permissions` | `<all_urls>` | `<all_urls>` |
| `background` | `service_worker` | `scripts` (event page) |
| `content_security_policy.extension_pages` | `script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'none'` | same |
| `commands` | `fill`: `Ctrl+Shift+L`, `Command+Shift+L` on macOS | same |
| ID | fixed by the Web Store key | `browser_specific_settings.gecko.id` = `blindvault@allisson.github.io`, fixed, so storage survives updates |
| Minimum | `minimum_chrome_version` `127` | `strict_min_version` `149.0` (§10) |
| Data collection | — | `data_collection_permissions.required` `["none"]` |

`apps/extension/build/manifest.ts` writes both. The `version` key holds the numbers of the package
version, since browsers take no pre-release; Chrome's `version_name` keeps the full version. A
pre-release build is for testing, loaded unpacked, and goes to no store, since the release that
follows has the same numbers.

`unlimitedStorage` exempts the extension's IndexedDB from eviction, since Chrome refuses
`navigator.storage.persist()` in an extension (D282); Firefox grants `persist()`. The app's own
`<meta>` CSP and Trusted Types policy (D83, D177) stay as they are.

**Build.** `pnpm --filter @blindvault/extension build` makes one archive per browser,
reproducibly: entries sorted by path, fixed timestamps and permissions, as D189 asks of the web
build. Each archive carries an `asset-manifest.txt` listing every file of the package with its
SHA-256, `manifest.json` included and the manifest itself excluded (D285).

- `vite build --mode extension` writes `apps/web/dist-extension`: no `public/` (its `sw.js`,
  `404.html` and web manifest are the web's), no `_headers`, the page without its links to the web
  manifest and the Apple icon, and the three icons the extension uses.
- `vite build --mode extension` has two entries, `index.html` (the session host) and `popup.html`.
- `apps/extension/build/package.ts` adds the browser's `manifest.json`, `background.js` and, on
  Chrome, `offscreen.html` and `offscreen.js` (§6.3), writes the package's `asset-manifest.txt`
  with the web build's format and code, and prints its hash per browser. It writes
  `dist/<browser>/`, to load unpacked, and `dist/blindvault-<browser>-<version>.zip`.
- The archive is written by `apps/extension/build/zip.ts`: files only, in byte order of their UTF-8
  paths, stored without compression so its bytes depend on no zlib version, each dated
  1980-01-01 00:00 with mode 0644.
- CI builds both archives twice, as the web build (`docs/build.md`), and compares them byte for
  byte. The release publishes
both archives and both manifest hashes; `docs/build.md` describes how to check a store's package
(§8.2).

## 3. Session host and locking

### 3.1 Session host

- The session host is an extension tab showing `index.html`. The popup opens it pinned when no
  session host exists, or focuses it when one does.
- It unlocks as any app window does: local password on both browsers, unlock passkey on Chrome
  only, with the extension ID as `rpId` (D282). Firefox refuses WebAuthn on a `moz-extension:` page,
  so the Firefox extension unlocks by password only; the unlock-passkey settings are absent there.
- Only one app window opens the vault, as on the web (`GLOSSARY.md`, app window). A second
  extension tab shows the existing notice.
- Closing the session host locks the vault: its keys leave memory with the page.
- The session host is the only place where the vault is managed (items, settings, pairing, sync,
  backup); the popup does none of this.

### 3.2 Locks (D284)

| Lock | Extension | Web, as before |
| --- | --- | --- |
| Auto-lock | 1 to 60 min without activity; activity is an interaction with the session host, the popup or a fill, never browsing | 1 to 60 min (D151) |
| Hidden-app lock | the browser as a whole without focus (`windows.onFocusChanged` reports `WINDOW_ID_NONE`) for the set time, immediately to 15 min | the page hidden (D54, D151) |
| Operating-system lock | at once, when `idle.onStateChanged` reports `locked` | — |
| Manual | the popup's Lock button, or the session host's | the app's |

A lock follows D93 and D263: it aborts every operation in progress and clears the popup and any
open confirmation window. The browser regaining focus before the hidden-app time ends resets that
timer.

## 4. RPC between the extension's pages and the session host

- **Transport.** `runtime.sendMessage` and `runtime.connect` within the extension.
- **Format.** JSON objects `{v: 1, type, id, ...}`, with `type` from a closed list per direction and
  every key validated by type and range on receipt. An unknown `v`, `type` or key is refused with an
  error answer, never acted on.
- **Senders.** The session host acts on a message only when `sender.id === runtime.id` and
  `sender.url` is a page of the extension's own origin (`popup.html`, `confirm.html`) or its service
  worker. A message from a content script carries a web page's URL as `sender.url` and is ignored.
- **No secret to the popup** beyond what the user asked to see or copy: the match list carries
  titles, user names and item IDs, never a password.

| From | `type` | Answer |
| --- | --- | --- |
| popup | `status` | locked or unlocked, read-only, passkeys on or off |
| popup | `matches` `{tabId}` | the matching items of that tab's top frame (§5), or why none can match |
| popup | `fill` `{tabId, itemId}` | done, or the reason it was refused (§6) |
| popup | `search` `{query}` | at most 50 Login items outside the trash whose title, user name or URL holds every term: title, user name, item ID (D286) |
| popup | `copy` `{itemId, field}` | the value, for the popup to write to the clipboard (§6.3) |
| popup, confirmation window, service worker | `lock` | done |
| popup, confirmation window | `open-host` | answered by the service worker: the session host focused or created (D286) |
| service worker | `command-fill` `{tabId}` | done, or open the popup (§6.2) |
| session host, to the service worker | `clipboard-clear` | done; carries nothing (§6.3) |
| session host, to the popup | `locked` | none; the popup closes (§3.2) |
| service worker | `passkey-create`, `passkey-get` | §7 |
| confirmation window | `confirm-details`, `confirm-choice` | §7.4 |

The popup sends `tabId` only; the session host reads the tab's URL itself with `tabs.get`, which the
`activeTab` grant of the user's gesture allows, and trusts no URL or origin a message carries.

## 5. Matching items (D283)

### 5.1 Page origin

A page can match only when its origin is `https:` with a host, or `http://localhost` (any port). A
page on `http:`, `file:`, a data or blob URL, an extension page or an opaque origin never matches.

### 5.2 Item URL

Each `url` field of a Login item, in order:

1. The value is trimmed. With no scheme (no `://` and not a `scheme:` URL), `https://` is
   prepended.
2. It is parsed with the URL Standard (`new URL`). A value that does not parse, or whose scheme is
   not `https:` (or `http:` with host `localhost`), is skipped.
3. Hosts compare in their ASCII (punycode) form, as `URL` returns them, lowercase.

### 5.3 Rule

- **Exact origin** (the field has no `match` key): the item matches when the field's scheme, host
  and port equal the page's. `https://example.com` matches `https://example.com:443/login`, not
  `https://www.example.com` nor `https://example.com:8443`.
- **Whole domain** (`match: "domain"`): the item matches when the field's registrable domain equals
  the page's, both on `https:`. `https://example.com` with the flag matches
  `https://login.example.com`. A host that is an IP address or a public suffix has no registrable
  domain and falls back to the exact origin.
- An item matches when any of its `url` fields matches. A trashed item never matches.

### 5.4 The `match` key

`match` is an optional key of the field map, valid only on a `url` field with the value `domain`
(`record-content.md` §4). The item editor offers it as a per-field switch, "Match the whole
domain", off by default. An older app reads an item with the key as newer content, read-only
(`record-content.md` §2 rule 3).

### 5.5 Public Suffix List

`packages/vault/src/psl/public_suffix_list.ts` holds the list pinned at a commit of
`publicsuffix/list`: the upstream `public_suffix_list.dat` byte for byte inside a `String.raw`
template, so the package also loads outside Vite, with a test checking its SHA-256 against the one
the directory's `README.md` names with the commit and its date. A parser of the project's own
reads it into a lookup table at the first lookup and applies the list's algorithm: the longest
matching rule, wildcard rules, exception rules, and the implicit `*` rule. It is tested against the
list's own `tests/test_psl.txt`. Both the ICANN and private sections apply. Updating the list is a
reviewed change, never a fetch at run time.

## 6. Filling

### 6.1 From the popup

1. The popup opens on the user's click, which grants `activeTab` for that tab.
2. It asks `matches` with the active tab's `tabId`. The session host reads `tabs.get(tabId).url`
   and computes the top frame's origin; on a page that cannot match (§5.1) the popup says why.
3. The popup lists the matching items: title, user name and the URL that matched; a search box
   finds any Login item, but filling stays limited to matching items.
4. On a click on an item, the popup sends `fill`.
5. The session host runs `scripting.executeScript({target: {tabId, allFrames: true}, func:
   probe})` in the isolated world. `probe` returns `location.origin`, whether the frame has a
   visible password field, and whether one has the focus. The browser injects only into frames
   whose origin `activeTab` grants, the top frame's.
6. The target frame is the one whose password field has the focus, else the top frame when it has a
   visible password field, else the first same-origin frame that has one in document order. A
   frame whose origin differs from the top frame's is never a target. No target: the popup says the
   page has no sign-in field.
7. The session host runs `scripting.executeScript({target: {tabId, frameIds: [frameId]}, func:
   fill, args: [expectedOrigin, username, password]})`, in the isolated world. `fill` returns
   without writing unless `location.origin === expectedOrigin`, which covers a navigation between
   the probe and the fill. It writes the user name into the text or email field before the password
   field (when the item has one) and the password into the password field, through the native
   value setter, then dispatches `input` and `change` on each. It never submits a form, clicks a
   button or presses a key.
8. The popup closes. The fill counts as activity for auto-lock.

The values travel only from the session host to the injected function in the extension's isolated
world, through the browser. The page's own scripts can read a field once it is filled, as with any
typed password; that is the purpose of filling.

### 6.2 Keyboard shortcut

The `fill` command reaches the service worker with the tab, which grants `activeTab`. The service
worker sends `command-fill` `{tabId}` to the session host:

- no session host, or the vault locked: the service worker opens the popup (`action.openPopup`),
  which shows the locked state;
- exactly one matching item: the session host fills it as in §6.1 steps 5 to 7;
- none, or several: the service worker opens the popup, filtered to the tab's origin.

The browser takes the key before the page. On the session host's own tab the command sends `lock`
instead, so the app's lock shortcut (D197) keeps its meaning there (D286).

### 6.3 Copying and the clipboard

The popup copies a user name, a password or the current TOTP code with `navigator.clipboard
.writeText`, since the popup has the focus; the `copy` answer starts the clear's timer in the
session host. The clear after the set time (D54, D151) is timed by the session host, for the
popup's copies and its own, and done by a context that can write to the clipboard without the
focus, as measured (D282): the session host sends `clipboard-clear` to the service worker, which on
Chrome creates an offscreen document with reason `CLIPBOARD`, writing an empty string through
`execCommand('copy')`, and closes it, and on Firefox writes `writeText('')` itself. That context
receives no secret. Both rely on `clipboardWrite` (D286). A lock clears the clipboard the same way
when the session host can still send the request; closing the session host may leave it, and the
UI states, as on the web, that clearing is not guaranteed.

## 7. Stored passkeys (D268)

### 7.1 Turning passkeys on

Settings › Passkeys has a switch, off by default. Turning it on calls `permissions.request({origins:
['<all_urls>']})` on the user's click; once granted, the session host registers both content scripts
with `scripting.registerContentScripts`, at `document_start`, in all frames, the MAIN-world one with
`world: 'MAIN'`. Turning it off unregisters them and calls `permissions.remove`. The switch shows the
browser's state (`permissions.contains`); nothing is stored. Stored passkeys keep working in the
session host's views when the switch is off: they are fields of items.

### 7.2 Interception

- The MAIN-world script keeps the original `navigator.credentials.create` and `get` and replaces
  them. A call whose options have no `publicKey`, or that asks for `mediation: 'conditional'`, goes
  straight to the original (D283).
- It serializes the `publicKey` options and sends them to the isolated content script with a
  random request ID. The isolated script forwards them to the service worker with
  `runtime.sendMessage`.
- The service worker takes the origin, `frameId` and top frame's origin only from `MessageSender`
  (`sender.origin`, `sender.frameId`, `sender.tab.url`), never from the message, and forwards the
  request to the session host. A message whose sender has no tab is dropped.
- The session host checks, in order, and hands the call back to the browser on the first failure:
  1. the origin is `https:`, or `http://localhost`;
  2. `rpId` (absent: the origin's host) equals the origin's host, or is a registrable suffix of it
     that is not itself a public suffix (§5.5);
  3. for `create`, `pubKeyCredParams` lists ES256 (`-7`) or EdDSA (`-8`).
- Handing back means the isolated script tells the MAIN-world script to call the original with the
  page's options. The spike saw Firefox refuse a hand-back under automation when the confirmation
  window had taken the focus (`docs/spikes/extension.md` §3); the implementation tests it by hand.
- The answer travels back the same way. The MAIN-world script builds the `PublicKeyCredential` the
  page receives, as the spike measured: `instanceof PublicKeyCredential` true,
  `getClientExtensionResults()` with `credProps.rk: true` on create, `toJSON()` complete.

### 7.3 Credentials

- `clientDataJSON` is built by the session host with `type`, the page's `challenge`, the origin from
  `MessageSender`, and, in a cross-origin iframe, `crossOrigin: true` and `topOrigin`.
- Authenticator data: `SHA-256(rpId)`, flags UP, UV, BE and BS set (AT on create), `signCount` 0;
  on create, attested credential data with a zero AAGUID, a random 16-byte `credentialId` and the
  COSE public key. Attestation is `none` (`fmt: "none"`, empty `attStmt`).
- ES256 is preferred when the site lists both; keys and signatures follow D268: ES256 through
  WebCrypto with the private key imported non-extractable only to sign, EdDSA through libsodium.
- The `passkey` field holds the private key in PKCS#8, `credentialId`, `rpId`, `userHandle`, the
  user name and the creation date (D268); its exact encoding is added to `record-content.md` with
  the passkey task.

### 7.4 Confirmation window

Every create and get opens `confirm.html` with `windows.create({type: 'popup'})`, of the extension's
origin, so the page can neither cover nor click it. It asks the session host for the request's
details (`confirm-details`) and shows:

- the origin, and the top frame's origin when they differ;
- the `rpId` and, for create, the user name and display name the site sent;
- for get, the passkeys that can answer: those of the `rpId` whose `credentialId` is in
  `allowCredentials`, or every one of the `rpId` when the list is empty; the user picks one;
- for create, where to save it: a matching Login item (§5) chosen from a list, or a new Login
  item titled with `rp.name` and with the URL `https://<rpId>`;
- "Use another authenticator", which hands the call back to the browser;
- Cancel, which answers `NotAllowedError`.

The click on Confirm is the user presence (UP). UV is reported because the vault is unlocked.

**Cases.**

| Case | Answer |
| --- | --- |
| Vault locked, or no session host | the window says BlindVault is locked and offers "Open and unlock" (focuses or creates the session host, then shows the request) or "Use another authenticator"; the page's call waits until its `timeout` |
| `timeout` elapses, or the window closes | `NotAllowedError` |
| get with no passkey for the `rpId` | the window says so and offers another authenticator |
| create on a read-only vault (D73) | handed to the browser at once, with no window |
| create whose `excludeCredentials` lists a held `credentialId` | the window shows the request as usual; after Confirm, `InvalidStateError`, so a page learns it only from the user's click |
| a lock while the window is open | the window closes; `NotAllowedError` |

A get writes nothing, since `signCount` is always 0 (D268), and so works on a read-only vault.

### 7.5 History

Removing a passkey makes an Item Version that keeps its private key until history is purged; the
remove dialog says so and tells the user to remove the passkey on the site too (D268).

## 8. Updates and the version lock (D270, D285)

### 8.1 Deferring the update

The service worker listens to `runtime.onUpdateAvailable`, so the browser does not reload the
extension at once. When the vault is locked or no session host exists it calls `runtime.reload()`;
otherwise the session host reloads the extension when the vault next locks.

- The service worker finds the session host among `runtime.getContexts({contextTypes: ["TAB"]})`
  by its URL, and reloads only when there is none.
- The session host listens too (the platform's update flow): it reloads at once when the vault is
  locked or absent and no operation runs, the condition of the web's update (D152), and otherwise
  on the first change of state that meets it. A browser restart
applies the update anyway; the vault then reopens locked at the new version.

### 8.2 Confirmation, and what it does not do

The installation keeps the last confirmed version and manifest hash in `localStorage`
(`blindvault.extension.confirmed`), an installation setting holding no vault data, as the STUN list
does (D209). The running hash is the one About shows: the SHA-256 of the package's
`asset-manifest.txt`, read at startup. At startup, when the
running version or hash differs, the first screen shows both, old and new, and the link to the
release, and opens no vault until the user confirms. A first installation records them with the
onboarding's notice, trust on first use as on the web. "First" means no record and no vault: a
vault with no record, or with a record that cannot be read, asks for the confirmation, with the
previous version shown as unknown.

**Limit.** This confirmation is transparency, not protection. The new code installed by the store
is the code that shows it, and a malicious version can skip it. What holds is §8.1: the running code
keeps the session until the vault locks. The store and the publisher account remain roots of trust
(`threat-model.md`, A6).

**Checking a store's package.** Download the CRX (Chrome Web Store) or XPI (AMO) of the installed
version, unpack it, remove `_metadata/` (Chrome) or `META-INF/` (Firefox), and run `shasum -a 256 -c
asset-manifest.txt` in it; the hash of `asset-manifest.txt` must equal the one About shows and the
release publishes. `docs/build.md` gives the commands.

**To confirm at the first Chrome Web Store upload.** No source found states whether the store
rewrites `manifest.json` in the package it serves (an `update_url`, the `key`). If it does, the
`manifest.json` line fails this check on Chrome, and a new decision says how the check treats that
file.

## 9. Onboarding, pairing and sync

- The first screen is the app's (D198), with the three starts. In the extension it adds that the
  extension is a separate device of the vault, recommends pairing with the PWA or another device,
  and states that the extension sees new items only after a sync.
- Pairing on the same machine uses copy/paste (D203); sync is the manual flow (D216). Neither
  changes.

## 10. Browsers

| Browser | Status | Minimum |
| --- | --- | --- |
| Chrome | tested | 127, where `action.openPopup` left the policy-installed extensions (Chrome's "What's new in Chrome extensions") |
| Firefox | tested | 149, where `action.openPopup` left its preference (Bugzilla 1799344); MAIN-world scripts need 128 |
| Edge, Brave | installed from the Chrome Web Store; listed in `browser-matrix.md` as untested | as Chrome |
| Safari | not in v1 (D267) | — |

The spike measured Chrome 158 and Firefox 160 on macOS only (D282).

## 11. Out of v1

Saving a login when a form is submitted; filling cards and identities; filling a TOTP code (copying
it from the popup stays); an icon in the page's fields; conditional mediation; Safari; importing
passkeys from other managers (D268).

## 12. Tests

Unit and component tests in `apps/extension` and `apps/web`, Playwright with the unpacked extension
on Chromium and Firefox, and by hand on `webauthn.io` for passkeys. Playwright runs on Chromium
first (`apps/extension/e2e`); Firefox joins with filling, since loading an extension there needs a
tool of its own. Negative tests, each named in
`security-invariants.md` once it exists:

- **Matching.** `http:` page; port differs; `www.` differs without the flag; the flag on an IP or a
  public suffix; a private-section suffix (`github.io`); punycode host; unparsable URL field;
  trashed item.
- **PSL.** Every line of `test_psl.txt`.
- **Filling.** A cross-origin iframe with a focused password field is not a target; a navigation
  between probe and fill writes nothing; a fill never submits; a `matches` or `fill` message from
  a content script is ignored; a `fill` for an item that does not match the tab is refused.
- **RPC.** Unknown `v`, `type` or key refused; a message without the extension's sender refused.
- **Locks.** Browser without focus for the hidden-app time locks; the OS lock locks; browsing does
  not reset auto-lock; closing the session host locks; a lock closes the confirmation window.
- **Passkeys.** A forged origin in the message is ignored; an `rpId` of another site, a public
  suffix, or on `http:` goes to the browser; `excludeCredentials` answers only after the click;
  `signCount` 0 and the flags; create on a read-only vault goes to the browser; conditional
  mediation goes to the browser.
- **Version lock.** A changed hash shows the confirmation before unlock; `onUpdateAvailable` with
  the vault unlocked does not reload.

## 13. Threat model

`threat-model.md` A9 (malicious website) and A6 (store and publisher account) hold the entries this
document specifies.
