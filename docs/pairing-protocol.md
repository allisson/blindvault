# BlindVault — Pairing Protocol v1

> Normative for the bytes and the order of pairing and re-admission; `overview.md` prevails on
> design. Implements overview §8 and D1, D4, D22, D29, D30, D33, D34, D35, D45, D49, D50, D93,
> D101, D117, D122, D136, D148, D150, D153, D157, D161, D199, D201, D202 and D203, using the conventions, primitives
> and encodings of `crypto-spec.md` (§1, §2, §3, §13, §14). The full transfer that follows the
> handshake is in `sync-protocol.md` §2.

## 1. Overview

Pairing and re-admission are the two **admission flows** (D50). Both run the same exchange:

```
I shows payload_I ─────────────► R          (QR or copy/paste, section 3)
I ◄───────────── R shows payload_R          (R echoes I's session ID)
WebRTC/DTLS from the SDPs rebuilt from both payloads (section 4)
Noise_XX handshake, prologue binding both payloads and both DTLS fingerprints (section 5)
R ── nonce_R ──► I,  I ── nonce_I ──► R    (I's nonce opens the commitment in payload_I)
SAS on both devices; the user confirms on both (section 6)
I ◄── confirmed ──► R
pairing (section 8) or re-admission (section 9)
```

- **I**, the initiator, is the device that shows the first payload. It makes the WebRTC offer and
  initiates the Noise handshake, and comes first in every role-ordered input. **R**, the responder,
  answers. The role does not depend on the flow.
- The flow comes from the two "holds a vault" flags (D50): exactly one set means **pairing**, and
  the device that holds the vault is **A**, the other **B**; both set means **re-admission**;
  neither set aborts before any connection (section 7).
- In pairing the UI has A show the first payload (A = I), so B scans first and holds the camera
  before it gathers ICE candidates, and its host candidate is a raw IP address (D161). The
  protocol accepts B as I too, for copy/paste.
- Every message after the handshake travels inside the Noise channel (section 10). Nothing is sent
  before the handshake but the payloads and the WebRTC/DTLS traffic, so a refusal before the
  handshake is shown only on the refusing device; the other one sees the session expire.

## 2. Preconditions

A device offers to start or join an admission only if:

| Device | Condition |
| --- | --- |
| A, pairing | vault unlocked and not read-only (D102); its own Device record not retired (D45); no record kept aside as corrupt; its local password or a passkey assertion given again, which opens the Master Key for this pairing only (D202) |
| B, pairing | holds no vault, or the user confirmed a replacement (D150, D153); its local password created, its Device KEK derived and its identity generated, all in memory (D33) |
| Re-admission, both | vault unlocked and not read-only (D102); its own Device record not retired (D45) |

B sends `holdsVault = false` also when it replaces a vault (D150).

## 3. Pairing payload

### 3.1 Bytes

All integers big-endian. The payload is exactly these fields, in this order:

| Field | Size | Value |
| --- | --- | --- |
| `version` | u8 | **1** |
| `flags` | u8 | bit 0: role, 0 = I, 1 = R. Bits 1–2: DTLS `setup`, 0 = `actpass`, 1 = `active`, 2 = `passive`. Bit 3: `holdsVault`. Bits 4–7: 0 |
| `sessionId` | 16 | random from I; R repeats I's |
| `fingerprint` | 32 | SHA-256 fingerprint of this device's DTLS certificate |
| `ufrag` | u8 length ‖ bytes | ICE username fragment, 4 to 255 ICE characters (`A–Z a–z 0–9 + /`) |
| `pwd` | u8 length ‖ bytes | ICE password, 22 to 255 ICE characters |
| `candidates` | u8 count ‖ entries | 1 to 8 entries, each `u8 kind ‖ address ‖ u16 port` (section 3.2) |
| `formatVersions` | u8 count ‖ u16 × count | supported `recordFormatVersion`s, 1 to 255, strictly ascending (D122) |
| `recordTypes` | u8 count ‖ u16 × count | supported `recordType`s, 1 to 255, strictly ascending (D122) |
| `commitment` | 32 | I only: `BLAKE2b-256(layout("bv.pairing.commit.v1", nonce_I))` (section 6) |

I's `setup` is `actpass`; R's is `active` or `passive`, whichever its browser chose for the answer.

### 3.2 Candidates

| `kind` | Candidate | `address` |
| --- | --- | --- |
| 0 | host, IPv4 | 4 bytes |
| 1 | host, IPv6 | 16 bytes |
| 2 | host, mDNS name `<uuid>.local` (D136) | 16 bytes, the UUID |
| 3 | srflx, IPv4 | 4 bytes |
| 4 | srflx, IPv6 | 16 bytes |

