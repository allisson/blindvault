# BlindVault — Browser extension

> Normative for the browser extension; `overview.md` prevails on design. Implements D267, D268,
> D270, D282, D283, D284, D285, D286, D287, D288 and D289. Measurements behind it are in `docs/spikes/extension.md`.
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
- `vite build --mode extension` has three entries, `index.html` (the session host), `popup.html`
  and `confirm.html`.
- `apps/extension/build/package.ts` adds the browser's `manifest.json`, `background.js`, the
  content scripts `passkey-main.js` and `passkey-isolated.js` (§7.1) and, on Chrome, `offscreen.html`
  and `offscreen.js` (§6.3), writes the package's `asset-manifest.txt`
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
| Auto-lock | 1 to 60 min without activity; activity is an interaction with the session host, the popup, a fill or a choice in the confirmation window, never browsing, and never a passkey request a page makes or a window loading its details (D305) | 1 to 60 min (D151) |
| Hidden-app lock | the browser as a whole without focus (`windows.onFocusChanged` reports `WINDOW_ID_NONE`) for the set time, immediately to 15 min | the page hidden (D54, D151) |
| Operating-system lock | at once, when `idle.onStateChanged` reports `locked`; Firefox's `idle` never reports it, so in Firefox there is none and the auto-lock and the hidden-app lock remain (D311) | — |
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
  Each type is taken only from the page the table gives as its sender; another page of the
  extension gets an error answer (D287).
- **No secret to the popup** beyond what the user asked to see or copy: the match list carries
  titles, user names and item IDs, never a password.

| From | `type` | Answer |
| --- | --- | --- |
| popup | `status` | locked or unlocked, read-only, passkeys on or off |
| popup | `matches` `{tabId}` | the matching items of that tab's top frame (§5), each with the URL that matched, or `page` when the page cannot match or the browser gives no URL (D287) |
| popup | `fill` `{tabId, itemId}` | done, or `locked`, `not-found`, `page`, `no-match`, `no-field`, `no-target` (no sign-in field) or `moved` (§6, D287) |
| popup | `search` `{query}` | at most 50 Login items outside the trash whose title, user name or URL holds every term: title, user name, item ID (D286) |
| popup | `copy` `{itemId, field}` | the value, for the popup to write to the clipboard (§6.3) |
| popup, confirmation window, service worker | `lock` | done |
| popup, confirmation window | `open-host` | answered by the service worker: the session host focused or created (D286) |
| service worker | `command-fill` `{tabId}` | `filled`, or `popup`: the service worker opens the popup (§6.2) |
| session host, to the service worker | `clipboard-clear` | done; carries nothing (§6.3) |
| session host, to the popup | `locked` | none; the popup closes (§3.2) |
| service worker | `passkey-create`, `passkey-get` | accepted at once; the result follows in `passkey-answer` (§7.7, D289) |
| service worker | `passkey-cancel` `{request, tabId, frameId}` | done; the page aborted its call, and the pending request of that frame ends (§7.7, D305) |
| session host, to the service worker | `passkey-answer` | none; the service worker hands the result to the page's frame (§7.7) |
| confirmation window | `confirm-details`, `confirm-choice` | §7.4, §7.7 |

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
3. The popup lists the matching items: title, user name and the URL that matched, with Fill and the
   copy buttons, above every Login item. A search box finds any Login item, listed with the copy
   buttons only: filling stays limited to matching items (D287).
4. On a click on an item, the popup sends `fill`.
5. The session host runs `scripting.executeScript({target: {tabId, allFrames: true}, func:
   probe})` in the isolated world. `probe` returns `location.origin`, whether the frame has a
   usable password field, whether that field has the focus, and whether the focus is on a text,
   email or telephone field. The browser injects only into frames whose origin `activeTab` grants,
   the top frame's.
6. The target frame is the one whose password field has the focus, else the top frame when it has a
   usable password field, else the first same-origin frame that has one in the order the browser
   lists them, else, for a sign-in that asks the user name alone first, the frame whose text, email
   or telephone field has the focus (D287). A frame whose origin differs from the top frame's is
   never a target. No target: the popup says the page has no sign-in field.
