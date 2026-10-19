# Sync protocol

This document specifies how records received from elsewhere join the vault. Section 1, the merge
rules, is what a backup merge applies (Phase 2, D182). Section 2, the full transfer, is what a
pairing and a re-admission run after their handshake (`pairing-protocol.md`, Phase 4, D199).
Sections 3 to 14 are the sync session of two registered devices (Phase 5, D12, D17, D213): the
reconnection payload, the `Noise_KK` handshake, summaries, the transfer of divergent records and
the live session. They reuse the transfer messages of section 2.1 and the merge rules of section 1.

The overview prevails over this document (sections 9.2 and 10). Record identities, headers and
verification on receipt are in `crypto-spec.md`.

## 1. Merge

A **transfer** is the set of records merged together: a backup's whole payload, or one sync
exchange. A record is identified by (`recordType`, `recordId`) (D158); "the local copy" is the
record of the same identity this device holds.

### 1.1 Checks before merging a backup

A backup merge runs these checks in order and stops at the first failure. Each failure rejects the
whole merge and writes nothing (§10, D61, D64, D182).

1. The backup's `vaultId` equals the local vault's (D13): `different-vault`.
2. The backup's Master Key equals the local one (D57). The unlocked session holds no Master Key, so
   the backup's is compared through its `K_vaultKeyWrap` subkey with the session's, with
   `sodium_memcmp`, as Check Recovery Phrase does (D180): `master-key-mismatch`.
3. Every record passes verification on receipt (`crypto-spec.md` §9.5) under the local vault's
   keys, and the domain checks of `record-content.md`, as at unlock (D59, D64): `corrupt-record`,
   naming the record.
4. No record's `hlc` is beyond the future-clock bound of this device's clock (D76): `future-clock`.
   The merge can be retried once the clock reaches the greatest `physicalMs` held minus the bound.
5. No record breaks the immutability of section 1.3 (D42, D44): `immutable-record`, naming it.

`packages/backup` has already run the file checks of `backup-format.md` §8 steps 1 to 8. A record
with an unknown `recordFormatVersion` or `recordType` fails there (D61, D81).

### 1.2 Last-write-wins

For two copies of one record, the one with the greater `hlc` wins (D19). With equal `hlc`, the one
with the higher `recordFormatVersion` wins (D38), and with that equal too the local copy stays: the
two have identical summaries and are not compared further (the residual risk of §9.2).

A received record whose identity this device does not hold is added. A received record whose local
copy was kept aside as corrupt at unlock replaces it whatever the HLCs, since the local header
cannot be trusted (D182).

### 1.3 Rules per record type

- **Item.** Last-write-wins (section 1.2). The losing copy goes to history (D6):
  - a loser with content becomes an Item Version of that content with the loser's own `hlc`,
    `deleted = false` and the derived `versionId`, which is not written when already held;
  - a losing tombstone with content does the same: its content can be an edit kept nowhere else
    (D56);
  - a losing purged tombstone adds no version.
  A winning tombstone with content whose purge date has passed (D7, D27) is purged on arrival: it is
  stored with empty content under its unchanged header.
- **Item Version.** Added when not held; an Item Version whose `versionId` is held stays as held.
- **Folder.** Last-write-wins; the losing copy is dropped, since folders have no history.
  A winning tombstone with content past its purge date is purged on arrival, as for an item.
- **Device.** A retired copy always beats a non-retired one, whatever the HLCs (D31). Between two
  retired or two non-retired copies, last-write-wins.
- **Vault Key.** A received Vault Key record whose epoch is held must have the held copy's `hlc` and
  unwrap to the same Vault Key, compared with `sodium_memcmp`; it then changes nothing. Any other
  version is an immutability violation (D42). A record of an epoch not held is added.
- **Recovery Envelope.** A received envelope with the held envelope's `phraseId` must have the same
  `hlc` and the same metadata (`keyslotPublicKey`, `phraseId`, `phraseCreatedAt`); it then changes
  nothing. Any other is an immutability violation (D44). An envelope with another `phraseId` merges
  by last-write-wins: a newer one is a regeneration.

### 1.4 History after the transfer

Once every record of the transfer is merged:

1. An item whose final copy is a purged tombstone keeps no Item Version: every version of it,
   held, received or made from a loser, is dropped (D137).
