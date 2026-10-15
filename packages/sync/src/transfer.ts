// The Master Key transfer and the full transfer of a pairing (`pairing-protocol.md` §8,
// `sync-protocol.md` §2.1, §2.2, D202), run once both devices confirmed the SAS. A sends
// `master-key`, B answers `received` with its display name, A writes B's Device record and sends
// every record it holds, and B persists them before it sends `committed`. This package never sees
// the vault: A's writes and B's commit are callbacks the app wires to the vault session, and a
// callback refuses with the abort reason of §10.3 by throwing `TransferRefusal`.

import {
  type Keyring,
  type SymmetricKey,
  exportTransferKey,
  importTransferKey,
} from '@blindvault/crypto';

import type { AbortReason } from './messages';
import { PairingError, type PairingSession } from './session';

/** Thrown by a callback to abort the session with `reason`; any other error aborts as `protocol-error`. */
export class TransferRefusal extends Error {
  override name = 'TransferRefusal';
  constructor(
    readonly reason: AbortReason,
    options?: ErrorOptions,
  ) {
    super(`transfer refused (${reason})`, options);
  }
}

/** Runs a callback; when it fails, ends the session with the reason it gives. */
export async function guarded<T>(session: PairingSession, run: () => Promise<T>): Promise<T> {
  try {
    return await run();
  } catch (error) {
    if (error instanceof PairingError) throw error;
    // The session ended while the callback ran, a lock included (D93): its own reason stands.
    if (session.error) throw session.error;
    if (error instanceof TransferRefusal) return session.refuse(error.reason, error);
    return session.refuse('protocol-error', error);
  }
}

export interface SendVaultOptions {
  readonly vaultId: Uint8Array;
  /** The Master Key opened for this pairing (D202); the caller wipes it when the session ends. */
  readonly masterKey: SymmetricKey;
  /**
   * B acknowledged the Master Key with its display name: writes B's Device record (and A's own when
   * A has none, D141), then resolves with every record envelope A holds, read again and verified.
   */
  readonly admit: (name: string) => Promise<readonly Uint8Array[]>;
  /** B committed: records the completed sync with B (D34). Runs after the session closed. */
  readonly completed: () => Promise<void>;
}

/** A's side of §8: resolves once B committed and `completed` ran. Rejects with `PairingError`. */
export async function sendVault(session: PairingSession, options: SendVaultOptions): Promise<void> {
  const mk = exportTransferKey(options.masterKey);
  try {
    await session.send({ t: 'master-key', mk, vid: options.vaultId });
  } finally {
    mk.fill(0);
  }
  const received = await session.receive();
  if (received.t !== 'received') return session.refuse('protocol-error');
  const records = await guarded(session, () => options.admit(received.name));
  await sendRecords(session, records);
  const last = await session.receive();
  if (last.t !== 'committed') return session.refuse('protocol-error');
  session.close();
  await options.completed();
}

/** `records-begin`, every `record`, `records-end` (`sync-protocol.md` §2.1). */
export async function sendRecords(
  session: PairingSession,
  records: readonly Uint8Array[],
): Promise<void> {
  await session.send({ t: 'records-begin', count: records.length });
  for (const r of records) await session.send({ t: 'record', r });
  await session.send({ t: 'records-end' });
}

/**
 * The records of a full transfer (`sync-protocol.md` §2.1), unverified: a message out of its order,
 * or a number of records other than `count`, aborts (`protocol-error`).
 */
export async function receiveRecords(session: PairingSession): Promise<Uint8Array[]> {
  const begin = await session.receive();
  if (begin.t !== 'records-begin') return session.refuse('protocol-error');
  const records: Uint8Array[] = [];
  for (;;) {
    const message = await session.receive();
    if (records.length < begin.count) {
      if (message.t !== 'record') return session.refuse('protocol-error');
      records.push(message.r);
    } else {
      if (message.t !== 'records-end') return session.refuse('protocol-error');
      return records;
    }
  }
}

export interface ReceiveVaultOptions {
  /** B's keyring: the Master Key goes there, and is released if the transfer fails. */
  readonly keyring: Keyring;
  /** B's display name, sent with `received` (`record-content.md` §7). */
  readonly name: string;
}

/**
 * B's side of §8 up to its commit: the Master Key, the `vaultId` and every record, in memory only
 * (D33). A message out of the order of §8 and `sync-protocol.md` §2.1 aborts (`protocol-error`).
 */
export async function receiveVault(
  session: PairingSession,
  options: ReceiveVaultOptions,
): Promise<ReceivedVault> {
  const first = await session.receive();
  if (first.t !== 'master-key') return session.refuse('protocol-error');
  const masterKey = importTransferKey(options.keyring, first.mk);
  try {
    await session.send({ t: 'received', name: options.name });
    const records = await receiveRecords(session);
    return new ReceivedVault(session, first.vid, masterKey, records);
  } catch (error) {
    options.keyring.release(masterKey);
    throw error;
  }
}

/** What B received, held in memory until `commit` persists it (D33). */
export class ReceivedVault {
  #committed = false;

  constructor(
    private readonly session: PairingSession,
    readonly vaultId: Uint8Array,
    /** In the keyring given to `receiveVault`. */
    readonly masterKey: SymmetricKey,
    /** The record envelopes as received, unverified. */
    readonly records: readonly Uint8Array[],
  ) {}

  /** Whether the session already ended: nothing may be persisted then. */
  get ended(): boolean {
    return this.session.error !== null;
  }

  /**
   * Runs `persist`, B's single commit (§8 step 6), then sends `committed` and ends the session.
   * Refuses to start once the session ended. A `committed` lost after the commit leaves B
   * committed; A then shows the pairing as not completed (D33).
   */
  async commit<T>(persist: () => Promise<T>): Promise<T> {
    if (this.#committed) throw new Error('the transfer was already committed');
    this.#committed = true;
    if (this.session.error) throw this.session.error;
    const result = await guarded(this.session, persist);
    try {
      await this.session.send({ t: 'committed' });
    } catch (error) {
      /* v8 ignore next -- `send` rejects with nothing else for a valid message */
      if (!(error instanceof PairingError)) throw error;
    }
    this.session.close();
    return result;
  }
}