7. The session host runs `scripting.executeScript({target: {tabId, frameIds: [frameId]}, func:
   fill, args: [expectedOrigin, username, password]})`, in the isolated world. `fill` returns
   without writing unless `location.origin === expectedOrigin`, which covers a navigation between
   the probe and the fill. It writes the item's password into the password field and its user name
   into the user name's field, each when the item has one, through the native value setter, then
   dispatches `input` and `change` on each. It never submits a form, clicks a button or presses a
   key. The fields (D287):
   - a usable field has a rendered box of some width and height, and is not `visibility: hidden`,
     disabled or read-only, nor fully transparent (`opacity: 0`), it or an ancestor across open
     shadow roots; a field outside the viewport stays usable, since a sign-in form below the fold
     is filled (D305); open shadow roots are searched, closed ones cannot be;
   - the password field is the focused one, else the first usable one whose `autocomplete` is not
     `new-password`, so a sign-up page has none;
   - the user name's field is the one with `autocomplete="username"`, else the last text, email or
     telephone field before the password field, within the password field's form when it has one;
     with no password field, it is the focused text, email or telephone field, and the password is
     not written.
8. The popup closes. The fill counts as activity for auto-lock.

The values travel only from the session host to the injected function in the extension's isolated
world, through the browser. The page's own scripts can read a field once it is filled, as with any
typed password; that is the purpose of filling.

### 6.2 Keyboard shortcut

The `fill` command reaches the service worker with the tab, which grants `activeTab`. The service
worker sends `command-fill` `{tabId}` to the session host:

- no session host, or the vault locked: the service worker opens the popup (`action.openPopup`),
  which shows the locked state;
- exactly one matching item: the session host fills it as in §6.1 steps 5 to 7 and answers
  `filled`;
- none, several, or a fill that wrote nothing: the session host answers `popup`, and the service
  worker opens the popup, which lists the tab's matching items. Any other answer, or none, opens it
  too.

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
browser's state (`permissions.contains`); nothing is stored. At start, the session host
registers both scripts again when the permission is held, so a registration lost in an update comes
back (D289). Stored passkeys keep working in the
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
  request to the session host. A message whose sender has no tab, or no `sender.origin`, is
  dropped: `sender.url` names a sandboxed frame's URL, not its opaque origin, and every browser of
  §10 gives `sender.origin` (D305). A frame of an opaque origin reports `null`, which the session
  host hands to the browser.
