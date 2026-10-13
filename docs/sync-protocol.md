# Sync protocol

This document specifies how records received from elsewhere join the vault. Only section 1, the
merge rules, exists so far: it is what a backup merge applies (Phase 2, D182). The reconnection
payload, messages, summaries, ordering, idempotency and versioning of the sync exchange are added
in Phase 5, and the sync exchange then applies the same merge rules.

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
