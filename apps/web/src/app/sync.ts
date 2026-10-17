// The manual sync flow (sync-protocol.md §3 to §5, §12, D215, D216): the user picked the peer on
// both devices and chose on each whether it shows its code first (I) or reads the other's (R). Each
// side gathers its connection, seals its fields to the peer with `Noise_K` and hands the bytes to
// the manual delivery, which shows them as a QR code and text; the peer's text goes back through
// the same delivery, and the first one that opens is taken. The flow ends once the DataChannel is
// open: nothing is sent before `Noise_KK` (CRYPTO-INV-008), which comes with its task. The
// controller owns the flow and ends it on a lock (D93); this module logs nothing.

import { randomBytes } from '@blindvault/crypto';
import {
  type ConnectionOptions,
  type LinkAnswer,
  type LinkFields,
  type LinkOffer,
  type PayloadExpectation,
  ReconnectionError,
  type ReconnectionKeys,
  type ReconnectionRejection,
  type Role,
  SESSION_TIMEOUT_MS,
  type Transport,
  TransportClosedError,
  manualDelivery,
  receiveReconnection,
  sealReconnection,
} from '@blindvault/sync';
import { type SyncGrant } from '@blindvault/vault';

import { iceServers } from './pairing';
import { type StunSettings } from './stun-settings';

/** WebRTC, behind a port so the flow's tests run over the in-memory transport. */
export interface SyncPort {
  offerLink(sessionId: Uint8Array, options: ConnectionOptions): Promise<LinkOffer>;
  answerLink(offer: LinkFields, options: ConnectionOptions): Promise<LinkAnswer>;
}

/** Why a sync ended before it was closed: its 10 minutes, a closed link, or a link not set up. */
export type SyncFailure = 'expired' | 'closed' | 'error';

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
  | { readonly kind: 'connecting' }
  /** The DataChannel is open; `Noise_KK` and the exchange of records come with their tasks. */
  | { readonly kind: 'connected' }
  | { readonly kind: 'failed'; readonly reason: SyncFailure };

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
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #over = false;

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

  /** Ends the flow at once, for a cancel or a lock (D93): nothing was sent, so nothing to abort. */
  end(): void {
    if (this.#over) return;
    this.#over = true;
    this.#close();
  }

  get #keys(): ReconnectionKeys {
    const { grant } = this.#options;
    return { identity: grant.identity, peerPublicKey: grant.peerPublicKey, vaultId: grant.vaultId };
  }

  async #initiate(): Promise<void> {
    const offer = await this.#options.port.offerLink(randomBytes(16), this.#connection);
    if (!this.#gathered(offer)) return;
    await this.#show(offer.link, (text) => ({ kind: 'offer', text }));
    const answer = await this.#receive({ role: 'responder', sessionId: offer.link.sessionId });
    if (!answer) return;
    this.#set({ kind: 'connecting' });
    this.#open(await offer.accept(answer));
  }

  async #respond(): Promise<void> {
    const offer = await this.#receive({ role: 'initiator' });
    if (!offer) return;
    this.#set({ kind: 'preparing' });
    const answer = await this.#options.port.answerLink(offer, this.#connection);
    if (!this.#gathered(answer)) return;
    await this.#show(answer.link, (text) => ({ kind: 'answer', text }));
    this.#open(await answer.transport);
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

  /** Seals the link to the peer and shows it through the manual delivery (§4.2, §4.4). */
  async #show(link: LinkFields, stage: (text: string) => SyncStage): Promise<void> {
    await this.#delivery.send(sealReconnection(link, this.#keys).bytes);
    this.#set(stage(this.#delivery.text ?? ''));
  }

  /** The first payload of the peer that opens, each refusal answered as it comes (§4.4). */
  async #receive(expected: PayloadExpectation): Promise<LinkFields | null> {
    const opened = await receiveReconnection(this.#delivery, this.#keys, expected, (error) => {
      this.#checks.shift()?.(error.reason);
    });
    if (!opened) return null;
    this.#checks.shift()?.('ok');
    this.#settle('unavailable');
    return opened.reconnection;
  }

  #open(transport: Transport): void {
    if (this.#over) {
      transport.close();
      return;
    }
    this.#transport = transport;
    this.#set({ kind: 'connected' });
    void transport.closed.then(() => {
      this.#fail('closed');
    });
  }

  #set(stage: SyncStage): void {
    if (this.#over) return;
    this.#stage = stage;
    this.#options.onChange();
  }

  #fail(reason: SyncFailure): void {
    if (this.#over) return;
    this.#stage = { kind: 'failed', reason };
    this.#over = true;
    this.#close();
    this.#options.onChange();
  }

  #close(): void {
    clearTimeout(this.#expiry);
    this.#delivery.close();
    this.#settle('unavailable');
    this.#abort.abort();
    this.#transport?.close();
    this.#link?.close();
  }

  #settle(check: SyncCheck): void {
    for (const resolve of this.#checks.splice(0)) resolve(check);
  }
}