2. Every other item keeps the 20 greatest `(hlc, versionId)` among its held, received and loser
   versions (D6); the others are dropped, held ones deleted and new ones not written.
3. A conflict loser dropped by either step, whose `hlc` carries this device's `deviceId`, is reported
   for the D70 notice naming the item.

### 1.5 HLC and Local Config

Every merged record's `hlc` advances the HLC state by the receive rule (D109); after the checks of
section 1.1, none is beyond the bound. The merge issues no HLC: an Item Version made from a loser
carries the loser's `hlc`. It therefore runs while the vault is read-only because the clock went
back (D73).

One storage transaction writes every added, replaced and purged record, the Item Versions made from
losers, the deletion of dropped versions and the new Local Config (D62). The Local Config records:

- the HLC state;
- as seen, every `deviceId` held after the merge, and as seen as retired, every retired one (D48);
- the `phraseId` of the held Recovery Envelope as the last one seen (D43).

### 1.6 Notices

A merge reports, for the UI to show once (D182):

- **Recovery Phrase superseded (D145, D185):** an envelope of another `phraseId` replaced the held
  one, and the held one was written by this device (its `hlc` carries this device's `deviceId`).
  The notice names the replaced phrase by `phraseId` and creation date, and takes the place of the
  D43 notice.
- **Recovery Phrase changed (D43):** otherwise, the held envelope's `phraseId` differs from the last
  one seen.
- **New devices (D48):** Device records whose `deviceId` this device had never seen, neither in
  Local Config nor among the Device records it held, its own excepted; one that arrives retired is
  marked so (D53). No notice when the device held no Device record before the merge.
- **Retired devices (D47):** Device records already seen, not yet seen as retired, now retired; its
  own excepted.
- **Dropped losers (D70):** the items of section 1.4 step 3.

A device whose own Device record is retired after the merge shows the D41 notice for as long as it
holds it; that notice is derived from the held record, not stored.

## 2. Full transfer (D199)

A full transfer sends every record a device holds, inside the Noise channel of an admission
(`pairing-protocol.md` §10), with no summaries. It is the first full sync of a pairing and the
merge sync of a re-admission (§8.4).

### 2.1 Messages

Each message has the keys `v` (1) and `t` of `pairing-protocol.md` §10.2, plus:

| `t` | Keys | Meaning |
| --- | --- | --- |
| `records-begin` | `count`: uint, at most 2⁵³ − 1 | the number of `record` messages that follow |
| `record` | `r`: bstr | one record envelope exactly as stored (`crypto-spec.md` §9.2) |
| `records-end` | — | the last message of the transfer |

The sender sends `records-begin`, then each held record once, in any order, then `records-end`.
The receiver aborts (`protocol-error`) when the number of `record` messages differs from `count`,
when two records have the same identity (`recordType`, `recordId`, D158), or when a `record`
arrives outside `records-begin` and `records-end`. An envelope longer than the largest envelope
is rejected before decoding (D129).

### 2.2 Pairing

A sends every record it holds, the Device records it has just written included. B holds nothing,
so it adds every record, as a fresh restore does:

- every record is verified on receipt (`crypto-spec.md` §9.5) and passes the domain checks of
  `record-content.md`; one failure aborts the whole pairing (`verification-failed`), since B must
  not commit an incomplete vault;
- an unknown `recordFormatVersion` or `recordType` aborts it (`unsupported-format`, D68, D81);
- a record beyond the future-clock bound is accepted and read-only until the clock reaches it
  (D101);
- nothing is persisted before B's commit (`pairing-protocol.md` §8 step 6, D33).

### 2.3 Re-admission

Both sides send every record they hold, at the same time, and each merges what it receives with
section 1, except section 1.1: the key-confirmation MACs already proved the same Master Key, and
so the same `vaultId` (D29). As in sync (§9.2), a received record that fails verification on
receipt, is beyond the future-clock bound or breaks the immutability of section 1.3 is rejected
and reported, not merged; the other records merge, and the re-admission completes. The merge
result lists each rejected record with its reason (D206). A record of an unknown format or type
aborts the re-admission instead (`unsupported-format`), before the merge of the side that
received it, as a pairing does before its commit; the Device records already written and a merge
the other side already committed stay. Before it aborts, the side that received it commits its
Local Config alone with the peer in the incomplete-backup list (D68, D81, D206, D227).

The merge writes in one storage transaction, with the completed sync with the peer (D34), and its
notices are those of section 1.6.

## 3. Preconditions

A device offers to sync with a peer only if (§9.1, D45, D113):

- its vault is unlocked and it holds its own Device record, not retired;
- it holds the peer's Device record, not retired.

The one exception is a **retirement notice** (D219): the user picks a retired peer to tell it that
it is retired, and the session sends it only that record (section 6).

A vault read-only because the clock went back (D73) still syncs: it receives records, and the
merge issues no HLC (section 1.5). The user picks the peer on both devices before any payload is
shown or read ("Sync with {name}"), so each device knows which static key to expect (D213).

**Roles.** As in pairing, **I** is the device that shows the first payload; it makes the WebRTC
offer and initiates `Noise_KK`. **R** answers. Either device can be I.

**Starting (D216).** The user picks the peer in Settings › Devices on both devices, then chooses on
each whether it shows its code first (I) or reads the other's (R). No password is asked: no key
leaves the device. Each code is shown as a QR code and as text, and read with the camera or pasted
(section 4.4). Only one flow runs at a time: a sync and a pairing or re-admission end each other.

**State (D226).** Settings offers as peers only the Device records this device holds, not retired
and not its own, so the user cannot pick a device `openSync` would refuse. The peer's row says
"Syncing now" from the connection until both sent `committed`, then "Live sync" (section 10);
"This device" shows the latest sync with any peer, with its time and the peer's name.

## 4. Reconnection payload

### 4.1 Bytes

The payload as shown or pasted is `u8 version ‖ m`, encoded in base45 like the pairing payload
(`pairing-protocol.md` §3.4), where `version` is **1** and `m` is one `Noise_K` handshake message
(section 4.2). Nothing else is in the clear: no `deviceId`, no address (D117, D213).

The plaintext of `m` is exactly these fields, in this order, with the encodings of
`pairing-protocol.md` §3.1 and §3.2:

| Field | Size | Value |
| --- | --- | --- |
| `flags` | u8 | bit 0: role, 0 = I, 1 = R. Bits 1–2: DTLS `setup`, as in pairing. Bits 3–7: 0 |
| `sessionId` | 16 | random from I; R repeats I's |
| `fingerprint` | 32 | SHA-256 fingerprint of this device's DTLS certificate |
| `ufrag` | u8 length ‖ bytes | ICE username fragment, as in pairing |
| `pwd` | u8 length ‖ bytes | ICE password, as in pairing |
| `candidates` | u8 count ‖ entries | 1 to 8 entries, as in pairing (host, mDNS and srflx) |

There is no `holdsVault` flag, no list of supported formats and no commitment: there is no SAS,
and a record of an unknown format or type is rejected one by one (section 9, D68).

### 4.2 `Noise_K`

- Protocol name: `Noise_K_25519_ChaChaPoly_BLAKE2b` (D17), from the copied implementation of D157
  in `packages/crypto` (D200). One message, `e, es, ss`, after the pre-messages `s` of both sides.
- The **sender** of a payload is the `Noise_K` initiator and its **receiver** the `Noise_K`
  responder, whatever their session roles: I's payload is sent by I to R, R's by R to I.
- Static keys: the sender's own identity, and the receiver's public key from the receiver's Device
  record the sender holds.
- Prologue: `prologue_K = layout("bv.reconnect.v1", vaultId, role)` (`crypto-spec.md` §13), where
  `role` is the sender's session role as the label `"initiator"` (I) or `"responder"` (R). Binding the role keeps I's
  payload from being given back to I as R's; binding `vaultId` keeps a payload to one vault.
- The plaintext of section 4.1 is the message payload. The ephemeral key is new for each payload.

`Noise_K` authenticates the sender to the receiver and hides the payload from the channel; it gives
no replay protection, which comes from `Noise_KK` (section 12, D17).

### 4.3 Reading a payload

The receiver removes line breaks and tabs, decodes base45 strictly, and refuses the payload, before
any connection and with nothing sent, when:

- the text is empty or not base45 (`malformed`);
- `version` is not 1 (`version`): the UI asks to update the app;
- `m` is shorter than 133 bytes or longer than 762, the plaintext bounds of section 4.1 (85 to 714
  bytes) plus the ephemeral key and the tag (`malformed`), checked before any decryption, so a
  text cut short is not reported as a code from another device (D214);
- `m` does not decrypt with the picked peer's public key, this device's identity and the expected
  `role` (`not-from-peer`): the UI says the code is not from {name} for this device, which covers
  a payload from another device, to another device, of another vault or of the wrong role;
- the plaintext breaks section 4.1: a reserved bit set, `setup` 3, I's `setup` not `actpass` or
  R's `actpass`, a role in `flags` other than the expected one, any length or count out of range,
  an unknown candidate kind, a port of 0, bytes left after the last field (`malformed`);
- R's `sessionId` differs from the one I sent (`malformed`).

The checks run in this order. The decoding is strict: one plaintext has exactly one encoding.

### 4.4 Delivery

The payload is defined apart from how it travels (D12). A **delivery** carries the bytes
`version ‖ m` from one device to the other, and nothing above it depends on which one. `packages/sync`
defines it as an interface: send this device's payload, receive each payload delivered to it, close
(D215).

- **v1: manual.** The device shows its payload as base45 text (section 4.1), as a QR code or to copy;
  the user reads the peer's QR code or pastes its text. A text that is not base45, or empty, is
  refused at once (`malformed`).
- **After v1: a mailbox** (Nostr, ntfy, §9.1 of the overview) implements the same interface. Its
  topic and adapters are designed then; the payload, `Noise_K`, `Noise_KK` and every message of this
  document stay as they are.
- **The pairing payload is never delivered this way.** It travels in the clear and is checked by the
  SAS; it stays a QR code or copy/paste (`pairing-protocol.md` §3.4).

A delivery may lose, duplicate, reorder or replay payloads, and carry bytes from anyone who can
reach it. The receiver reads each delivered payload as in section 4.3 and takes the **first one that
opens**; every refused payload, `version` included, is reported (the UI shows the reason on the
manual delivery) and the wait goes on, until the delivery closes or the payload timeout of
section 12 ends the session. This is safe without any help from the delivery:

- a payload that does not open, from anyone, changes nothing;
- R's answer of another session is `malformed`, because its `sessionId` differs (section 4.3);
- an old offer from I opens, but the session it leads to fails at DTLS, whose fingerprint is I's
  old certificate, or at `Noise_KK`, whose prologue binds that old payload, before any message
  (section 5, D17).

## 5. Connection and handshake

The connection is that of `pairing-protocol.md` §4: each side rebuilds the other's SDP from the
decrypted payload, the browser checks the DTLS fingerprint, and I creates one reliable, ordered
DataChannel. DTLS is transport only.

Then `Noise_KK_25519_ChaChaPoly_BLAKE2b`, with I as initiator:

- prologue `prologue_KK` of `crypto-spec.md` §13, where `reconnection_initiator` and
  `reconnection_responder` are the `Noise_K` messages `m` of I's and R's payloads exactly as
  transmitted (their ciphertext, without the `version` byte);
- static keys: each device's identity, and the peer's public key from its Device record;
- empty handshake payloads; each handshake message is one DataChannel message.

A completed handshake proves that the peer holds the private key of its registered identity, bound
to this session (CRYPTO-INV-008). A handshake that fails ends the session (`protocol-error`), with
nothing else sent. Every later message travels in the Noise channel, framed as in
`pairing-protocol.md` §10.1 (CRYPTO-INV-009).

**Implementation (D217).** `packages/crypto` runs the handshake with `startNoiseKK` and computes
`prologue_KK` with `syncPrologue`; `packages/sync` drives it with `syncHandshake`. Each message is
48 bytes: an ephemeral key and the tag of the empty payload. A handshake message that carries a
payload is refused. On a failure the side that refused a message reports `invalid` and the other
sees the link close (`closed`); nothing is sent either way, so `protocol-error` is the local reason
only. The UI shows a sync as connected only once the handshake completed, which stops the payload
timeout of section 12, and reports a failed handshake as a peer it could not verify. Closing after
the handshake sends `abort` (section 11.2, D218).

## 6. Retired peer (D31, D45, D69)

As soon as the handshake completes, and again whenever the peer's Device record becomes retired
during the session (a local retirement, or a record merged from the peer), a device whose copy of
the peer's Device record is retired:

1. sends `retired` with that record's envelope, the only record it ever sends that peer;
2. sends `abort` with `retired-peer` and ends the session.

It sends no summary and no other record to a retired peer (CRYPTO-INV-015).

A device that receives `retired` checks that the envelope is its own Device record (`recordId` is
its `deviceId`), retired, and that it passes verification on receipt (`crypto-spec.md` §9.5) and
the Device record checks (D26); it then merges that one record (section 1), which shows the D41
notice, and ends the session. Any other `retired` aborts (`protocol-error`), merging nothing. A
device that receives its own Device record retired in any transfer of the session also ends it,
after its merge commits, and shows the D41 notice (D69).

**Implementation (D219).** Right after `Noise_KK`, before the sync shows as connected, the vault
reads the peer's Device record again from storage and verifies it (`peerRetirement`): a retired one
is sent as `retired`, then `abort` with `retired-peer`; one that fails verification sends only
`abort` with `verification-failed`. A retirement made while the codes were exchanged is caught
there. `mergeOwnRetirement` merges a received `retired` by section 1 without 1.1, in one commit that
records no completed sync (D34), only when it is this device's own Device record, retired, passing
verification and within the future-clock bound; otherwise the device aborts with `protocol-error`.
Once merged, the device shows the sync ended as retired, however the peer ends it. Two devices that
each hold the other retired each send `retired` and `abort`; neither merges, since neither reads a
message after its own `abort`. Settings offers the retirement notice from its list of retired
devices (section 3).

**Implementation (D220).** The controller asks the open sync for the same check after each of its
commits that may retire the peer, a local retirement or a backup merge; a record merged from the
peer comes with the transfer, which asks for it after its merge. Before `Noise_KK` the check does
nothing, since the one above follows it. Checks run one at a time: a retirement during the check
after `Noise_KK` sends one `retired` and one `abort`, and the sync never shows as connected. This
device's own record retired in a transfer ends the session after its commit, with the transfer.

## 7. Summaries

After the handshake, and the check of section 6, both sides send their summary at the same time:
`summary-begin` with `count`, then the entries in `summary` messages of 1 to 16,384 entries each,
then `summary-end`. An entry is the CBOR array

```
[recordFormatVersion, recordType, recordId, hlc, deleted, keyEpoch]
```

with `recordFormatVersion` and `recordType` as uint ≤ 65,535, `recordId` as bstr 16, `hlc` as in a
record (`crypto-spec.md` §4), `deleted` as bool and `keyEpoch` as uint ≤ 2³² − 1. An entry encodes
in at most 62 bytes, so a `summary` message of 16,384 entries stays below the message cap of
`pairing-protocol.md` §10.1.

The summary lists every record the device holds, once, in any order, except the records kept aside
as corrupt at unlock: those the peer's copy replaces whatever the HLCs (section 1.2, D182).

The receiver aborts (`protocol-error`) when the number of entries differs from `count`, when two
entries have the same identity (`recordType`, `recordId`, D158), on an entry out of its ranges, or
on a `summary` outside `summary-begin` and `summary-end`. An unknown `recordFormatVersion` or
`recordType` in an entry is not an error: it only tells what the peer holds.

## 8. What each side sends

Once a device has the peer's whole summary, it sends each record it holds for which:

- the peer's summary has no entry of the same identity; or
- for an **Item**, the peer's entry has another `hlc` or `recordFormatVersion`, older or newer
  (D223); or
- for an **Item Version** or **Folder**, its copy wins last-write-wins against the peer's entry: a
  greater `hlc`, or an equal `hlc` and a higher `recordFormatVersion` (section 1.2); or
- for a **Device**, **Vault Key** or **Recovery Envelope** record, the peer's entry differs from
  its own in any field.

The Item rule sends a losing copy too, so both devices apply section 1.3 to the same two copies:
each keeps the same winner and stores the same loser as an Item Version with the same `versionId`,
and one sync leaves both with the same records. Sending only the winner would leave the loser on
the device that wrote it until the next sync. An older Item whose state the peer already holds in
history changes nothing there.

An Item Version's `itemId` is encrypted, so the selection cannot tell which item a version belongs
to. A device that purged an item is therefore sent the versions of it that the peer still holds,
at every sync until the peer runs its own purge, whose date is the same (`hlc` plus 30 days, D7).
Section 1.4 drops them once the transfer is merged, writing nothing (D137).

The last rule exists because a summary does not carry the `retired` flag: a retired Device record
must reach a peer that holds a newer non-retired copy, forged or not, and a Vault Key record or
envelope that differs must reach the peer so that it detects the immutability violation (D31, D42,
D44). These records are few.

A tombstone is sent as any Item or Folder is, and storage never deletes one (D224). A record whose
summaries are identical is never sent. This keeps the residual risk of §9.2: two
copies of one record with identical summaries, such as a purged and an unpurged copy of one
tombstone, do not converge.

Before sending, the device reads each record it sends again from storage and verifies it as an
export does (D181); a record that fails ends the session (`verification-failed`) and is named to
the user, as an export names it.

## 9. Transfer and commit

Each side sends what section 8 selects as one transfer of section 2.1 (`records-begin` with
`count`, which may be 0, the `record` messages, `records-end`), then receives the peer's. The
receiver keeps the received records in memory until `records-end`, then merges them with section 1,
except section 1.1, as a re-admission does (§2.3):

- a record that fails verification on receipt (`crypto-spec.md` §9.5) or the domain checks, is
  beyond the future-clock bound (D76) or breaks the immutability of section 1.3 is rejected and
  reported, not merged (CRYPTO-INV-018, CRYPTO-INV-022);
- a record of an unknown `recordFormatVersion` or `recordType` is rejected, the UI asks to update
  the app, and the peer's `deviceId` is recorded in Local Config for the incomplete-backup warning
  (D68, D81, D115);
- every other record merges.

One storage transaction writes the merge, with section 1.5, plus:

- the completed sync with the peer (D34);
- the removal of the peer from the incomplete-backup list when no record of this transfer was
  rejected for its format or type (D115).

Then the device sends `committed`. The merge result shows the notices of section 1.6 and lists each
rejected record with its reason. Each device records the completed sync at its own commit, without
waiting for the peer's `committed`. The session becomes live once the device has sent its
`committed` and received the peer's.

A device that never received the peer's `records-end` commits nothing from that transfer.

**Implementation (D222).** `packages/sync/src/exchange.ts` runs sections 7 to 9: `selectRecords` is
the rule of section 8, with the Item rule of D223, and `exchange` sends both summaries and both transfers at the same time,
then calls the merge. A `retired` may come in place of any of the peer's messages: it is merged as
section 6 says, and the peer's `abort` follows. The session sends one message at a time, so the
frames of two never interleave, and its `abort`, with `retired` before it for section 6, leaves
after the message being sent and before any other. In `packages/vault`, `SyncGrant.summary`,
`records` and `merge` are sections 7, 8 and 9: the merge is the re-admission's (§2.3), except that
a record of an unknown format or type is rejected and reported, with the peer recorded for the
export warning in the same commit (D227), and the peer's own Device record retired merges. After the merge, the app ends the
session when this device's own record arrived retired (D69), otherwise runs the check of section 6
again, then sends `committed`. The merge runs once over the whole transfer, so section 1.4 cuts
history against each item's final copy: a restore from the trash reaching a device that purged the
item keeps the versions arriving with it, in any order (D137). Both devices cut the union of the
same versions, so one sync leaves them the same 20 per item (D6), and the sync result shows the
notice of section 1.6 for a conflict loser this device wrote (D70). A tombstone with content past its purge date
is purged on arrival by that same merge (section 1.3), the vault read-only for a clock gone back
included (D73, D94), and its versions are dropped with it (D137). The purge date is the
tombstone's `hlc` plus 30 days, never either device's clock, so both devices show the same date
and purge at it, each by its own clock (D7); the trash offers no manual purge (D94).
The Recovery Envelope is sent both ways whenever the two entries differ (section 8) and merges by
section 1.3: the newer of two `phraseId`s is kept on both, and one changed under the held
`phraseId` is rejected and reported, the rest merged (D44). The sync result shows the notices of
section 1.6: the superseded-phrase warning on the device whose own envelope lost, whether the
other regeneration was concurrent or came after a sync (D145, D185), and the one-time notice on the
other device (D43); a second sync shows neither again.

## 10. Live session

While the session is open (§9.1):

- each storage commit of a local write that changes synchronized records (an edit, a move, a trash
  or a restore from the trash, a rename, a retirement, a Recovery Phrase regeneration) sends the
  records it wrote, the Item Versions included, as one transfer of section 2.1, once the device has
  sent its own `committed`; a write committed after the device took its summary for section 7 is
  sent this way, since a record created before the selection of section 8 is in neither the summary
  nor the selection (D225);
- transfers leave one at a time, in the order of the commits, so the messages of two never
  interleave, each after the check of section 6: a write that retired the peer sends it only its
  retired record and `abort`, never the write (CRYPTO-INV-015, D220);
- a merge, of this sync or of a backup, sends nothing: the peer holds the records it merged, or
  receives them at the next sync;
- the receiver accepts, after the peer's `committed`, only transfers and `retired`; it merges each
  transfer as section 9 does, in one storage transaction that records the sync again (D34), and
  sends no acknowledgement; then it runs the check of section 6 again (D220), and a merge that
  retired its own Device record ends the session (D69);
- purge is local and sends nothing (D7), and the history cut sends nothing, since each device cuts
  the same versions.

The session stays open while the user leaves Settings, until it ends as section 12 says (D225).

A live transfer records its peer for the export warning when one of its records is rejected for
its format or type, as section 9 does, but never removes it: it holds only pushed writes, so only
the transfer of section 9 proves the peer no longer sends such a record (D227).

There is no acknowledgement and no retransmission at this layer: the Noise channel delivers every
frame once, in order, or ends the session, and merging a record already held changes nothing, so a
repeated record is idempotent. A transfer cut by the end of the session is not merged; the next
sync's summaries resend what is missing.

A device whose peer's Device record becomes retired during the session follows section 6 (D69).

## 11. Messages

### 11.1 Types

Every message has `v` (uint, **1**) and `t` (text), framed as in `pairing-protocol.md` §10.1. Its
other keys are exactly those listed:

| `t` | Keys | Sent by |
| --- | --- | --- |
| `summary-begin` | `count`: uint, at most 2⁵³ − 1 | both (section 7) |
| `summary` | `e`: array of 1 to 16,384 entries | both (section 7) |
| `summary-end` | — | both (section 7) |
| `records-begin`, `record`, `records-end` | section 2.1 | both (sections 9 and 10) |
| `committed` | — | both, once (section 9) |
| `retired` | `r`: bstr, one record envelope | a device whose copy of the peer's record is retired (section 6) |
| `abort` | `reason`: text | either, at any time |

A message whose `v` is not 1 aborts (`version`). An unknown `t`, a missing or extra key, a wrong
type or length, or a message out of the order of sections 6 to 10 aborts (`protocol-error`): no
`records-begin` before the peer's `summary-end` has been received by the sender, no second
`summary-begin`, no second `committed`, no transfer of section 10 before the sender's `committed`,
nothing but a transfer of section 10 or `retired` after it.

### 11.2 Abort

`abort` ends the session on both sides; every in-memory record of an unmerged transfer is
discarded. `reason` is one of:

| `reason` | Cause |
| --- | --- |
| `ended` | the user ended the session |
| `locked` | the vault locked, by the user, auto-lock, hidden-app lock or a take-over (D51, D93) |
| `expired` | a timeout of section 12 |
| `retired-peer` | the sender holds the receiver's Device record retired (section 6) |
| `verification-failed` | a record the sender was about to send failed verification (section 8) |
| `version` | an unknown message version |
| `protocol-error` | anything else this document rejects |

An unknown `reason` is shown as `protocol-error`. A merge already committed stays.

### 11.3 Implementation (D218)

`packages/sync` decodes these messages with `decodeSyncMessage`, on the strict codec it shares
with the pairing messages: a pairing type is an unknown `t`, and a pairing `reason` reads as
`protocol-error`. Each `summary` entry is checked against the ranges of section 7 as the message
is decoded; `count`, duplicate identities and the order of this section are each stage's to check,
with its task. `SyncSession` carries them over the Noise channel of `Noise_KK`, on the session the
pairing uses: a refused message aborts with its reason, a received `abort` ends the session, and a
closed link ends it as closed. After the check of section 6 the app runs the exchange of
section 9 (D222); once it has sent `committed`, it runs the live session of section 10
(D225): `liveSession` in `exchange.ts` reads the peer's `committed` once, then transfers and
`retired`, refusing anything else with `protocol-error`, and sends the transfers the app queues one
at a time. `SyncGrant.watch` in `packages/vault` reports the records of each local commit from the
summary on, and the controller keeps the session open outside Settings. The
check of section 6 runs again after a local commit that may retire the peer (D220), and after the
merge, before `committed`. Ending the sync sends `abort`
with `ended`, a lock sends `locked`, and the connection closes once the `abort` had time to leave.

## 12. Timeouts, lock and replay

- **Payload.** A device's session expires **10 minutes** after it generates its payload unless the
  handshake completed, as in pairing (`pairing-protocol.md` §11).
- **Initial exchange.** Until a device has sent its `committed` and received the peer's, it aborts
  (`expired`) after **60 seconds** without receiving a frame.
- **Live session.** No timeout: it ends when the channel closes, when either vault locks, when
  the user ends it, or when another sync, pairing or re-admission starts; leaving Settings does not
  end it (D225). A phone that hides the app locks it after the hidden-app delay (D54), which
  ends the session.
- **Lock.** A lock on either device sends `abort` with `locked` when the channel is open and ends
  the session at once (D93).
- **Single use.** A payload belongs to one session and one connection, as in pairing. A device
  that aborted or expired generates a new payload, with a new `sessionId`, DTLS certificate, ICE
  credentials and `Noise_K` ephemeral key.
- **Replay.** An old reconnection payload decrypts, since `Noise_K` has no replay protection, but
  forms no session: its ICE credentials and DTLS certificate belong to a connection that has ended,
  and `prologue_KK` binds both payloads of the live session, so a recorded `Noise_KK` handshake
  fails against a new one. No summary or record is sent before `Noise_KK` completes.

## 13. Versioning

| Layer | Version | Unknown value |
| --- | --- | --- |
| Reconnection payload | `version` byte, 1 | refused before the connection; the UI asks to update the app |
| `Noise_K` prologue | label `bv.reconnect.v1` | the payload does not decrypt (`not-from-peer`) |
| `Noise_KK` prologue | label `bv.sync.v1` | the handshake fails |
| Messages | `v`, 1 | `abort` with `version` |

A change to the payload, the messages or the send rules of section 8 takes a new payload
`version` and new prologue labels. Records keep their own `recordFormatVersion`, which a protocol
version never changes (D32).

## 14. Invariants and tests

- CRYPTO-INV-008: no message but the handshake before `Noise_KK` completes (section 5).
- CRYPTO-INV-009: every message after the handshake in the Noise channel (sections 5 and 11).
- CRYPTO-INV-015: nothing but its retired record to a retired peer (section 6).
- CRYPTO-INV-018 and CRYPTO-INV-022: every received record verified, and none beyond the bound
  merged (section 9).
- CRYPTO-INV-012: an unknown payload or message version refused (sections 4.3 and 11.1).
- A delivery that loses, duplicates, reorders, replays or injects payloads leaves the first payload
  that opens as the only one taken (section 4.4).

Gate D covers this document. The payload vectors (plaintext, `Noise_K` message under fixed keys and
ephemeral, base45) and the summary and message vectors go to `packages/sync/test-vectors/sync-v1.json`,
and `prologue_K` and one `Noise_K` message to the `transcripts` section of
`packages/crypto/test-vectors/crypto-v1.json`, from a second `Noise_K` in `tests/vectors/generate.py`
checked against the official vectors (D214).
Over the in-memory transport: a payload under another peer's key, of another vault, of the wrong
role, of an old session, and a bad version; a `Noise_KK` with a key other than the Device record's;
a retired peer on each side, at the handshake and during the live session; summaries with a wrong
`count`, a duplicate identity and an entry out of range; the send rules of section 8, including a
forged newer non-retired Device record; messages out of order and repeated records; a lock and a
closed link at each step, leaving every committed merge whole and nothing half-written.