- The session host checks, in order, and hands the call back to the browser on the first failure:
  1. the origin is `https:`, or `http://localhost`;
  2. `rpId` (absent: the origin's host) equals the origin's host, or is a registrable suffix of it
     that is not itself a public suffix (§5.5), and is not an IP address, which browsers refuse
     (D305);
  3. for `create`, `pubKeyCredParams` lists ES256 (`-7`) or EdDSA (`-8`);
  4. for `create`, `authenticatorSelection.authenticatorAttachment` is not `cross-platform` (D288).
- Handing back means the isolated script tells the MAIN-world script to call the original with the
  page's options. The spike saw Firefox refuse a hand-back under automation when the confirmation
  window had taken the focus (`docs/spikes/extension.md` §3); the implementation tests it by hand.
- The answer travels back the same way. A call whose answer never comes (the session host closed)
  ends with `NotAllowedError` 5 s after its bounded timeout (§7.4); the page's `signal` aborts the
  call with its reason, a later answer is ignored, and the MAIN-world script sends `passkey-cancel`,
  which ends the request in the session host and closes its window (§7.7, D305). The MAIN-world script builds the
  `PublicKeyCredential` the page receives, as the spike measured: `instanceof PublicKeyCredential` true,
  `getClientExtensionResults()` with `credProps.rk: true` on create, `toJSON()` complete.
- The credential reports `authenticatorAttachment: "platform"`, and on create `getTransports()`
  answers `["internal", "hybrid"]`. Of the extensions the page asks for, only `credProps` is
  answered; the others, `prf` included, are left out, as by an authenticator without them.
  `userVerification: "required"` is met, since the vault is unlocked (D288).

### 7.3 Credentials

- `clientDataJSON` is built by the session host with `type`, the page's `challenge`, the origin from
  `MessageSender`, and, in a cross-origin iframe, `crossOrigin: true` and `topOrigin`. A frame is
  cross-origin when its origin differs from the top frame's: the browser gives no chain of
  ancestors, so a frame of A inside a frame of B inside A reports `crossOrigin: false` (accepted,
  D305).
- Authenticator data: `SHA-256(rpId)`, flags UP, UV, BE and BS set (AT on create), `signCount` 0;
  on create, attested credential data with a zero AAGUID, a random 16-byte `credentialId` and the
  COSE public key. Attestation is `none` (`fmt: "none"`, empty `attStmt`).
- ES256 is preferred when the site lists both; keys and signatures follow D268: ES256 through
  WebCrypto with the private key imported non-extractable only to sign, its `r ‖ s` written as a
  DER `Ecdsa-Sig-Value`, EdDSA through libsodium.
- A new ES256 key is generated extractable, exported once as PKCS#8 and rewritten in the fixed
  layout of `record-content.md` §4, the exported bytes wiped; a new EdDSA key is a random 32-byte
  seed. The session host keeps no imported key after the signature.
- The `passkey` field (`record-content.md` §4, D288) holds the private key in PKCS#8,
  `credentialId`, `rpId`, `userHandle`, the user name and the creation date.
- `packages/crypto` holds the key generation, the PKCS#8 layouts, the signatures, the
  authenticator data and the `attestationObject`; `apps/web` the checks of §7.2, the choice of
  passkey and `clientDataJSON`.

### 7.4 Confirmation window

Every create and get opens `confirm.html#<token>` with `windows.create({type: 'popup'})`, of the
extension's origin, so the page can neither cover nor click it. It asks the session host for the request's
details (`confirm-details`) and shows:

- the origin, and the top frame's origin when they differ;
- the `rpId` and, for create, the user name and display name the site sent;
- for get, the passkeys that can answer: those of the `rpId` whose `credentialId` is in
  `allowCredentials`, or every one of the `rpId` when the list is empty, each `credentialId` once,
  since a duplicated item holds the same key (D288); the user picks one;
- for create, where to save it: a matching Login item (§5) chosen from a list, or a new Login
  item titled with `rp.name`, with the URL `https://<rpId>` and `user.name` as its user name
  (D288). When the vault already holds a passkey of that `rpId` and `userHandle`, the window says
  it will be replaced, and Confirm replaces it in every item holding it, as an authenticator
  overwrites a credential of the same account. The choice starts on the first listed item holding
  it, else on the new item (D314);
- "Use another authenticator", which hands the call back to the browser;
- Cancel, which answers `NotAllowedError`.

The click on Confirm is the user presence (UP). UV is reported because the vault is unlocked.
Confirm stays disabled for 500 ms after the request shows and after each time the window takes the
focus, as a browser's permission prompt, so a click a page drew onto the spot where the window
appears is not the user presence (D305).

**Cases.**

| Case | Answer |
| --- | --- |
| Vault locked, or no session host | with no session host, the service worker creates it, pinned and in the background, and forwards the request; the window says BlindVault is locked and offers "Open and unlock" (focuses the session host; once the vault unlocks, the window opens again with the request) or "Use another authenticator"; the page's call waits until its `timeout` (D289) |
| A second request while one is pending, from any tab | handed to the browser at once, with no window and no focus taken, so a tab in the background does not break passkeys in the others (D305) |
| The page aborts its call (`signal`) | the request ends with `NotAllowedError`, sent to a frame no longer waiting; the window closes (D305) |
| `timeout` elapses (the page's, bounded to 30 s to 600 s; 300 s without one), or the window closes | `NotAllowedError`; the window closes |
| get with no passkey for the `rpId` | the window says so and offers another authenticator |
| create on a read-only vault (D73) | handed to the browser at once, with no window |
| create whose `excludeCredentials` lists a held `credentialId` of its `rpId` | the window shows the request as usual; after Confirm, `InvalidStateError`, so a page learns it only from the user's click; a held `credentialId` of another `rpId` is not matched, as by an authenticator, so a site learns nothing of an account on another (D305) |
| a lock while the window is open | the window closes; `NotAllowedError` |
| create whose replaced passkey is in a read-only item (D52, D74) | after Confirm, `NotAllowedError`, and nothing is written, since a write touching a read-only record is blocked as a whole |

A get writes nothing, since `signCount` is always 0 (D268), and so works on a read-only vault.

### 7.5 History

Removing a passkey makes an Item Version that keeps its private key until history is purged; the
remove dialog says so and tells the user to remove the passkey on the site too (D268). Replacing
one keeps the replaced key the same way.

Duplicate keeps the `passkey` fields in the copy, since duplicating and then trashing the original
is how old values leave history (D135), and the original's passkey must not leave with it (D288).

### 7.6 In the app

On every platform, the PWA included (D288):

- the viewer shows each passkey's `rpId`, user name and creation date, under its `label` when it
  has one; never its private key or `userHandle`, and no copy of them;
- the editor can remove a passkey, with the notice of §7.5, and cannot add or edit one: passkeys
  are created only by a site, through the extension;
- search reads `rpId` and `userName`, never `privateKey` or `userHandle` (D132);
- an app older than the `passkey` field type shows the item read-only (D52).

### 7.7 Messages (D289)

The keys of each message, beside `v`, `type` and `id` (§4). Bytes travel as base64url without
padding. Every key is checked by type and range on receipt, and an unknown key is refused.

**Request.** The MAIN-world script draws `request`, 32 lowercase hexadecimal digits, and copies from
the page's `publicKey` options only the keys below, so a key WebAuthn adds later breaks no site:

| Call | `options` |
| --- | --- |
| create | `rp` `{id?, name}`, `user` `{id, name, displayName}`, `challenge`, `pubKeyCredParams` `[{type, alg}]`, `timeout?`, `excludeCredentials?` `[{type, id}]`, `authenticatorSelection?` `{authenticatorAttachment?}`, `extensions?` `{credProps?}` |
| get | `challenge`, `rpId?`, `timeout?`, `allowCredentials?` `[{type, id}]` |

Bounds: `challenge` 16 to 1,024 bytes; `user.id` 1 to 64 bytes; each credential `id` 1 to 1,023
bytes, at most 64 per list, as for `pubKeyCredParams`; `rp.name`, `user.name` and
`user.displayName` at most 255 code points, without a line break; `rpId` and `rp.id` at most 253
characters; `timeout` a non-negative integer. A request that fails a check goes to the browser,
which gives the page its own error.

**Route.**

1. The isolated script sends `passkey-create` or `passkey-get` `{request, options}` to the service
   worker.
2. The service worker drops it when its sender has no tab, and otherwise forwards it to the session
   host as `{request, options, tabId, frameId, origin, topOrigin}`, every value but `request` and
   `options` taken from `MessageSender` (§7.2). With no session host it creates one (§7.4) and
   forwards the request once the page listens.
3. The session host answers at once `{ok: true}`, and the service worker answers the isolated
   script the same. Any other answer, or none, hands the call to the browser.
4. When the request ends, the session host sends `passkey-answer` `{tabId, frameId, request,
   result}` to the service worker, which hands `{request, result}` to that frame with
   `tabs.sendMessage(tabId, …, {frameId})`. The isolated script takes it only from the extension
   and passes it to the MAIN-world script that drew `request`.
5. A call the page aborts: the MAIN-world script sends `passkey-cancel` `{request}` to the isolated
   script, which forwards it to the service worker only for a request it relayed and not yet
   answered. The service worker drops it when its sender has no tab, and otherwise hands
   `{request, tabId, frameId}`, `tabId` and `frameId` from `MessageSender`, to an existing session
   host, creating none. The session host ends the pending request only when all three match, so a
   page ends no other frame's request (D305).

**Result.**

| `result.kind` | Keys | Page |
| --- | --- | --- |
| `browser` | — | the original `create` or `get` with the page's options |
| `error` | `name`: `NotAllowedError` or `InvalidStateError` | a `DOMException` of that name |
| `created` | `id`, `clientDataJSON`, `attestationObject`, `authenticatorData`, `publicKey`, `publicKeyAlgorithm` | a `PublicKeyCredential` (§7.2) |
| `asserted` | `id`, `clientDataJSON`, `authenticatorData`, `signature`, `userHandle` | a `PublicKeyCredential` (§7.2) |

**Window.** The session host draws `token`, 32 lowercase hexadecimal digits, from the CSPRNG, per
request and again when the window opens again on unlock, and opens `confirm.html#<token>`. The window
sends:

- `confirm-details` `{token}`, answered with `state`, whose `kind` is:
  - `locked`;
  - `get`: `origin`, `topOrigin` when it differs, `rpId` and `passkeys` `[{credentialId, title,
    userName?}]`, each `credentialId` (hexadecimal) once (§7.4);
  - `create`: `origin`, `topOrigin` when it differs, `rpId`, `rpName`, `userName`, `displayName`,
    `items` `[{itemId, title, username?}]`, the matching Login items (§5), `replaces`, whether
    Confirm replaces a held passkey of the `rpId` and `userHandle`, and `holder`, the `itemId` of the
    first listed item holding it, when one does (D314).
- `confirm-choice` `{token, choice}`, with `choice` `use` and `credentialId` (get), `save` and
  `itemId` (create into that item), `save-new` (create into a new item), `browser` or `cancel`;
  `credentialId` and `itemId` are keys of the message beside `choice`. The session host answers
  `{ok: true}` once the request ended, `locked` to a `use`, `save` or `save-new` while the vault is
  locked, and `not-found` to a `credentialId` or `itemId` the window did not list.

A token other than the pending request's is answered `not-found`. The session host closes the
window when the request ends, on a lock (§3.2), and on unlock, to open it again with the request.
"Open and unlock" sends `open-host` (§4). The window closed by the user ends the request with
`NotAllowedError`.

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

Firefox's `idle` reports `idle` and `active` only, never `locked` (its `ext-idle.js`, read in
Firefox 161): the Firefox extension has no operating-system lock (§3.2, D311).

## 11. Out of v1

Saving a login when a form is submitted; filling cards and identities; filling a TOTP code (copying
it from the popup stays); an icon in the page's fields; conditional mediation; Safari; importing
passkeys from other managers (D268).

## 12. Tests

Unit tests in `apps/extension` and `apps/web`, Playwright, and by hand on `webauthn.io` for
passkeys (D287):

- Playwright cannot open an extension's page in Firefox, through its own build or WebDriver BiDi.
  The function the session host injects into a page runs in Chromium, Firefox and WebKit pages in
  `apps/web/e2e/extension-fill.spec.ts`; the extension's pages run in Chromium only
  (`apps/extension/e2e`); loading the package in Firefox, the popup and the shortcut there are
  checked by hand, as `browser-matrix.md` lists.
- Playwright cannot click the toolbar or press a command, the gestures that grant `activeTab`. The
  Chromium tests of filling load a test copy of the package whose manifest grants the test sites as
  host permissions, and send the popup's and the service worker's messages from those pages; the
  released package has no host permission.
- Nor can it answer the permission prompt of Settings › Passkeys. The Chromium tests of passkeys
  (`apps/extension/e2e/passkey.spec.ts`) load a test copy granting `<all_urls>`, so the session host
  registers the content scripts at start (§7.1), and click the confirmation window.

Negative tests, each named in `security-invariants.md` (CRYPTO-INV-026 for filling):

- **Matching.** `http:` page; port differs; `www.` differs without the flag; the flag on an IP or a
  public suffix; a private-section suffix (`github.io`); punycode host; unparsable URL field;
  trashed item.
- **PSL.** Every line of `test_psl.txt`.
- **Filling.** A cross-origin iframe with a focused password field is not a target; a transparent
  or zero-size field is not usable (D305); a navigation between probe and fill writes nothing; a fill never submits; a `matches` or `fill` message from
  a content script is ignored; a `fill` for an item that does not match the tab is refused.
- **RPC.** Unknown `v`, `type` or key refused; a message without the extension's sender refused.
- **Locks.** Browser without focus for the hidden-app time locks; the OS lock locks; browsing does
  not reset auto-lock, nor does a passkey request or a window loading its details; closing the
  session host locks; a lock closes the confirmation window.
- **Passkeys.** A forged origin in the message is ignored; an `rpId` of another site, a public
  suffix, or on `http:` goes to the browser; `excludeCredentials` answers only after the click;
  `signCount` 0 and the flags; create on a read-only vault goes to the browser; conditional
  mediation goes to the browser; a create asking for `cross-platform` goes to the browser; a create
  for a held `rpId` and `userHandle` replaces it in every item; a malformed PKCS#8 layout makes the
  item read-only (`record-content.md` §2); search never matches a private key or `userHandle`;
  `excludeCredentials` never matches another `rpId`'s passkey; an IP address as `rpId` goes to the
  browser; a sender without `sender.origin` is dropped; Confirm is disabled for 500 ms after it
  shows and after each focus; a second request goes to the browser; an aborted call ends its
  request, and only that frame's (D305). Each named in `security-invariants.md` under
  CRYPTO-INV-027.
- **Version lock.** A changed hash shows the confirmation before unlock; `onUpdateAvailable` with
  the vault unlocked does not reload.

## 13. Threat model

`threat-model.md` A9 (malicious website) and A6 (store and publisher account) hold the entries this
document specifies.
