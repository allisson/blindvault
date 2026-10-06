# BlindVault

A local-first, end-to-end encrypted personal vault that lives only on the user's devices and in encrypted backup files.

## Keys and recovery

**PRF KEK**:
A device-local key, derived from a WebAuthn PRF credential, that unlocks the vault on that device as an alternative to the local password.
_Avoid_: biometric-derived wrapping key, biometric wrapping material

**Recovery Phrase**:
The 24-word phrase that represents the vault's recovery secret.
_Avoid_: seed, Bitcoin seed

**Recovery Envelope**:
The vault's Master Key protected by the Recovery Phrase, shared by every device and every backup.
_Avoid_: recovery wrapping, recovery mechanism

## Devices and sync

**Paired device**:
A device that holds the vault and was admitted by a pairing confirmed with matching SAS on both screens.
_Avoid_: trusted device, enrolled device

**Pairing payload**:
The connection data one device shows (by QR or copy/paste) so another can start pairing with it.
_Avoid_: pairing invitation, pairing response, pairing QR

**Reconnection payload**:
The connection data two paired devices exchange to start a sync session.
_Avoid_: sync QR, sync invitation

**LAN-only mode**:
A network setting where devices sync only on the same local network, without contacting any STUN server.
_Avoid_: local-network-only mode, offline mode
