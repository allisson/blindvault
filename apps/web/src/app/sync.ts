// The manual sync flow (sync-protocol.md §3 to §5, §12, D215, D216): the user picked the peer on
// both devices and chose on each whether it shows its code first (I) or reads the other's (R). Each
// side gathers its connection, seals its fields to the peer with `Noise_K` and hands the bytes to
// the manual delivery, which shows them as a QR code and text; the peer's text goes back through
// the same delivery, and the first one that opens is taken. Once the DataChannel is open, the two
// devices run `Noise_KK` over both payloads (§5, D217) and nothing else is sent before it completes
// (CRYPTO-INV-008). Every later message goes through the session in the Noise channel (§11,
// CRYPTO-INV-009, D218): ending the sync sends `abort` with `ended`, a lock with `locked`, and the
// peer's `abort` ends it with its reason. Right after the handshake, a device that holds the peer's
// Device record retired sends it only that record, as `retired`, then `abort` with `retired-peer`;
// the peer merges it, which shows the D41 notice (§6, D31, D45, D219). The controller asks for the
// same check again after each of its commits that may retire the peer, so a peer retired during the
// session is told so too (D69, D220). Then both exchange their summaries and the records the other
// lacks or holds older, and each merges what it received in one commit (§7 to §9, D222); a merge
// that retired this device's own record ends the session (D69), and one that retired the peer runs
// the check again before `committed`. The live session that follows comes with its task. The
// controller owns the flow and ends it on a lock (D93); this module logs nothing.

import { randomBytes } from '@blindvault/crypto';
import {
  type ConnectionOptions,
  HandshakeError,
  type LinkAnswer,
  type LinkFields,
  type LinkOffer,
  type PayloadExpectation,
  ReconnectionError,
  type ReconnectionKeys,
  type ReconnectionRejection,
  type Role,
  SESSION_TIMEOUT_MS,
  type SessionPayload,
  SyncError,
  SyncRefusal,
  SyncSession,
  type Transport,
  TransportClosedError,
  exchange,
  manualDelivery,
  receiveReconnection,
  sealReconnection,
  syncHandshake,
} from '@blindvault/sync';
import {
  type RecordKey,
  type SyncGrant,
  SyncRejectedError,
  type SyncResult,
} from '@blindvault/vault';

import { DISCONNECT_GRACE_MS, iceServers } from './pairing';
import { type StunSettings } from './stun-settings';

/** WebRTC, behind a port so the flow's tests run over the in-memory transport. */
export interface SyncPort {
  offerLink(sessionId: Uint8Array, options: ConnectionOptions): Promise<LinkOffer>;
  answerLink(offer: LinkFields, options: ConnectionOptions): Promise<LinkAnswer>;
}

/**
 * Why a sync ended before it was closed: its 10 minutes, a closed link, a link not set up, a peer
 * that did not prove the identity of its Device record in `Noise_KK` (D217), the peer that ended
 * the sync or locked (`ended`, `locked`), or a message of another version or out of the protocol,
 * from either side (§11.2, D218). `retired-peer`: this device holds the peer retired and told it
 * so; `retired`: this device's own record arrived retired and merged; `verification-failed`: the
 * peer's retired record held here failed verification, so nothing was sent (§6, D219).
 * `send-failed`: a record this device was about to send failed verification, named by the stage
 * (§8, D181); `peer-verification-failed`: the peer's did (D222).
 */
export type SyncFailure =
  | 'expired'
  | 'closed'
  | 'error'
  | 'unverified'
  | 'ended'
  | 'locked'
  | 'version'
  | 'protocol-error'
  | 'retired-peer'
  | 'retired'
  | 'verification-failed'
  | 'send-failed'
  | 'peer-verification-failed';

/** What the sync screens show (D216). */
export type SyncStage =
  /** Gathering the connection's candidates. */
  | { readonly kind: 'preparing' }
  /** I: its code, for R; waits for R's answer. */
  | { readonly kind: 'offer'; readonly text: string }
  /** R: waits for I's code. */
  | { readonly kind: 'scan' }
  /** R: its answer, for I; waits for the connection. */
  | { readonly kind: 'answer'; readonly text: string }
  /** The DataChannel opening, then `Noise_KK`. */
  | { readonly kind: 'connecting' }
  /** `Noise_KK` completed and the peer is not retired: the summaries and the transfer run (D222). */
  | { readonly kind: 'connected' }
  /** This device merged what the peer sent and sent `committed` (§9). */
  | { readonly kind: 'synced'; readonly result: SyncResult }
  /** `record`: with `send-failed`, the record that failed verification. */
  | { readonly kind: 'failed'; readonly reason: SyncFailure; readonly record?: RecordKey };

