# BlindVault

A local-first, end-to-end encrypted personal vault that lives only on the user's devices and in encrypted backup files.

## Vault contents

**Item**:
One stored entry in the vault, made of typed fields.
_Avoid_: entry, secret, record (in UI copy)

**Field**:
One typed value inside an item, such as a URL, a secret or a TOTP.
_Avoid_: attribute, property

**Template**:
A built-in field layout an item is created from, such as Login or Card.
_Avoid_: type, category, item type

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
The state of a deleted item or folder whose content can still be restored.
_Avoid_: recycle bin, deleted items

**Tombstone**:
The permanent marker that a record was deleted, kept so no device can bring it back.
_Avoid_: deletion marker, delete flag

**Purge**:
The removal of a trashed record's content and history, leaving only its tombstone.
_Avoid_: hard delete, empty trash

## Keys and recovery

**Master Key**:
The root secret of the vault, identical on every paired device.
_Avoid_: root key, vault password

**Vault Key**:
The key of one key epoch that protects every record key.
_Avoid_: data key, encryption key

**Key epoch**:
The generation number of the Vault Key.
_Avoid_: key version, key generation

**Record key**:
A random key that protects the content of exactly one record.
_Avoid_: item key, data key, per-item key

**Local password**:
The per-device password that unlocks the vault on that device only.
_Avoid_: master password, vault password

**Device KEK**:
The device-local key derived from the local password that unlocks the Master Key.
_Avoid_: password key, local key

**PRF KEK**:
A device-local key, derived from a WebAuthn PRF credential, that unlocks the vault on that device as an alternative to the local password.
_Avoid_: biometric-derived wrapping key, biometric wrapping material

**Recovery Phrase**:
The 24-word phrase that represents the vault's recovery secret.
_Avoid_: seed, Bitcoin seed

**Recovery Envelope**:
The vault's Master Key protected by the Recovery Phrase, shared by every device and every backup.
_Avoid_: recovery wrapping, recovery mechanism

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

## Devices and sync

**Paired device**:
A device that holds the vault and was admitted by a pairing confirmed with matching SAS on both screens.
_Avoid_: trusted device, enrolled device

**SAS**:
The short code shown on both screens that the user compares to confirm a pairing.
_Avoid_: verification code, PIN, pairing code

**Pairing payload**:
The connection data one device shows (by QR or copy/paste) so another can start pairing with it.
_Avoid_: pairing invitation, pairing response, pairing QR

**Reconnection payload**:
The connection data two paired devices exchange to start a sync session.
_Avoid_: sync QR, sync invitation

**Sync session**:
One authenticated connection between two paired devices, live until either side closes it or locks the vault.
_Avoid_: live session, connection

**LAN-only mode**:
A network setting where devices sync only on the same local network, without contacting any STUN server.
_Avoid_: local-network-only mode, offline mode
