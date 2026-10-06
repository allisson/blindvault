# BlindVault

A local-first, end-to-end encrypted personal vault that lives only on the user's devices and in encrypted backup files.

## Vault contents

**Vault**:
The single body of encrypted items, folders and history a user owns, replicated across their registered devices and backups.
_Avoid_: account, database, wallet

**Vault root**:
The top level of the vault, where an item or folder with no parent folder lives.
_Avoid_: home, top folder, unfiled

**Item**:
One stored entry in the vault, made of typed fields.
_Avoid_: entry, secret, record (in UI copy)

**Field**:
One typed value inside an item, such as a URL, a secret or a TOTP.
_Avoid_: attribute, property

**Seed phrase**:
A cryptocurrency wallet's BIP39 phrase stored as a field of an item; unrelated to the Recovery Phrase.
_Avoid_: seed, BIP39 seed, wallet seed

**Template**:
A field layout an item is created from, such as Login or Card.
_Avoid_: type, category, item type

**Factory template**:
A template that ships with BlindVault, as opposed to one a user creates.
_Avoid_: built-in type, default template, preset

**Folder**:
A named, nestable container in the vault that holds items and other folders; each item lives in exactly one folder or at the vault root.
_Avoid_: collection, directory, group

**Tag**:
A flat label that classifies items across folders.
_Avoid_: label, category

**Item Version**:
An encrypted past snapshot of an item, kept in its history.
_Avoid_: revision, history entry

**Trash**:
The state of a tombstoned item or folder whose content has not yet been purged and can still be restored.
_Avoid_: recycle bin, deleted items

**Trash operation**:
One user action that sent a set of records to the trash together, so they can be restored together.
_Avoid_: batch delete, deletion group

**Tombstone**:
A record marked as deleted; it keeps its content until purge and is never removed, so no device can bring the record back with an older write.
_Avoid_: deletion marker, delete flag

**Purge**:
The removal of a trashed record's content and history, leaving only its tombstone.
_Avoid_: hard delete, empty trash

## Keys and recovery

**Master Key**:
The root secret of the vault, identical on every registered device.
_Avoid_: root key, vault password

**Vault Key**:
The key of one key epoch that protects every record key.
_Avoid_: data key, encryption key

**Key epoch**:
The generation number of the Vault Key.
_Avoid_: key version, key generation

**Record**:
One encrypted, synchronized unit of vault data, such as an item, a folder, an item version or a Device record.
_Avoid_: row, document, object

**Record header**:
The small cleartext part of a record that identifies it and orders its changes; readable but authenticated.
_Avoid_: metadata, envelope

**HLC**:
The hybrid logical clock value that orders every change to a record across devices.
_Avoid_: timestamp, version number, revision

**Record key**:
A random key that protects the content of exactly one record.
_Avoid_: item key, data key, per-item key

**Local password**:
The per-device password that unlocks the vault on that device only.
_Avoid_: master password, vault password

**Device KEK**:
The device-local key derived from the local password that unlocks the Master Key.
_Avoid_: password key, local key

**Local Config**:
The per-device settings and key-wrapping material that are never synchronized.
_Avoid_: local settings, device state, profile

**PRF KEK**:
A device-local key, derived from a WebAuthn PRF credential, that unlocks the vault on that device as an alternative to the local password.
_Avoid_: biometric-derived wrapping key, biometric wrapping material

**Recovery Phrase**:
The 24-word phrase that represents the vault's recovery secret.
_Avoid_: seed, Bitcoin seed

**Recovery KEK**:
The key derived from the Recovery Phrase that opens the Recovery Envelope.
_Avoid_: phrase key, seed key

**Recovery Envelope**:
The record that holds the vault's Master Key protected by the Recovery Phrase, together with what any unlocked device needs to make backups that phrase can open; shared by every device and every backup.
_Avoid_: recovery wrapping, recovery mechanism

**Check Recovery Phrase**:
Confirming, on an unlocked device, that a typed Recovery Phrase opens the current Recovery Envelope and the backups made for it.
_Avoid_: verify phrase, test phrase

**Regeneration**:
Replacing the Recovery Phrase and the Recovery Envelope with new ones without changing the Master Key; the response to a lost phrase, not an exposed one.
_Avoid_: reset phrase, rotate phrase, new phrase

**Re-founding**:
Replacing every key of the vault, and the vault's identity, while keeping its current items and folders; the response to a compromised Master Key.
_Avoid_: rekey, Master Key rotation, new vault + import

## Backup

**Backup**:
An encrypted `.bvault` file holding a full copy of the vault.
_Avoid_: export, archive, snapshot

**Keyslot**:
One independent way to open a backup: the Recovery Phrase or an export password.
_Avoid_: key slot, unlock method

**Export password**:
An optional password that opens one specific backup.
_Avoid_: backup password, file password

**Fresh restore**:
Restoring a backup onto a device that does not hold the vault, which installs the same vault there as an unregistered device.
_Avoid_: restore as a new vault, new vault from backup

**Backup merge**:
Restoring a backup into the vault a device already holds, merging its records by the same rules as sync.
_Avoid_: merge restore, import

## Devices and sync

**Device identity**:
The key pair that identifies one device to the others; its private half never leaves that device.
_Avoid_: device key, device certificate, static key (in UI copy)

**Device record**:
The record that registers one device's identity and display name in the vault.
_Avoid_: device entry, device profile

**Vault creator**:
The device that creates a vault, or re-founds one, and so registers itself without pairing.
_Avoid_: owner device, primary device, master device

**Registered device**:
A device whose identity is recorded in a Device record of the vault.
_Avoid_: paired device, trusted device, enrolled device

**Unregistered device**:
A device holding the vault whose identity has no Device record, typically one restored from a backup; it can sync only after re-admission.
_Avoid_: orphan device, unpaired device, restored device (as a status)

**Retired device**:
A registered device the user has permanently marked as gone from another device, so it is hidden and other devices refuse to sync with it; it is not revoked.
_Avoid_: revoked device, removed device, deleted device

**Pairing**:
The SAS-confirmed procedure by which a device holding the vault registers another device's identity.
_Avoid_: enrollment, linking

**Re-admission**:
A pairing that registers an unregistered device after it proves it already holds the same Master Key, so no Master Key is transferred.
_Avoid_: re-pairing, rejoin

**SAS**:
The short code shown on both screens that the user compares to confirm a pairing.
_Avoid_: verification code, PIN, pairing code

**Pairing payload**:
The connection data one device shows (by QR or copy/paste) so another can start pairing with it.
_Avoid_: pairing invitation, pairing response, pairing QR

**Reconnection payload**:
The connection data two registered devices exchange to start a sync session.
_Avoid_: sync QR, sync invitation

**Sync session**:
One authenticated connection between two registered devices, live until either side closes it or locks the vault.
_Avoid_: live session, connection

**LAN-only mode**:
A network setting where devices sync only on the same local network, without contacting any STUN server.
_Avoid_: local-network-only mode, offline mode
