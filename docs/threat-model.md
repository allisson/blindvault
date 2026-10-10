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
| Tampers with a record header (LWW, deletion, replay) | Protected | Whole header bound through AAD (D21) | `crypto-spec.md` §8, §9.5 |
| Tampers with Local Config | Protected | Encrypted part under a Master Key subkey; local wraps bound to `localConfigId` (D58, D121) | `crypto-spec.md` §12 |
| Tampers with Argon2id parameters to exhaust memory | Protected | Accepted range checked before deriving | `crypto-spec.md` §6 |
| Rolls the storage back to an earlier copy | Limited, accepted | Undetectable; peers restore newer records at the next sync (D77) | overview §3 |
| Clones the storage into a second running installation | Limited, accepted | Undetectable; documented: replace the clone by pairing (D87, D153) | overview §3 |
| Reads metadata | Accepted | Header, counts, HLCs (editing times and `deviceId`), size buckets, cleartext Local Config fields (§3, D92, D96, D121) | overview §3 |
| Unlocks with a synced passkey's platform account | Partially protected | Shown at setup when the credential is backup-eligible (D84) | overview §5.5 |
| Holds the device while unlocked | Out of scope | OS and device security; auto-lock and hidden-app lock (D88, D54, D151) | overview §7 |

### A2. Network attacker (passive or active), STUN provider

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Reads or alters traffic | Protected | Noise over DTLS; records stay encrypted end to end | overview §8.2, §9 |
| Learns IP addresses | Limited | STUN sees the public IP; LAN-only mode (D136) | overview §9.2 |
| Reads a reconnection payload sent through a third-party channel | Protected | Payload encrypted to the peer with `Noise_K` (D17, D117) | `sync-protocol.md` |
| Reads a pairing payload sent through a third-party channel | Limited | Shows network addresses only; the UI says so (D117) | overview §8.3 |

### A3. Malicious peer or pairing man-in-the-middle

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| MITM during pairing | Protected | SAS from the handshake hash, confirmed on both devices (D148); prologue binds both payloads and DTLS fingerprints | `crypto-spec.md` §13, `pairing-protocol.md` |
| Receives the Master Key before confirmation | Protected | No key before SAS confirmation on both devices (CRYPTO-INV-011) | `pairing-protocol.md` |
| Replays an old authentication | Protected | `Noise_KK` bound to the session (CRYPTO-INV-008, 009) | `sync-protocol.md` |
| Sends corrupted, oversized or foreign records | Protected | Verification on receipt before merge (D57, D64, D66, D129, D144) | `crypto-spec.md` §9.5 |
| Sends records from the future to win LWW | Protected | 24-hour future-clock bound (D76) | `sync-protocol.md` |
| Resurrects deleted data from a stale device | Protected | Persistent tombstones (D27) | `sync-protocol.md` |

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
| Silently replaces the Recovery Envelope | Limited | Envelope immutable per `phraseId`; replacement announced (D43, D44) | `crypto-spec.md` §11 |
| Makes the vault unreadable through LWW | Protected | Vault Key record immutable per epoch; never deleted (D42) | `sync-protocol.md` |

### A6. Malicious host or bundle

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Serves a modified app | Limited | Reproducible builds, published hashes, confirmed asset updates, changed `sw.js` detected and vault locked (D5, D63, D142) | overview §11 |
| Other content on the app's origin | Excluded by deployment | Dedicated origin (D90) | overview §11 |

### A7. Hostile item content (imported or synced)

| Threat | Status | Mitigation | Specified in |
| --- | --- | --- | --- |
| Script injection | Protected | Strict CSP, Trusted Types, text-only rendering, `http:`/`https:` URLs only (D83) | overview §11 |
| Reverse tabnabbing, Referer leak | Protected | `noopener`, `noreferrer`, `no-referrer` (D147) | overview §13 |
| Clickjacking | Limited | Unlock refused while framed (D83) | overview §11 |

## Non-adversarial risks

| Risk | Status | Mitigation |
| --- | --- | --- |
| Browser storage eviction | Partially protected | Persistent storage request, backups, replication; Safari warnings (D55, D103) |
| Accidental deletion | Protected | Trash with 30-day purge, item history (D6, D7) |
| Sync conflict | Protected (items), limited (folders) | HLC, LWW, item history; folders without history (D14) |
| Device clock wrong | Limited | Future-clock bound, read-only rules (D73, D74, D76, D149) |

## Out of scope (documented to users)

A compromised operating system, malware reading browser memory, malicious extensions, an attacker
holding an unlocked device, keyloggers, a malicious browser, and a malicious JavaScript bundle run
before integrity verification, the first load included (§3).