`port` is 1 to 65535. Only UDP candidates of component 1 are carried; the sender drops TCP, relay
and peer-reflexive candidates, and duplicates. When more than 8 remain, the sender keeps the srflx
candidates first and then the host candidates in the browser's order, so host addresses never push
out the srflx candidate a connection across networks needs; with none left it shows no payload. An mDNS name is carried only when it is a UUID; its
text form on rebuilding is the lowercase, hyphenated UUID followed by `.local`. LAN-only mode uses
no STUN server and so has no srflx candidate (§9.2).

ICE gathering is not trickled (D4). When the payload is built is set by the implementation and does
not change the bytes: it stops at `complete`, at the first srflx candidate, or after 10 seconds,
whichever comes first (`packages/sync/src/connection.ts`). The 10 seconds are the Phase 0 spike's
cap, not a measured optimum; when the srflx candidate arrives on mobile data is still to measure.

### 3.3 Decoding

The receiver decodes after base45 and rejects the payload, before any connection, when:

- `version` is not 1, or a reserved flag bit is set, or `setup` is 3;
- the role is not the one expected (a device waiting for an answer accepts only R, a device
  scanning a first payload only I);
- I's `setup` is not `actpass`, or R's is `actpass`;
- R's `sessionId` differs from the one I sent;
- any length or count is outside its range, a candidate `kind` is unknown, a port is 0, the ICE
  characters are outside the set, a list is not strictly ascending;
- the commitment is missing from I's payload or present in R's;
- bytes remain after the last field.

The decoding is strict: one payload has exactly one encoding.

### 3.4 Encoding and channel

The payload is encoded in base45 (QR alphanumeric mode), for QR and for copy/paste alike, and
decoded strictly (RFC 9285: a character outside the alphabet, a length of 3k + 1 or a group above
its range is rejected). The receiver of a pasted text removes line breaks and tabs, which a text
field or a chat may add, and nothing else: the space is a base45 character, and a payload may
start or end with one. In copy/paste mode it may travel through any channel (D117); the UI states
that the channel sees the device's network addresses.

The payload holds no Noise key and no vault data (§8.3). It reveals the network addresses, the
`holdsVault` flag and the supported format range.

## 4. Connection

