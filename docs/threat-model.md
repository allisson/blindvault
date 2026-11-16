# BlindVault — Threat Model

> Reorganizes `overview.md` §3 by attacker, with pointers to where each mitigation is specified.
> It introduces no decision: the overview prevails, and a change here starts as a change there.

## Assets

Vault contents, secrets, passwords, credentials, recovery material (the Recovery Phrase and its
entropy), cryptographic keys (Master Key, Vault Keys, record keys, KEKs, device static keys),
encrypted backups and synchronized records (§3).

## Trust assumptions

- The browser, the operating system and the JavaScript bundle running the app are trusted while the
  vault is unlocked. Cryptographic confidentiality and application integrity are separate
  properties: a malicious bundle, extension, browser or OS can read an unlocked vault (§3).
- The first load of the app is trusted on first use (TOFU, D5); later updates of the app's assets
  are confirmed by the user, and a changed service worker is detected but cannot be prevented (D63,
  D142).
- libsodium, the copied Noise state machine (D157) and the CBOR decoder (D10) are correct; the
  copied Noise code is gated by the official vectors.
- Whoever holds the Master Key or the Vault Key holds the vault. v1 has no revocation (§20) and
  never rotates the Master Key (D11).

## Attackers

### A1. Holder of a locked device or a copy of its storage

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Reads vault content | Protected | Every record encrypted; keys wrapped under the Device KEK or PRF KEK | `crypto-spec.md` §8–§12 |
| Guesses the local password offline | Partially protected | Argon2id calibrated to about 1 s, 64 MiB floor; zxcvbn score 4 required (D9, D71) | `crypto-spec.md` §6 |
| Reads the local password saved by the browser | Partially protected | Depends on how the browser protects saved passwords; the UI warns against saving it wherever a local password is set (D175) | overview §5.3 |
| Tampers with a record header (LWW, deletion, replay) | Protected | Whole header bound through AAD (D21) | `crypto-spec.md` §8, §9.5 |
| Tampers with Local Config | Protected | Encrypted part under a Master Key subkey; local wraps bound to `localConfigId`, so no part moves to another device of the vault (D58, D121) | `crypto-spec.md` §12 |
| Tampers with Argon2id parameters to exhaust memory | Protected | Accepted range checked before deriving | `crypto-spec.md` §6 |
| Reads a copy of the storage taken before a local password change or a passkey removal | Accepted | The copy still opens with the old password or passkey; a change protects later copies only (D266) | overview §5.3 |
| Points the STUN list at its own server, with write access to `localStorage` | Limited, accepted | The list is not authenticated; the screen shows the list in use, and the server learns the public IP at the next pairing or sync (D209, D266) | overview §9.2 |
| Rolls the storage back to an earlier copy | Limited, accepted | Undetectable; peers restore newer records at the next sync (D77) | overview §3 |
| Clones the storage into a second running installation, or copies another device's whole Local Config into this one, opened with the same local password or a synced passkey | Limited, accepted | Undetectable; documented: replace the clone by pairing (D87, D153, D265) | overview §3 |
| Reads metadata | Accepted | Header, counts, HLCs (editing times and `deviceId`), size buckets, cleartext Local Config fields (§3, D92, D96, D121) | overview §3 |
| Unlocks with a synced passkey's platform account | Partially protected | Shown at setup when the credential is backup-eligible (D84) | overview §5.5 |
| Holds the device while unlocked | Out of scope | OS and device security; auto-lock and hidden-app lock (D88, D54, D151), kept by the wall clock and running before a creation or a restore commits (D263); changing the local password or setting up a passkey needs the current password (D168, D172); exporting a backup, which yields the Master Key, needs the local password or the passkey again (D181) | overview §5.5, §7, §10 |

### A2. Network attacker (passive or active), STUN provider

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Reads or alters traffic | Protected | Noise over DTLS; records stay encrypted end to end | overview §8.2, §9 |
| Learns IP addresses | Limited | STUN sees the public IP; the user chooses the providers or uses LAN-only mode (D136, D209) | overview §9.2 |
| Learns addresses from an old reconnection offer delivered again | Limited | The session fails at DTLS or `Noise_KK`, though the browser may first send ICE and STUN checks to the old addresses (D266) | `sync-protocol.md` §4.4 |
| Reads a reconnection payload sent through a third-party channel | Protected | Payload encrypted to the peer with `Noise_K` (D17, D117) | `sync-protocol.md` |
| Reads a pairing payload sent through a third-party channel | Limited | Shows network addresses only; the UI says so (D117) | overview §8.3 |

