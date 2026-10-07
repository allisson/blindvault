# BlindVault

A local-first, end-to-end encrypted personal vault that lives only on the user's devices and in encrypted backup files.

## Vault contents

**Vault**:
The body of encrypted items, folders and history, replicated across the devices and backups of the people who can open it; either a personal vault or a shared vault.
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

**Read-only record**:
A record the app shows but will not change, because its HLC is beyond the future-clock bound or, for an item, an Item Version or the Recovery Envelope, because it holds content from a newer app version.
_Avoid_: read-only item (for other records), locked item, frozen item

**Read-only vault**:
A vault that refuses every write on one device, except retirement and the automatic purge, while that device's clock is behind the last HLC it issued.
_Avoid_: frozen vault, locked vault

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
The automatic removal of a trashed record's content and history, leaving only its tombstone.
_Avoid_: hard delete, empty trash

## Records

**Record**:
One encrypted, synchronized unit of vault data, such as an item, a folder, an Item Version or a Device record.
_Avoid_: row, document, object

**Record header**:
The small cleartext part of a record that identifies it and orders its changes; readable but authenticated.
_Avoid_: metadata, envelope

**HLC**:
The hybrid logical clock value that orders every change to a record across devices.
_Avoid_: timestamp, version number, revision

**Future-clock bound**:
How far ahead of a device's own clock a change's HLC may be before that device refuses it or treats the record as read-only.
_Avoid_: clock limit, skew window, max drift

**Record key**:
A random key that protects the content of exactly one record.
_Avoid_: item key, data key, per-item key

## Keys and recovery

**Master Key**:
The root secret of the vault, identical on every device that holds the vault.
_Avoid_: root key, vault password

**Vault Key**:
The key of one key epoch that protects every record key.
_Avoid_: data key, encryption key

**Key epoch**:
The generation number of the Vault Key.
_Avoid_: key version, key generation

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
The key derived from the Recovery Phrase that opens the Recovery Envelope and the backups made for it.
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

## Locking

**Unlock**:
Opening the vault on one device with the local password, a WebAuthn credential or the Recovery Phrase, so its keys are held in memory.
_Avoid_: log in, sign in, open (as the security action)

**Lock**:
Closing the vault on one device: its keys and decrypted content leave memory and every operation in progress is cancelled.
_Avoid_: log out, sign out, close

**Auto-lock**:
The lock that happens after a set time without user activity.
_Avoid_: timeout, session expiry

**Hidden-app lock**:
The lock that happens after the app has been out of view for a set time, independently of auto-lock.
_Avoid_: background lock, blur lock

## Backup

**Backup**:
An encrypted `.bvault` file holding a full copy of the vault.
_Avoid_: export (for the file), archive, snapshot

**Export**:
Making a backup on a device; the backup is the file, export is the action.
_Avoid_: save, download, dump

**Keyslot**:
One independent way to open a backup: the Recovery Phrase or an export password.
_Avoid_: key slot, unlock method

**Export password**:
An optional password that opens one specific backup.
_Avoid_: backup password, file password

**Restore**:
Bringing a backup's records onto a device, as either a fresh restore or a backup merge.
_Avoid_: import, recover (as the action)

**Fresh restore**:
Restoring a backup onto a device that does not hold the vault, which installs the same vault there as an unregistered device.
_Avoid_: restore as a new vault, new vault from backup

**Backup merge**:
Restoring a backup into the vault a device already holds, merging its records by the same rules as sync.
_Avoid_: merge restore, import

**Import**:
Bringing items from another password manager's export file, BlindPass included, into the vault as new items; the only meaning of "import".
_Avoid_: migration, restore (for this action)

## Devices and sync

**Installation**:
One copy of BlindVault with its own storage, on one origin in one browser profile or installed-app container; one phone or computer can hold several.
_Avoid_: instance (for the copy), app, client

**Device**:
One installation as the vault sees it, with its own device identity; a Safari tab and the installed app on the same phone are two devices.
_Avoid_: phone, computer (as an identity), browser

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
A device holding the vault whose identity has no Device record, typically one restored from a backup; it can sync with the vault's existing devices only after re-admission.
_Avoid_: orphan device, unpaired device, restored device (as a status)

**Installation guard**:
The exclusive claim one window of BlindVault holds on an installation while it creates, replaces or deletes a vault there.
_Avoid_: installation lock, global lock

**Erase**:
Removing the vault and the Local Config from one device, leaving it with no vault.
_Avoid_: wipe, reset, factory reset

**Retired device**:
A registered device that the user, from another device, has permanently marked as gone, so it is hidden and other devices refuse to sync with it; it is not revoked.
_Avoid_: revoked device, removed device, deleted device

**Admission**:
The SAS-confirmed procedure by which a device joins the devices that sync a vault, through pairing or re-admission.
_Avoid_: pairing (as the umbrella term), enrollment

**Pairing**:
The admission flow in which a device holding the vault gives its Master Key to a device with no vault and registers that device's identity.
_Avoid_: enrollment, linking

**Joining device**:
The device with no vault that receives the vault in pairing; the other side is the device holding the vault.
_Avoid_: new device (as a role), guest, B (in UI copy)

**Re-admission**:
The admission flow between two devices that already hold the same vault, in which the identity either side lacks is registered after both prove they hold the same Master Key, so no Master Key is transferred.
_Avoid_: re-pairing, rejoin

**SAS**:
The short code shown on both screens that the user compares to confirm an admission.
_Avoid_: verification code, PIN, pairing code

**Pairing payload**:
The connection data one device shows (by QR or copy/paste) so another can start pairing with it.
_Avoid_: pairing invitation, pairing response, pairing QR

**Reconnection payload**:
The connection data two registered devices exchange to start a sync session.
_Avoid_: sync QR, sync invitation

**Sync session**:
One authenticated connection over which two devices holding the same vault exchange records, live until either side closes it or locks the vault.
_Avoid_: live session, connection

**LAN-only mode**:
A network setting where devices sync only on the same local network, without contacting any STUN server.
_Avoid_: local-network-only mode, offline mode

## Vaults and Members

**Personal vault**:
A vault that belongs to one person, whose devices all hold its Master Key.
_Avoid_: private vault, my vault, individual vault

**Shared vault**:
A vault several Members can open, whose membership is controlled by its Admins.
_Avoid_: team vault, company vault, organization vault, group vault

**Member**:
A person admitted to a shared vault, represented by their devices.
_Avoid_: user, employee, account, participant

**Admin**:
A Member allowed to admit and remove Members of a shared vault.
_Avoid_: owner, manager, administrator (in UI copy)

**Vault nickname**:
A name the user gives a vault on one device so it can be told apart before unlocking; never synchronized.
_Avoid_: label, alias, vault name