Each side rebuilds the other's SDP from its payload: one `m=application 9 UDP/DTLS/SCTP
webrtc-datachannel` section with `a=mid:0`, `a=ice-ufrag`, `a=ice-pwd`, `a=fingerprint:sha-256`,
`a=setup`, `a=sctp-port:5000`, the candidates and `a=end-of-candidates`. The browser then refuses a
DTLS certificate whose fingerprint differs from the one in the payload, which is the check
`crypto-spec.md` §13 requires. Each session generates its own certificate (ECDSA P-256) rather than
using one the browser might reuse (section 11). I sets R's rebuilt answer as its remote description; R sets I's
rebuilt offer before creating its answer.

I creates one DataChannel, reliable and ordered, before its offer. DTLS is transport only and is
never the trust mechanism (§8.2): nothing is trusted until the SAS is confirmed on both devices.

## 5. Handshake

- Protocol name: `Noise_XX_25519_ChaChaPoly_BLAKE2b`, from the copied implementation of D157 in
  `packages/crypto` (D200).
- Prologue: `prologue_XX` of `crypto-spec.md` §13, with `payload_initiator = payload_I` and
  `payload_responder = payload_R`, each the decoded bytes exactly as received, commitment included.
- Static keys: each device's X25519 identity (§8.1). B's exists in memory only until its commit.
- The three handshake messages carry **empty payloads**; every protocol message follows the
  handshake.
- Each handshake message is one DataChannel message. The handshake hash `h` (64 bytes) is kept for
  the SAS and, in re-admission, the key-confirmation MAC.

After the handshake each side knows the peer's static public key and its
`deviceId = BLAKE2b-128(publicKey)`. It aborts (`protocol-error`) when the peer's static key equals
its own.

## 6. Nonces and SAS (D199)

### 6.1 Exchange

1. I draws `nonce_I` (32 random bytes) before building `payload_I`, which carries its commitment.
2. After the handshake, R draws `nonce_R` (32 random bytes) and sends `nonce` with it.
3. I sends `nonce` with `nonce_I` only after receiving `nonce_R`.
4. R checks `BLAKE2b-256(layout("bv.pairing.commit.v1", nonce_I))` against the commitment in
   `payload_I` with `sodium_memcmp`; a mismatch aborts (`protocol-error`).

### 6.2 Derivation

```
sasHash = BLAKE2b-256(layout("bv.sas.v1", h, nonce_I, nonce_R))
SAS     = u64(sasHash[0..8]) mod 1,000,000
```

`u64` reads the 8 bytes big-endian. The SAS is shown as six decimal digits with leading zeros, in
two groups of three (`042 917`). The modulo bias is below 2⁻⁴⁴ and is ignored.

The SAS binds both peers and the session: `h` covers both static keys, both ephemeral keys and the
prologue, which covers both payloads (session ID, DTLS fingerprints, flags, commitment).

### 6.3 Brute-force analysis

The attacker is a man in the middle between I and R (threat model A3). In QR mode the payloads
cross an authentic channel (a camera reading a screen in front of the user), and the DTLS
fingerprints they carry keep a network attacker out of the connection. In copy/paste mode the
channel may be hostile (D117), so the attacker can replace both payloads and run two handshakes,
I ↔ M and M ↔ R. It succeeds only if both sessions show the same SAS and the user confirms them.

Every value the attacker controls is fixed before the value it must match is known:

- **Session I ↔ M.** M is the responder: it must send its `nonce` before I reveals `nonce_I`, and
  `h` is final by then. `SAS_1` is uniform to M.
- **Session M ↔ R.** M is the initiator: its nonce was committed in the payload it gave R, before
  R drew `nonce_R`, and `h` is final before R sends it. `SAS_2` is uniform to M.

Without the commitment, the device that sends last in each session could try nonces or handshake
values offline until both SAS match; with it, M has **one guess in 10⁶ per pairing**. A failed
attempt shows different digits on the two devices, the user rejects them, and both sides abort;
every new attempt needs the user to start a pairing again.

The commitment is part of every pairing, QR included (D199): one protocol with no mode flag, so
no attacker can strip the commitment by claiming the other mode.

### 6.4 Confirmation (D148)

Each device shows the SAS and asks the user whether it matches the other device.

- **Matches:** the device sends `confirmed`. It continues only once it has both its own
  confirmation and the peer's `confirmed`.
- **Does not match** or cancelled: it sends `abort` (`sas-mismatch` or `cancelled`) and ends the
  session.
- A message that section 8 or 9 allows only after both confirmations, received earlier, aborts
  (`protocol-error`): B rejects a `master-key` that arrives before its own confirmation, and no
  `key-confirmation` is accepted before both.

Nothing secret is sent before both confirmations (CRYPTO-INV-011).

## 7. Flow selection and refusals before the handshake

With `holdsVault_I` and `holdsVault_R`:

| I | R | Flow |
| --- | --- | --- |
| true | false | pairing, A = I |
| false | true | pairing, A = R |
| true | true | re-admission |
| false | false | refused: neither device holds a vault |

The flags are bound through the prologue, so a modified flag makes the handshake fail.

R decides on reading `payload_I`, I on reading `payload_R`, both before the handshake. A refuses a
pairing before the handshake when B's `formatVersions` lacks a `recordFormatVersion` A holds, or
B's `recordTypes` lacks a `recordType` A holds, and tells the user to update the app on B (D122).
In v1 a device holds only formats and types its version supports (D68, D81), so A compares B's
lists with its own (D203).
No Device record is written and no key is sent.

## 8. Pairing

After both confirmations (section 6.4):

1. A sends `master-key` with the Master Key and the `vaultId`. The Master Key was opened when A
   started the pairing (section 2, D202); A wipes it when the session ends.
2. B keeps them in memory. When it replaces a vault, it compares the received `vaultId` with the
   one in its cleartext Local Config to choose between the two replacements of D153.
3. B sends `received` with its display name (1 to 64 code points, single line, trimmed,
   `record-content.md`).
4. A writes, in one storage transaction, B's Device record, with the static key A authenticated
   in the handshake and B's display name, and, when A holds no Device record of its own (an
   unregistered device, D141), A's own (D30). A refuses a `received` whose static key already
   has a Device record (`protocol-error`). Then A reads every stored record again, verifies it as
   an export does (D181), and sends the full transfer (`sync-protocol.md` §2.2).
5. B verifies the transfer in memory and aborts before its commit when:
   - a record fails verification on receipt (`crypto-spec.md` §9.5) or the domain checks
     (`verification-failed`);
   - a record has an unknown `recordFormatVersion` or `recordType` (`unsupported-format`, D68,
     D81);
   - A's own Device record is retired (`retired-peer`, D45);
   - B's own Device record is missing, or its public key is not B's, A's own Device record is
     missing, or two records have the same identity (`protocol-error`, D202).

   A newer record aborts with `unsupported-format` whatever else fails (D202).

   Records beyond the future-clock bound are accepted and read-only until the clock reaches them
   (D101).
6. B wraps the Master Key under its Device KEK, encrypts its Local Config (identity included), and
   in one storage transaction persists the records and the Local Config (D33), with:
   - the HLC state, by the receive rule (D109) within the bound;
   - every `deviceId` held as seen and every retired one as seen as retired, with no notice (D53);
   - the held Recovery Envelope's `phraseId` as the last one seen (D43);
   - the completed sync with A (D34).

   A replacement of a vault commits as D153 states.
7. B sends `committed`, then the session ends. A records the completed sync with B on receiving it
   (D34).

B holds the identity, the Device KEK, the Master Key and the received records only in memory until
step 6, and discards them on any abort: an interruption before the commit leaves its storage
empty, or its old vault intact (D33, D150). A Device record A wrote stays; without `committed`,
A shows the pairing as not completed (§8.4, D33).

## 9. Re-admission

In this order:

1. As soon as the handshake ends, before the nonces, each side checks the peer's Device record it
   holds, if any; when it is retired, the side aborts (`retired-peer`, D45, D49). A record
   received later in the transfer is checked the same way.
2. After both confirmations (section 6.4), each side sends `key-confirmation` with
   `mac(role) = BLAKE2b-256(key = K_readmission, layout("bv.v1.readmission", role, h))`
   (`crypto-spec.md` §13) for its own role, and checks the peer's for the peer's role with
   `sodium_memcmp`. A mismatch aborts (`different-vaults`); the UI states that the devices hold
   different vaults and offers to replace one by pairing (D50, D153). No Device record is written
   before both MACs match (CRYPTO-INV-014).
3. Each side sends `devices` with `own` (it holds its own Device record), `peer` (it holds the
   peer's) and `name`, its display name (1 to 64 code points), the one used if the peer writes
   its record.
4. A Device record is written only for a device whose record neither side holds (D35, D49):
   - its record is written by the other device when that device holds its own record;
   - when neither device holds its own record, I writes every record neither side holds.

   Each writer writes its records in one storage transaction, with the static keys authenticated
   in the handshake and the names received in `devices`; I's own record, when I writes it, takes
   I's own name.
5. Both sides run the full transfer in both directions and merge (`sync-protocol.md` §2.3).
6. Each side commits its merge, records the completed sync with the peer in the same transaction
   (D34), sends `committed`, and ends the session on the peer's `committed`.

No Master Key is transferred: both already hold it (D22).

## 10. Messages

### 10.1 Framing

After the handshake, every message is a deterministic CBOR map (`crypto-spec.md` §14), decoded
strictly with the re-encode check. A message is cut into frames; each frame is
`u8 last ‖ bytes`, `last` = 1 on the final frame and 0 otherwise (any other value aborts), at most
65,519 bytes, and is encrypted as one Noise transport message (65,535 bytes with its tag) and sent
as one DataChannel message. The framing is canonical (D201): every frame but the final one carries
exactly 65,518 bytes of the message, and the final one 1 to 65,518. The receiver joins frames until
`last` = 1, and aborts (`protocol-error`) on a non-final frame that is not full, on an empty final
frame, and when a message would exceed **1,049,194 bytes**: the largest record envelope
(`crypto-spec.md` §9.2) plus 64 bytes for the message map.

The Noise transport nonces make every frame authenticated, in order, and bound to the session; a
frame that fails decryption aborts.

### 10.2 Types

Every message has `v` (uint, **1**) and `t` (text). Its other keys are exactly those listed:

| `t` | Keys | Sent by |
| --- | --- | --- |
| `nonce` | `n`: bstr 32 | R, then I (section 6.1) |
| `confirmed` | — | both (section 6.4) |
| `master-key` | `mk`: bstr 32, `vid`: bstr 16 | A (section 8) |
| `received` | `name`: text | B (section 8) |
| `key-confirmation` | `mac`: bstr 32 | both (section 9) |
| `devices` | `own`: bool, `peer`: bool, `name`: text | both (section 9) |
| `records-begin`, `record`, `records-end` | `sync-protocol.md` §2.1 | section 8 or 9 |
| `committed` | — | B in pairing, both in re-admission |
| `abort` | `reason`: text | either, at any time |

A message whose `v` is not 1 aborts (`version`). An unknown `t`, a missing or extra key, a wrong
type or length, or a message out of the order of sections 6, 8 and 9 aborts (`protocol-error`).

### 10.3 Abort

`abort` ends the session on both sides at once; every in-memory secret and record of the session
is discarded. `reason` is one of:

| `reason` | Cause |
| --- | --- |
| `cancelled` | the user cancelled |
| `sas-mismatch` | the user said the SAS does not match |
| `locked` | the vault locked, by the user, auto-lock or hidden-app lock (D93) |
| `expired` | a timeout of section 11 |
| `retired-peer` | the peer's own Device record is retired (D45, D49) |
| `different-vaults` | the key-confirmation MACs differ (D29, D50) |
| `unsupported-format` | the transfer holds an unknown format or type (D68, D81) |
| `verification-failed` | a record failed verification on receipt |
| `version` | an unknown message version |
| `protocol-error` | anything else this document rejects |

An unknown `reason` is shown as `protocol-error`. The reason is information only: whatever it
says, the receiver aborts.

## 11. Timeouts, duplicates and replay

- **Session.** A device's pairing session expires **10 minutes** after it generates its payload,
  unless both confirmations happened before. The value is a protocol constant, not a measurement.
- **After confirmation.** A device waiting for a message aborts (`expired`) after **60 seconds**
  without receiving a frame.
- **Lock.** A lock on either device aborts at once, sending `abort` with `locked` when the channel
  is open (D93); the connection closes only once that message is out. B holds no vault, so its
  lock is the app hidden for the default hidden-app delay, 60 seconds (D203).
- **Single use.** A payload belongs to one session and one connection. A device accepts one peer
  connection per session; a second scan of the same payload, or an answer for another
  `sessionId`, is refused. A device that aborted or expired generates a new payload, with a new
  `sessionId`, DTLS certificate, ICE credentials and, for I, nonce.
- **Replay.** A recorded payload or handshake from an old session cannot be replayed: the session
  ID, the DTLS fingerprints and the ICE credentials of the live connection must match the
  payloads bound in the prologue, and the ephemeral keys and nonces of the live session change the
  handshake hash and the SAS.
- **Duplicate pairing.** Pairing B again after an interrupted attempt is a new session with a new
  identity for B; a Device record left by the earlier attempt stays as not completed (D33).

## 12. Versioning

| Layer | Version | Unknown value |
| --- | --- | --- |
| Payload | `version` byte, 1 | refused before the connection; the UI asks to update the app |
| Prologue | label `bv.pairing.v1` | a device of another version computes another prologue, so the handshake fails |
| SAS and commitment | labels `bv.sas.v1`, `bv.pairing.commit.v1` | changed only with the prologue label |
| Messages | `v`, 1 | `abort` with `version` |

A change to the payload, the messages or the derivations takes a new payload `version` and a new
prologue label, so two devices of different versions never reach a SAS that looks valid.

## 13. Invariants and tests

- CRYPTO-INV-007: Device records written only in sections 8 step 4 and 9 step 4, after both
  confirmations.
- CRYPTO-INV-011: no Master Key or MAC before both confirmations (section 6.4).
- CRYPTO-INV-014: no Device record before both key-confirmation MACs match (section 9 step 2).

The tests of overview §16 (pairing tests) and of Gate C cover this document. The payload and
base45 vectors, and the message and framing vectors of section 10, are in
`packages/sync/test-vectors/pairing-v1.json`; the commitment and SAS vectors are in the
`transcripts` section of `packages/crypto/test-vectors/crypto-v1.json` (`crypto-spec.md` §15). The
nonces, the SAS and the confirmations are tested over the in-memory transport with a nonce that
does not open the commitment, messages out of order (a key or MAC before both confirmations), a
rejected SAS, an abort or a close while the SAS is shown, and the timeouts of section 11, and over
a real DataChannel in Playwright. The official Noise
vectors are in `packages/crypto/test-vectors/noise-v1.json` (`crypto-spec.md` §15); the handshake
and the Noise channel are tested over the in-memory transport with tampered, truncated, extended,
duplicated and foreign messages, a low-order ephemeral key, payloads that differ between the two
sides and the device's own static key, and over a real DataChannel in Playwright. The transfer of
section 8 is tested over the in-memory transport with messages out of order, a wrong `count`, a
record outside `records-begin` and `records-end`, and a refusal on either side; B's commit and A's
Device record writes in `packages/vault` with each rejection of section 8 step 5; and the whole
pairing, handshake included, through IndexedDB in `tests/pairing.test.ts`, with the link closed in
place of each of A's frames, a rejected SAS and a lock on A, each leaving B's storage empty (D33,
D202).