/** A text read or pasted: `ok` once taken, why it was refused (§4.3), or not waiting for one. */
export type SyncCheck = 'ok' | ReconnectionRejection | 'unavailable';

export interface SyncFlowOptions {
  readonly port: SyncPort;
  readonly sameNetwork: boolean;
  /** The STUN list stored when the sync starts (D209). */
  readonly stun: StunSettings;
  readonly grant: SyncGrant;
  /** `initiator`: this device shows its code first; `responder`: it reads the other's. */
  readonly role: Role;
  /** The stage changed. */
  readonly onChange: () => void;
}

/** One device's side of one sync session (§12: a payload belongs to one session). */
export class Syncing {
  #stage: SyncStage;
  readonly #options: SyncFlowOptions;
  readonly #connection: ConnectionOptions;
  readonly #abort = new AbortController();
  readonly #delivery = manualDelivery();
  /** Who waits for the outcome of each text submitted, in the order the delivery reads them. */
  #checks: ((check: SyncCheck) => void)[] = [];
  #link: { close(): void } | undefined;
  #transport: Transport | undefined;
  #session: SyncSession | undefined;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #over = false;
  /** The checks of the peer's Device record, one at a time (§6). */
  #checking: Promise<unknown> = Promise.resolve();
  /** A check found the peer retired: this device is ending the session (§6). */
  #retiring = false;
  /** This device's own record arrived retired and merged: the session ends as `retired` (D69). */
  #retired = false;
  /** The record that failed verification as this device was about to send it (§8). */
  #unsent: RecordKey | undefined;