### A3. Malicious peer or pairing man-in-the-middle

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| MITM during pairing | Protected | SAS from the handshake hash, confirmed on both devices (D148); prologue binds both payloads and DTLS fingerprints | `crypto-spec.md` §13, `pairing-protocol.md` |
| Searches offline for matching SAS values, replacing copy/paste payloads | Protected | The initiator's commitment and nonces revealed after the handshake: one guess in 10⁶ per pairing (D199) | `pairing-protocol.md` §6 |
| Receives the Master Key before confirmation | Protected | No key before SAS confirmation on both devices (CRYPTO-INV-011) | `pairing-protocol.md` |
| Replays an old authentication | Protected | `Noise_KK` bound to the session (CRYPTO-INV-008, 009) | `sync-protocol.md` |
| Sends corrupted, oversized or foreign records | Protected | Verification on receipt before merge (D57, D64, D66, D129, D144, D260) | `crypto-spec.md` §9.5 |
| Sends records from the future to win LWW | Protected | 24-hour future-clock bound (D76), applied to a purged tombstone at its purge date (D262) | `sync-protocol.md` |
| Resurrects deleted data from a stale device | Protected | Persistent tombstones (D27) | `sync-protocol.md` |
| Floods the link before the SAS or the sync handshake | Protected | At most 2,098,388 bytes unread until the peer is authenticated, then the link closes (D264) | `pairing-protocol.md` §4 |

### A4. Holder of a `.bvault` file

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Opens it with a guessed export password | Partially protected | Argon2id at the D9 floor; 10^14 estimated guesses required (D134) | `backup-format.md` |
| Truncates or alters it | Protected | Authenticated header; `secretstream` final tag required (D95) | `backup-format.md` |
| Exhausts memory with tampered parameters | Protected | Accepted range checked before Argon2id (D78) | `backup-format.md` |
| Reads metadata | Accepted | `phraseId`, phrase date, format version, keyslot presence, file size (§3) | overview §10 |
| Holds an old Recovery Phrase | Accepted | An exposed phrase is a Master Key compromise; regeneration is for a lost phrase (§5.4) | overview §14 |

### A5. Holder of the Master Key (retired device, former device, leaked backup password)

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Keeps reading replicated data | Accepted | No revocation in v1 (§20); response is re-founding (D28) | overview §14 |
| Returns under a new identity or forges a retirement | Limited | New-device and retirement notices (D47, D48); re-founding | overview §8.4 |
| Forges its own record back to not retired | Protected | A retired copy wins under the same header too; every Device record is sent (D31, D261) | `sync-protocol.md` §1.3, §8 |
| Destroys items or their history with records that look honest | Accepted | A purged tombstone before its date is rejected (D262); a tombstone dated 30 days back, or 20 newer Item Versions, still remove an item or its history on every device; earlier backups keep them | `sync-protocol.md` §1.3 |
| Silently replaces the Recovery Envelope | Limited | Envelope immutable per `phraseId`; replacement announced (D43, D44) | `crypto-spec.md` §11 |
| Makes the vault unreadable through LWW | Protected | Vault Key record immutable per epoch; never deleted (D42) | `sync-protocol.md` |
| Exhausts a tab's memory once authenticated | Accepted | No cap after both SAS confirmations or the sync handshake, since a vault may wait unread; the tab drops, nothing persists or leaks (D264) | `pairing-protocol.md` §4 |

### A6. Malicious host or bundle

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Serves a modified app | Limited | Reproducible builds, published hashes, confirmed asset updates, changed `sw.js` detected and vault locked (D5, D63, D142) | overview §11 |
| Other content on the app's origin | Excluded by deployment | Dedicated origin (D90) | overview §11 |
| Ships a compromised dependency in the bundle | Limited | Few dependencies, each justified; exact versions, 14-day minimum release age, no install scripts, updates reviewed; the reproducible build proves only that the bundle matches the source (D243) | overview §16, `architecture.md` |

### A7. Hostile item content (imported or synced)

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Script injection | Protected | Strict CSP, Trusted Types, text-only rendering, `http:`/`https:` URLs only (D83) | overview §11 |
| Reverse tabnabbing, Referer leak | Protected | `noopener`, `noreferrer`, `no-referrer` (D147) | overview §13 |
| Clickjacking | Limited | The app does not open inside a frame (D83, D193) | overview §11 |

