// Re-admission (`pairing-protocol.md` §9, `sync-protocol.md` §2.3, D22, D29, D35, D49, D206), run
// once both devices confirmed the SAS. Each side sends its key-confirmation MAC and checks the
// peer's, then both say which Device records they hold, the records neither side holds are
// written, and both transfer every record they hold, at the same time, and merge what they
// receive. No Master Key is transferred. This package never sees the vault: the MAC, the writes
// and the merge are callbacks the app wires to the vault session, and a callback refuses with the
// abort reason of §10.3 by throwing `TransferRefusal`.

import type { Role } from './payload';
import { PairingError, type PairingSession } from './session';
import { guarded, receiveRecords, sendRecords } from './transfer';

/** Which Device records a side holds: its own, and the peer's. */
export interface DevicesHeld {
  readonly own: boolean;
  readonly peer: boolean;
}

/** A side's `devices` message: what it holds, and its display name. */
export interface DevicesMessage extends DevicesHeld {
  readonly name: string;
}

/** The records this side writes in §9 step 4: its own, the peer's, or neither. */
export interface ReadmissionWrites {
  readonly own: boolean;
  readonly peer: boolean;
}

/**
 * §9 step 4: a record is written only when neither side holds it; by the other device when that
 * device holds its own record, and otherwise by I, which then writes every record neither holds.
 * Both sides compute the same answer from the two `devices` messages, so each record has one
 * writer.
 */
export function readmissionWrites(
  role: Role,
  mine: DevicesHeld,
  theirs: DevicesHeld,
): ReadmissionWrites {
  const ownMissing = !mine.own && !theirs.peer;
  const peerMissing = !theirs.own && !mine.peer;
  const neither = !mine.own && !theirs.own;
  const initiator = role === 'initiator';
  return {
    own: ownMissing && neither && initiator,
    peer: peerMissing && (mine.own || (neither && initiator)),
  };
}

export interface ReadmitOptions<T> {
  readonly role: Role;
  /** This side's MAC for its own role (crypto-spec.md §13); wiped once sent. */
  readonly mac: () => Uint8Array;
  /** Whether `mac` is the peer's MAC for the peer's role, compared in constant time. */
  readonly checkPeerMac: (mac: Uint8Array) => boolean;
  readonly devices: DevicesMessage;
  /** §9 step 4: writes `writes` in one commit, with the peer's name and the static key of the handshake. */
  readonly admit: (writes: ReadmissionWrites, peer: DevicesMessage) => Promise<void>;
  /** Every record envelope this side holds, read again and verified, the ones just written included. */
  readonly records: () => Promise<readonly Uint8Array[]>;
  /** §9 step 6: merges the peer's records and records the completed sync with it, in one commit. */
  readonly merge: (records: readonly Uint8Array[]) => Promise<T>;
}

export interface Readmitted<T> {
  /** What `merge` returned: this side committed. */
  readonly result: T;
  /** Whether the peer's `committed` came: otherwise its merge may not have completed. */
  readonly peerCommitted: boolean;
}

/**
 * One side of §9 from step 2, after both confirmations. Rejects with `PairingError` before this
 * side's merge commits; once it has, resolves whatever the peer does.
 */
export async function readmit<T>(
  session: PairingSession,
  options: ReadmitOptions<T>,
): Promise<Readmitted<T>> {
  const mac = options.mac();
  try {
    await session.send({ t: 'key-confirmation', mac });
  } finally {
    mac.fill(0);
  }
  const confirmation = await session.receive();
  if (confirmation.t !== 'key-confirmation') return session.refuse('protocol-error');
  // CRYPTO-INV-014: nothing is written before both MACs match.
  if (!options.checkPeerMac(confirmation.mac)) return session.refuse('different-vaults');

  await session.send({ t: 'devices', ...options.devices });
  const message = await session.receive();
  if (message.t !== 'devices') return session.refuse('protocol-error');
  const peer: DevicesMessage = { own: message.own, peer: message.peer, name: message.name };
  const writes = readmissionWrites(options.role, options.devices, peer);
  await guarded(session, () => options.admit(writes, peer));

  const records = await guarded(session, options.records);
  const [, received] = await Promise.all([sendRecords(session, records), receiveRecords(session)]);
  const result = await guarded(session, () => options.merge(received));

  // Committed here: whatever happens next, this side keeps its merge.
  try {
    await session.send({ t: 'committed' });
    const last = await session.receive();
    if (last.t !== 'committed') {
      await session.abort('protocol-error');
      return { result, peerCommitted: false };
    }
    session.close();
    return { result, peerCommitted: true };
  } catch (error) {
    if (!(error instanceof PairingError)) throw error;
    return { result, peerCommitted: false };
  }
}