  constructor(options: SyncFlowOptions) {
    this.#options = options;
    this.#stage = options.role === 'initiator' ? { kind: 'preparing' } : { kind: 'scan' };
    this.#connection = {
      iceServers: iceServers(options.sameNetwork, options.stun),
      signal: this.#abort.signal,
    };
  }

  get stage(): SyncStage {
    return this.#stage;
  }

  get role(): Role {
    return this.#options.role;
  }

  /** I gathers and shows its code; R waits for I's. */
  begin(): void {
    void (this.#options.role === 'initiator' ? this.#initiate() : this.#respond()).catch(
      (error: unknown) => {
        this.#fail(error instanceof TransportClosedError ? 'closed' : 'error');
      },
    );
  }

  /**
   * The peer's text, read from its QR code or pasted. Resolves once the delivery read it: `ok` when
   * it opened, otherwise why not, and the wait goes on (§4.4, D215).
   */
  submit(text: string): Promise<SyncCheck> {
    const kind = this.#stage.kind;
    if (this.#over || (kind !== 'offer' && kind !== 'scan')) return Promise.resolve('unavailable');
    try {
      this.#delivery.submit(text);
    } catch (error) {
      if (error instanceof ReconnectionError) return Promise.resolve(error.reason);
      throw error;
    }
    return new Promise((resolve) => {
      this.#checks.push(resolve);
    });
  }

  /**
   * Ends the flow at once, for a cancel or a lock (D93): once `Noise_KK` completed, the peer learns
   * why through `abort` (§11.2, §12); before it, nothing was sent, so nothing to abort.
   */
  end(reason: 'ended' | 'locked' = 'ended'): void {
    if (this.#over) return;
    this.#over = true;
    void this.#session?.abort(reason);
    this.#close();
  }

  /**
   * Checks the peer's Device record again, after a commit that may have retired it: a local
   * retirement or a backup merge (§6, D69, D220). Once `Noise_KK` completed, a retired one ends the
   * session as right after the handshake; before it, that check is still to come.
   */
  recheck(): void {
    const session = this.#session;
    if (!session || this.#over) return;
    this.#checkPeer(session).catch(() => {
      this.#fail('error');
    });
  }

  get #keys(): ReconnectionKeys {
    const { grant } = this.#options;
    return { identity: grant.identity, peerPublicKey: grant.peerPublicKey, vaultId: grant.vaultId };
  }

  async #initiate(): Promise<void> {
    const offer = await this.#options.port.offerLink(randomBytes(16), this.#connection);
    if (!this.#gathered(offer)) return;
    const mine = await this.#show(offer.link, (text) => ({ kind: 'offer', text }));
    const answer = await this.#receive({ role: 'responder', sessionId: offer.link.sessionId });
    if (!answer) return;
    this.#set({ kind: 'connecting' });
    await this.#open(await offer.accept(answer.link), { initiator: mine, responder: answer.sent });
  }

  async #respond(): Promise<void> {
    const offer = await this.#receive({ role: 'initiator' });
    if (!offer) return;
    this.#set({ kind: 'preparing' });
    const answer = await this.#options.port.answerLink(offer.link, this.#connection);
    if (!this.#gathered(answer)) return;
    const mine = await this.#show(answer.link, (text) => ({ kind: 'answer', text }));
    await this.#open(await answer.transport, { initiator: offer.sent, responder: mine });
  }

  /** The link exists: the 10-minute expiry starts with this device's payload (§12). */
  #gathered(link: { close(): void }): boolean {
    if (this.#over) {
      link.close();
      return false;
    }
    this.#link = link;
    this.#expiry = setTimeout(() => {
      this.#fail('expired');
    }, SESSION_TIMEOUT_MS);
    return true;
  }

  /**
   * Seals the link to the peer and shows it through the manual delivery (§4.2, §4.4). Returns what
   * `prologue_KK` binds of it.
   */
  async #show(link: LinkFields, stage: (text: string) => SyncStage): Promise<SessionPayload> {
    const sealed = sealReconnection(link, this.#keys);
    await this.#delivery.send(sealed.bytes);
    this.#set(stage(this.#delivery.text ?? ''));
    return { message: sealed.message, fingerprint: link.fingerprint };
  }

  /** The first payload of the peer that opens, each refusal answered as it comes (§4.4). */
  async #receive(
    expected: PayloadExpectation,
  ): Promise<{ link: LinkFields; sent: SessionPayload } | null> {
    const opened = await receiveReconnection(this.#delivery, this.#keys, expected, (error) => {
      this.#checks.shift()?.(error.reason);
    });
    if (!opened) return null;
    this.#checks.shift()?.('ok');
    this.#settle('unavailable');
    const link = opened.reconnection;
    return { link, sent: { message: opened.message, fingerprint: link.fingerprint } };
  }

  /**
   * Runs `Noise_KK` over the open DataChannel (§5, D217). Nothing but its two messages is sent
   * before it completes (CRYPTO-INV-008); once it has, the payload timeout no longer applies (§12).
   */
  async #open(
    transport: Transport,
    payloads: { initiator: SessionPayload; responder: SessionPayload },
  ): Promise<void> {
    if (this.#over) {
      transport.close();
      return;
    }
    this.#transport = transport;
    const { grant } = this.#options;
    let channel: Transport;
    try {
      ({ channel } = await syncHandshake(transport, {
        role: this.#options.role,
        identity: grant.identity,
        peerPublicKey: grant.peerPublicKey,
        ...payloads,
      }));
    } catch (error) {
      if (error instanceof HandshakeError) {
        this.#fail(error.reason === 'closed' ? 'closed' : 'unverified');
        return;
      }
      throw error;
    }
    // A flow ended meanwhile closed the DataChannel under the channel, which wipes its keys, and
    // `#set` and `#fail` do nothing once it is over.
    clearTimeout(this.#expiry);
    this.#transport = channel;
    const session = new SyncSession(channel);
    this.#session = session;
    if (await this.#checkPeer(session)) return;
    // A check asked for meanwhile runs before the sync shows as connected.
    for (let tail: Promise<unknown> | undefined; tail !== this.#checking;) {
      tail = this.#checking;
      await tail;
    }
    // A flow ended otherwise sets nothing, and its session refuses to be read.
    if (this.#retiring) return;
    this.#set({ kind: 'connected' });
    await this.#exchange(session);
  }

  /**
   * §7 to §9 (D222): the summaries and the transfer, then the merge; after it, the check of §6 again
   * before `committed`, since the transfer may have retired the peer (D220). A merge that retired
   * this device's own record ends the session instead (D69).
   */
  async #exchange(session: SyncSession): Promise<void> {
    const { grant } = this.#options;
    let result: SyncResult;
    try {
      result = await exchange(session, {
        summary: grant.summary(),
        records: (selected) => this.#vault(() => grant.records(selected)),
        merge: (records) => this.#vault(() => grant.merge(records)),
        retired: async (envelope) => {
          await this.#vault(() => grant.mergeOwnRetirement(envelope));
          this.#retired = true;
        },
      });
    } catch (error) {
      this.#ended(error);
      return;
    }
    if (result.ownRetired) {
      this.#retired = true;
      await session.abort('ended');
      this.#fail('retired');
      return;
    }
    if (await this.#checkPeer(session)) return;
    try {
      await session.send({ t: 'committed' });
    } catch (error) {
      this.#ended(error);
      return;
    }
    this.#set({ kind: 'synced', result });
    await this.#listen(session);
  }

  /** Runs a vault call; its refusal aborts the session with the reason it gives. */
  async #vault<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      if (!(error instanceof SyncRejectedError)) throw error;
      this.#unsent = error.record;
      throw new SyncRefusal(error.reason, { cause: error });
    }
  }

  /**
   * Reads the peer's Device record again and verifies it, after the checks before it (§6, D219):
   * `true` once the session is over, or ending because the peer is retired.
   */
  #checkPeer(session: SyncSession): Promise<boolean> {
    const check = this.#checking.then(async () => {
      if (this.#over || this.#retiring) return true;
      let retirement: Uint8Array | undefined;
      try {
        retirement = await this.#options.grant.peerRetirement();
      } catch (error) {
        // The one refusal of `peerRetirement`: the record it was about to send failed verification.
        if (!(error instanceof SyncRejectedError)) throw error;
        await this.#retire(session, undefined, 'verification-failed');
        return true;
      }
      if (!retirement) return false;
      await this.#retire(session, retirement, 'retired-peer');
      return true;
    });
    this.#checking = check.catch(() => undefined);
    return check;
  }

  /**
   * Ends the session with a peer this device holds retired (§6, CRYPTO-INV-015): its retired record,
   * the only record it is ever sent, then `abort`; or only `abort`, when that record failed.
   */
  async #retire(
    session: SyncSession,
    retirement: Uint8Array | undefined,
    reason: 'retired-peer' | 'verification-failed',
  ): Promise<void> {
    this.#retiring = true;
    // After the message being sent and before any other: nothing follows the record (§6).
    await (retirement ? session.retire(retirement) : session.abort(reason));
    this.#fail(reason);
  }

  /**
   * After this device's `committed`: the peer's `committed`, once, which makes the session live
   * (§9, §12), and `retired`, this device's own Device record retired, merged once (§6, D219). Any
   * other message is out of the protocol (§11.1) until the live session's task.
   */
  async #listen(session: SyncSession): Promise<void> {
    let committed = false;
    try {
      for (;;) {
        const message = await session.receive();
        if (message.t === 'committed' && !committed) {
          committed = true;
          session.live();
        } else if (message.t === 'retired' && !this.#retired) {
          await this.#mergeRetirement(session, message.r);
        } else {
          await session.refuse('protocol-error');
        }
      }
    } catch (error) {
      this.#ended(error);
    }
  }

  /** Merges the peer's `retired`, or refuses it with the vault's reason, merging nothing. */
  async #mergeRetirement(session: SyncSession, envelope: Uint8Array): Promise<void> {
    try {
      await this.#vault(() => this.#options.grant.mergeOwnRetirement(envelope));
    } catch (error) {
      if (error instanceof SyncRefusal) await session.refuse(error.reason);
      throw error;
    }
    this.#retired = true;
  }

  /**
   * The session ended: shows why, unless the flow is over or this device is ending it with a peer
   * retired meanwhile, which shows why itself. Once its own record merged retired, this device knows
   * why, however the session ends.
   */
  #ended(error: unknown): void {
    if (this.#over || this.#retiring) return;
    if (!(error instanceof SyncError)) {
      this.#fail('error');
      return;
    }
    if (this.#retired) this.#fail('retired');
    else if (error.reason === 'verification-failed' && error.by === 'local' && this.#unsent) {
      this.#fail('send-failed', this.#unsent);
    } else this.#fail(failureOf(error));
  }

  #set(stage: SyncStage): void {
    if (this.#over) return;
    this.#stage = stage;
    this.#options.onChange();
  }

  #fail(reason: SyncFailure, record?: RecordKey): void {
    if (this.#over) return;
    this.#stage = { kind: 'failed', reason, ...(record ? { record } : {}) };
    this.#over = true;
    this.#close();
    this.#options.onChange();
  }

  #close(): void {
    clearTimeout(this.#expiry);
    this.#delivery.close();
    this.#settle('unavailable');
    const disconnect = () => {
      this.#abort.abort();
      this.#transport?.close();
      this.#link?.close();
    };
    if (!this.#session) {
      disconnect();
      return;
    }
    // The session's `abort` may still be on its way: the session closes the channel once it is
    // sent. Closing the connection now would drop it, and the peer would see a closed link instead
    // of the reason (§11.2, D93); this closes it in any case once the grace has passed.
    setTimeout(disconnect, DISCONNECT_GRACE_MS);
  }

  #settle(check: SyncCheck): void {
    for (const resolve of this.#checks.splice(0)) resolve(check);
  }
}

/**
 * What the screens show for a session that ended. `ended` and `locked` come only from the peer: a
 * local end closes the flow with no failure. The peer's `retired-peer` shows as `retired` only once
 * this device merged its record, and reads as `protocol-error` otherwise; the peer's
 * `verification-failed` is a record it could not send (§8).
 */
function failureOf(error: SyncError): SyncFailure {
  switch (error.reason) {
    case 'closed':
    case 'expired':
    case 'ended':
    case 'locked':
    case 'version':
    case 'protocol-error':
      return error.reason;
    case 'verification-failed':
      return error.by === 'remote' ? 'peer-verification-failed' : 'verification-failed';
    default:
      return 'protocol-error';
  }
}