### A8. Author or holder of an import file

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Exhausts memory with an oversized file or a zip bomb | Protected | Any file above 100 MB rejected before parsing; a zip archive beyond 100 MB uncompressed or 10,000 entries rejected (D130) | overview §15 |
| Exhausts memory through `.blindpass` parameters | Protected | BlindPass's Argon2id parameters are constants, never read from the file (D126) | overview §15, `blindpass-format.md` |
| Sends a malformed file | Protected | Shape validated per format; rejected with a readable message, nothing written (D123) | overview §15 |
| Gets plaintext persisted | Protected | File read only in memory; items encrypted like any write; a test asserts that no source plaintext reaches IndexedDB or `localStorage` (CRYPTO-INV-001) | overview §15, §18 |
| Gets a hidden field shown unmasked | Protected | A field the source marks hidden becomes a `secret` field (D242) | overview §15 |
| Reads the plaintext export left on disk | Limited | Outside the vault: warning before the file is chosen, reminder to delete it after the import (D123) | overview §15 |

## Non-adversarial risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| Browser storage eviction | Partially protected | Persistent storage request, backups, replication; the persistence status and storage warnings: Safari in a plain tab, not kept on the only device, nearly full (D55, D103, D119, D196) |
| Accidental deletion | Protected | Trash with 30-day purge, item history (D6, D7) |
| Sync conflict | Protected (items), limited (folders) | HLC, LWW, item history; folders without history (D14) |
| Device clock wrong | Limited | Future-clock bound, read-only rules (D73, D74, D76, D149) |

## Before v1.0 (planned)

Threats of the attachments, the browser extension, stored passkeys and the Android app, which come
before v1.0 (D275). Their direction is fixed (overview §20) and their specifications are not
written yet. Every entry is planned; the specifications in `docs/attachments.md`, `docs/extension.md` and `docs/android.md`
will refine them.

### A9. Malicious website (extension and Android autofill)

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Claims another origin to get a passkey assertion | Planned | The origin and frame come only from the browser's `MessageSender`, never from the page (D267) | overview D267 |
| Asks for a passkey of another site through its `rpId` | Planned | The `rpId` must equal the origin's host or be a registrable suffix of it, checked against a shipped Public Suffix List (D267) | overview D267 |
| Signs in with a stored passkey without the user knowing | Planned | A confirming click in the app's UI on every use (UP) (D268) | overview D268 |
| Gets a password filled into a look-alike or embedded page | Planned | Fill only on a user gesture, only when the item's URL host equals the frame's origin, never into a cross-origin iframe (D267) | overview D267 |

### A10. Other app on the Android device

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Asks the credential provider for another app's or site's passkey or password | Planned | A native app's package is bound to the `rpId` or the item's domain through the site's `assetlinks.json`; a browser's origin is trusted only from a shipped allowlist of privileged browsers (D269) | overview D269 |
| Learns that the user has the app of a site | Planned, accepted | Fetching `assetlinks.json` tells the site that its app is used; it carries no vault data (D269) | overview D269 |

### Other planned entries

| Attacker | Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- | --- |
| A1 | Unlocks the Android app on a stolen locked phone | Planned | The Keystore KEK requires a BiometricPrompt on every use, is invalidated when the enrolled biometrics change, and is bound to `localConfigId`; setting it up needs the local password (D271) | overview D271 |
| A1 | Reads a removed stored passkey from item history | Planned, accepted | Kept until history is purged; the UI says so and tells the user to remove the passkey on the site (D268) | overview D268 |
| A3 | Sends a substituted or oversized attachment blob | Planned | Each received blob checked against the hash in its item's `attachment` field; blobs above 10 MB rejected (D273) | overview D273 |
| A6 | Pushes a malicious extension version through a store or the publisher account | Planned, limited | The store and the publisher account are roots of trust; the version lock opens no vault until the user confirms the new version and manifest hash (D270) | overview D270 |
| A6 | Ships a modified APK | Planned, limited | Signing key offline and out of CI; reproducible APK with published SHA-256 and rebuild instructions (D270) | overview D270 |
| A6 | Blocks new Android installs by terminating the Play Console account that registers the package | Planned, accepted | The account is a root of trust for installs, not for integrity; installed apps keep working, ADB and the advanced flow still install (D274) | overview D274 |
| A7 | Runs a hostile attachment in the app's origin | Planned | Attachments are only downloaded, never previewed (D273) | overview D273 |

## Out of scope (documented to users)

A compromised operating system, malware reading browser memory, malicious extensions, an attacker
holding an unlocked device, keyloggers, a malicious browser, and a malicious JavaScript bundle run
before integrity verification, the first load included (§3).
