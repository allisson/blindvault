// The pairing of overview §8.4 as this app runs it (pairing-protocol.md, D202, D203): A invites
// from its unlocked vault, B joins from an installation with no vault. Each side is one flow over
// `packages/sync`: the payloads exchanged by copy/paste, WebRTC, Noise_XX, the SAS the user
// compares on both devices, then the transfer. A re-admission (§9, D206, D207) runs between two
// unlocked devices of the same vault, either one showing its text first. The controller owns the
// flow, ends it on a lock (D93) and runs B's commit; this module holds no key of its own and logs
// nothing.

import {
  type DeviceIdentity,
  type Keyring,
  RECORD_FORMAT_VERSION,
  RecordType,
  pairingNonce,
  randomBytes,
} from '@blindvault/crypto';
import {
  type ConnectionOptions,
  HandshakeError,
  type Initiator,
  type InitiatorContext,
  type NonceExchangeOptions,
  PairingError,
  type PairingFailure,
  PairingSession,
  type Payload,
  type PayloadContext,
  PayloadError,
  type ReceivedVault,
  type Responder,
  type Role,
  SESSION_TIMEOUT_MS,
  TransferRefusal,
  type Transport,
  TransportClosedError,
  decodePayloadText,
  encodePayload,
  encodePayloadText,
  exchangeNonces,
  pairingHandshake,
  readmit,
  receiveVault,
  sendVault,
} from '@blindvault/sync';
import {
  JoinRejectedError,
  type PairingGrant,
  PairingRefusedError,
  type ReadmissionGrant,
  type ReadmissionResult,
  VaultLockedError,
  type VaultSession,
} from '@blindvault/vault';

/** WebRTC, behind a port so the controller's tests run over the in-memory transport. */
export interface PairingPort {
  startInitiator(context: InitiatorContext, options: ConnectionOptions): Promise<Initiator>;
  startResponder(
    offer: Payload,
    context: PayloadContext,
    options: ConnectionOptions,
  ): Promise<Responder>;
}

/** The default STUN servers (§9.2); none on the same network only (D203). */
export const STUN_SERVERS: readonly RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

export function iceServers(sameNetwork: boolean): readonly RTCIceServer[] {
  return sameNetwork ? [] : STUN_SERVERS;
}

/** What this version supports, for the payload's capabilities (D122). */
export const FORMAT_VERSIONS: readonly number[] = [RECORD_FORMAT_VERSION];
export const RECORD_TYPES: readonly number[] = Object.values(RecordType).sort((a, b) => a - b);

/**
 * Whether the joining device supports every format and type this version does. In v1 a device holds
 * no record of a format or type its version does not support (D68, D81), so this covers every record
 * A holds (D122, D203).
 */
export function supportsOurs(peer: {
  readonly formatVersions: readonly number[];
  readonly recordTypes: readonly number[];
}): boolean {
  return (
    FORMAT_VERSIONS.every((v) => peer.formatVersions.includes(v)) &&
    RECORD_TYPES.every((t) => peer.recordTypes.includes(t))
  );
}

/** The abort reason a vault error stands for (pairing-protocol.md §10.3). */
export function refusal(error: unknown): unknown {
  if (error instanceof JoinRejectedError) {
    return new TransferRefusal(error.reason, { cause: error });
  }
  if (error instanceof VaultLockedError) return new TransferRefusal('locked', { cause: error });
  if (error instanceof PairingRefusedError) {
    const reason = error.reason === 'corrupt-record' ? 'verification-failed' : 'protocol-error';
    return new TransferRefusal(reason, { cause: error });
  }
  return error;
}

function mapped<T>(run: () => Promise<T>): Promise<T> {
  return run().catch((error: unknown) => {
    throw refusal(error);
  });
}

/** Why a pairing ended, and on which side. */
export interface Ending {
  readonly reason: PairingFailure;
  readonly by: 'local' | 'remote';
}

export function endingOf(error: unknown): Ending {
  if (error instanceof PairingError) return { reason: error.reason, by: error.by };
  if (error instanceof HandshakeError) {
    // A closed handshake is the peer's refusal or a lost link (§1).
    return error.reason === 'closed'
      ? { reason: 'closed', by: 'remote' }
      : { reason: 'protocol-error', by: 'local' };
  }
  if (error instanceof TransportClosedError) return { reason: 'closed', by: 'remote' };
  return { reason: 'protocol-error', by: 'local' };
}

/** What the pairing screens show (D203). */
export type PairingStage =
  /** Gathering the connection's candidates, or B deriving its Device KEK. */
  | { readonly kind: 'preparing' }
  /** A: its payload, to copy to B; waits for B's answer. */
  | { readonly kind: 'offer'; readonly text: string }
  /** B: waits for A's payload. */
  | { readonly kind: 'scan' }
  /** B: its answer, to copy back to A; waits for the connection. */
  | { readonly kind: 'answer'; readonly text: string }
  | { readonly kind: 'connecting' }
  /** `confirmed`: this device said the SAS matches, and waits for the other's. */
  | { readonly kind: 'sas'; readonly sas: string; readonly confirmed: boolean }
  | { readonly kind: 'transfer' }
  /** A: B committed. `readmit`: recommend re-admission (D141). */
  | { readonly kind: 'done'; readonly name: string; readonly readmit: boolean }
  /**
   * A re-admission merged (§9, D207): the peer's name, the merge's result, and whether the peer's
   * `committed` came, otherwise its merge may not have completed.
   */
  | {
      readonly kind: 'readmitted';
      readonly name: string;
      readonly result: ReadmissionResult;
      readonly peerCommitted: boolean;
    }
  | ({ readonly kind: 'failed' } & Ending);

/** A pasted payload: `ok` once it is taken, or why not. */
export type PayloadCheck =
  | 'ok'
  | 'invalid'
  | 'version'
  | 'wrong-session'
  /** A: B lacks a format or type this version supports (D122). */
  | 'outdated-peer'
  /** A: the answer comes from a device that holds a vault: re-admission instead (D207). */
  | 'peer-holds-vault'
  /** B, or either side of a re-admission: the text comes from a device that holds no vault (§7). */
  | 'peer-no-vault'
  /** Not waiting for a payload now. */
  | 'unavailable';

function payloadCheck(error: unknown): PayloadCheck {
  if (!(error instanceof PayloadError)) throw error;
  if (error.reason === 'version') return 'version';
  if (error.reason === 'wrong-session') return 'wrong-session';
  return 'invalid';
}

/** How long a session's last message has to leave before the connection is closed anyway. */
const DISCONNECT_GRACE_MS = 3_000;

interface FlowOptions {
  readonly port: PairingPort;
  readonly sameNetwork: boolean;
  /** The stage changed. */
  readonly onChange: () => void;
}

/** One device's side of one session (§11: a session is used once). */
abstract class Flow {
  #stage: PairingStage;
  readonly #onChange: () => void;
  readonly #abort = new AbortController();
  protected readonly port: PairingPort;
  protected readonly options: ConnectionOptions;
  #connection: { close(): void } | undefined;
  #session: PairingSession | undefined;
  #expiresAt = 0;
  #expiry: ReturnType<typeof setTimeout> | undefined;
  #answer: ((matches: boolean) => void) | undefined;
  #over = false;

  constructor(options: FlowOptions, stage: PairingStage) {
    this.#stage = stage;
    this.#onChange = options.onChange;
    this.port = options.port;
    this.options = { iceServers: iceServers(options.sameNetwork), signal: this.#abort.signal };
  }

  get stage(): PairingStage {
    return this.#stage;
  }

  protected set(stage: PairingStage): void {
    if (this.#over) return;
    this.#stage = stage;
    this.#onChange();
  }

  /** Whether the flow ended: a lock, a cancel, a failure or its success. */
  protected get over(): boolean {
    return this.#over;
  }

  /** The connection, once its payload exists: the 10-minute expiry starts with it (§11). */
  protected connected(connection: { close(): void }): void {
    this.#connection = connection;
    this.#expiresAt = Date.now() + SESSION_TIMEOUT_MS;
    this.#expiry = setTimeout(() => {
      this.#fail({ reason: 'expired', by: 'local' });
    }, SESSION_TIMEOUT_MS);
  }

  /**
   * The handshake, the nonces and the user's answer to the SAS (§5, §6). Resolves once both
   * devices confirmed; rejects with the session's error otherwise.
   */
  protected async secure(
    transport: Transport,
    handshake: Parameters<typeof pairingHandshake>[1],
    nonces: (handshakeHash: Uint8Array) => NonceExchangeOptions,
    checkPeer?: (peerPublicKey: Uint8Array) => void,
  ) {
    const result = await pairingHandshake(transport, handshake);
    const session = new PairingSession(result.channel, { expiresAt: this.#expiresAt });
    // The session expires on its own from now on.
    clearTimeout(this.#expiry);
    this.#session = session;
    if (this.#over) {
      await session.abort('cancelled');
      throw new Error('ended');
    }
    if (checkPeer) {
      // Re-admission §9 step 1: before the nonces, a retired peer is refused (D45, D49).
      try {
        checkPeer(result.peerPublicKey);
      } catch (error) {
        const refused = refusal(error);
        if (refused instanceof TransferRefusal) await session.refuse(refused.reason, error);
        throw error;
      }
    }
    const sas = await exchangeNonces(session, nonces(result.handshakeHash));
    this.set({ kind: 'sas', sas: sas.sas, confirmed: false });
    const answer = new Promise<boolean>((resolve) => {
      this.#answer = resolve;
    });
    const ended = session.ended.then((error) => {
      throw error;
    });
    const matches = await Promise.race([answer, ended]);
    if (!matches) {
      await sas.reject('sas-mismatch');
      throw await session.ended;
    }
    await sas.confirm();
    this.set({ kind: 'transfer' });
    return { ...result, session };
  }

  /** The user said the SAS matches (§6.4). */
  confirm(): void {
    const stage = this.#stage;
    if (stage.kind !== 'sas' || stage.confirmed) return;
    this.set({ ...stage, confirmed: true });
    this.#answer?.(true);
  }

  /** The user said the SAS does not match (§6.4). */
  reject(): void {
    if (this.#stage.kind !== 'sas') return;
    this.#answer?.(false);
  }

  /**
   * Ends the flow at once, for a cancel or a lock (D93): every secret of the session wiped now,
   * `abort` with `reason` sent when the channel is open, then the connection closed.
   */
  end(reason: 'cancelled' | 'locked'): void {
    if (this.#over) return;
    this.#over = true;
    void this.#session?.abort(reason);
    this.#close(false);
  }

  /** The flow failed: shows why, with every secret of the session wiped. */
  protected failed(error: unknown): void {
    if (this.#over) return;
    this.#fail(endingOf(error));
  }

  #fail(ending: Ending): void {
    if (this.#over) return;
    const session = this.#session;
    if (session && !session.error)
      void session.abort(ending.reason === 'expired' ? 'expired' : 'protocol-error');
    this.#stage = { kind: 'failed', ...ending };
    this.#over = true;
    this.#close(false);
    this.#onChange();
  }

  /** The flow succeeded: the connection closes, and what the flow holds is released. */
  protected succeeded(stage: PairingStage | undefined): void {
    if (this.#over) return;
    if (stage) this.#stage = stage;
    this.#over = true;
    this.#close(true);
    this.#onChange();
  }

  #close(success: boolean): void {
    clearTimeout(this.#expiry);
    this.#answer?.(false);
    this.release(success);
    const disconnect = () => {
      this.#abort.abort();
      this.#connection?.close();
    };
    if (!this.#session) {
      disconnect();
      return;
    }
    // The session's last message, `abort` or `committed`, may still be on its way: the session
    // closes the channel once it is sent, and the connection follows it (connection.ts). Closing
    // the connection now would drop it, and the peer would see a closed link instead of the
    // reason (§10.3, D93); this closes it in any case once the grace has passed.
    setTimeout(disconnect, DISCONNECT_GRACE_MS);
  }

  /** Wipes what the flow holds; `success` only once the transfer completed. */
  protected abstract release(success: boolean): void;
}

export interface InviteOptions extends FlowOptions {
  readonly grant: PairingGrant;
  /** A held no Device record of its own while other non-retired ones exist (D141). */
  readonly readmit: boolean;
}

/** A's side (§8): it shows the first payload, then sends the vault once both confirmed. */
export class Inviting extends Flow {
  readonly #grant: PairingGrant;
  readonly #readmit: boolean;
  #nonce: Uint8Array | undefined;
  #initiator: Initiator | undefined;
  #taken = false;

  constructor(options: InviteOptions) {
    super(options, { kind: 'preparing' });
    this.#grant = options.grant;
    this.#readmit = options.readmit;
  }

  /** Gathers the connection and shows A's payload. */
  async begin(): Promise<void> {
    const drawn = pairingNonce();
    this.#nonce = drawn.nonce;
    try {
      const initiator = await this.port.startInitiator(
        {
          sessionId: randomBytes(16),
          commitment: drawn.commitment,
          holdsVault: true,
          formatVersions: FORMAT_VERSIONS,
          recordTypes: RECORD_TYPES,
        },
        this.options,
      );
      if (this.over) {
        initiator.close();
        return;
      }
      this.#initiator = initiator;
      this.connected(initiator);
      this.set({ kind: 'offer', text: encodePayloadText(initiator.payload) });
    } catch (error) {
      this.failed(error);
    }
  }

  /** Takes B's answer, pasted, and connects. */
  answer(text: string): PayloadCheck {
    const initiator = this.#initiator;
    if (this.stage.kind !== 'offer' || !initiator || this.#taken) return 'unavailable';
    let answer: Payload;
    try {
      answer = decodePayloadText(text, {
        role: 'responder',
        sessionId: initiator.payload.sessionId,
      });
    } catch (error) {
      return payloadCheck(error);
    }
    if (answer.holdsVault) return 'peer-holds-vault';
    if (!supportsOurs(answer)) return 'outdated-peer';
    this.#taken = true;
    this.set({ kind: 'connecting' });
    void this.#run(initiator, answer);
    return 'ok';
  }

  async #run(initiator: Initiator, answer: Payload): Promise<void> {
    const grant = this.#grant;
    try {
      const transport = await initiator.accept(answer);
      const { session, peerPublicKey, peerDeviceId } = await this.secure(
        transport,
        {
          role: 'initiator',
          identity: grant.identity,
          payloadInitiator: encodePayload(initiator.payload),
          payloadResponder: encodePayload(answer),
        },
        (handshakeHash) => {
          const nonce = this.#nonce ?? new Uint8Array(0);
          this.#nonce = undefined;
          return { role: 'initiator', handshakeHash, nonce };
        },
      );
      let name = '';
      await sendVault(session, {
        vaultId: grant.vaultId,
        masterKey: grant.masterKey,
        admit: (received) =>
          mapped(async () => {
            name = received;
            await grant.admit(peerPublicKey, received);
            return grant.records();
          }),
        completed: () => grant.completed(peerDeviceId),
      });
      this.succeeded({ kind: 'done', name, readmit: this.#readmit });
    } catch (error) {
      this.failed(error);
    }
  }

  protected release(): void {
    this.#nonce?.fill(0);
    this.#nonce = undefined;
    this.#grant.wipe();
  }
}

export interface JoinFlowOptions extends FlowOptions {
  /** B's identity, generated before the handshake (D33). */
  readonly identity: DeviceIdentity;
  /** B's display name, sent with `received`. */
  readonly name: string;
  /**
   * B's single commit (§8 step 6): resolves with the new session once committed. A vault error
   * aborts the transfer with its reason.
   */
  readonly commit: (received: ReceivedVault, peerPublicKey: Uint8Array) => Promise<VaultSession>;
  /** The keyring of the identity, the Device KEK and, once received, the Master Key. */
  readonly keyring: Keyring;
  /** Runs once when the flow ends; `joined` after the commit. */
  readonly released: (joined: boolean) => void;
}

/** B's side (§8): it answers A's payload, then receives the vault and commits it. */
export class Joining extends Flow {
  readonly #options: JoinFlowOptions;
  #released = false;

  constructor(options: JoinFlowOptions) {
    super(options, { kind: 'scan' });
    this.#options = options;
  }

  /** Takes A's payload, pasted, gathers and shows B's answer. */
  async offer(text: string): Promise<PayloadCheck> {
    if (this.stage.kind !== 'scan') return 'unavailable';
    let offer: Payload;
    try {
      offer = decodePayloadText(text, { role: 'initiator' });
    } catch (error) {
      return payloadCheck(error);
    }
    if (!offer.holdsVault) return 'peer-no-vault';
    this.set({ kind: 'preparing' });
    let responder: Responder;
    try {
      responder = await this.port.startResponder(
        offer,
        { holdsVault: false, formatVersions: FORMAT_VERSIONS, recordTypes: RECORD_TYPES },
        this.options,
      );
    } catch (error) {
      this.failed(error);
      return 'ok';
    }
    if (this.over) {
      responder.close();
      return 'ok';
    }
    this.connected(responder);
    this.set({ kind: 'answer', text: encodePayloadText(responder.payload) });
    void this.#run(offer, responder);
    return 'ok';
  }

  async #run(offer: Payload, responder: Responder): Promise<void> {
    const options = this.#options;
    try {
      const transport = await responder.transport;
      this.set({ kind: 'connecting' });
      const commitment = offer.commitment ?? new Uint8Array(0);
      const { session, peerPublicKey } = await this.secure(
        transport,
        {
          role: 'responder',
          identity: options.identity,
          payloadInitiator: encodePayload(offer),
          payloadResponder: encodePayload(responder.payload),
        },
        (handshakeHash) => ({ role: 'responder', handshakeHash, commitment }),
      );
      // Its Master Key goes into the keyring, which the session owns once committed.
      const received = await receiveVault(session, {
        keyring: options.keyring,
        name: options.name,
      });
      await received.commit(() => mapped(() => options.commit(received, peerPublicKey)));
      this.succeeded(undefined);
    } catch (error) {
      this.failed(error);
    }
  }

  protected release(success: boolean): void {
    if (this.#released) return;
    this.#released = true;
    if (!success) this.#options.keyring.wipeAll();
    this.#options.released(success);
  }
}

export interface ReadmitFlowOptions extends FlowOptions {
  readonly grant: ReadmissionGrant;
  /** `initiator`: this device shows its text first; `responder`: it pastes the other's (D207). */
  readonly role: Role;
  /**
   * This device's display name, sent in `devices` and given to its own record when it writes it:
   * its own record's, or the default name when it holds none (D141, D206).
   */
  readonly name: string;
  /** This side's merge committed (§9 step 6). */
  readonly merged: () => void;
}

/** Either side of a re-admission (§9, D206, D207): no key leaves the device. */
export class Readmitting extends Flow {
  readonly #options: ReadmitFlowOptions;
  #nonce: Uint8Array | undefined;
  #initiator: Initiator | undefined;
  #taken = false;

  constructor(options: ReadmitFlowOptions) {
    super(options, options.role === 'initiator' ? { kind: 'preparing' } : { kind: 'scan' });
    this.#options = options;
  }

  get role(): Role {
    return this.#options.role;
  }

  /** The initiator gathers the connection and shows its text. */
  async begin(): Promise<void> {
    if (this.#options.role !== 'initiator') return;
    const drawn = pairingNonce();
    this.#nonce = drawn.nonce;
    try {
      const initiator = await this.port.startInitiator(
        {
          sessionId: randomBytes(16),
          commitment: drawn.commitment,
          holdsVault: true,
          formatVersions: FORMAT_VERSIONS,
          recordTypes: RECORD_TYPES,
        },
        this.options,
      );
      if (this.over) {
        initiator.close();
        return;
      }
      this.#initiator = initiator;
      this.connected(initiator);
      this.set({ kind: 'offer', text: encodePayloadText(initiator.payload) });
    } catch (error) {
      this.failed(error);
    }
  }

  /** The initiator takes the responder's answer, pasted, and connects. */
  answer(text: string): PayloadCheck {
    const initiator = this.#initiator;
    if (this.stage.kind !== 'offer' || !initiator || this.#taken) return 'unavailable';
    let answer: Payload;
    try {
      answer = decodePayloadText(text, {
        role: 'responder',
        sessionId: initiator.payload.sessionId,
      });
    } catch (error) {
      return payloadCheck(error);
    }
    if (!answer.holdsVault) return 'peer-no-vault';
    this.#taken = true;
    this.set({ kind: 'connecting' });
    void this.#connect(async () => {
      const transport = await initiator.accept(answer);
      return {
        transport,
        payloadInitiator: encodePayload(initiator.payload),
        payloadResponder: encodePayload(answer),
        nonces: (handshakeHash: Uint8Array): NonceExchangeOptions => {
          const nonce = this.#nonce ?? new Uint8Array(0);
          this.#nonce = undefined;
          return { role: 'initiator', handshakeHash, nonce };
        },
      };
    });
    return 'ok';
  }

  /** The responder takes the initiator's text, pasted, gathers and shows its answer. */
  async offer(text: string): Promise<PayloadCheck> {
    if (this.#options.role !== 'responder' || this.stage.kind !== 'scan') return 'unavailable';
    let offer: Payload;
    try {
      offer = decodePayloadText(text, { role: 'initiator' });
    } catch (error) {
      return payloadCheck(error);
    }
    if (!offer.holdsVault) return 'peer-no-vault';
    this.set({ kind: 'preparing' });
    let responder: Responder;
    try {
      responder = await this.port.startResponder(
        offer,
        { holdsVault: true, formatVersions: FORMAT_VERSIONS, recordTypes: RECORD_TYPES },
        this.options,
      );
    } catch (error) {
      this.failed(error);
      return 'ok';
    }
    if (this.over) {
      responder.close();
      return 'ok';
    }
    this.connected(responder);
    this.set({ kind: 'answer', text: encodePayloadText(responder.payload) });
    void this.#connect(async () => {
      const transport = await responder.transport;
      this.set({ kind: 'connecting' });
      const commitment = offer.commitment ?? new Uint8Array(0);
      return {
        transport,
        payloadInitiator: encodePayload(offer),
        payloadResponder: encodePayload(responder.payload),
        nonces: (handshakeHash: Uint8Array): NonceExchangeOptions => ({
          role: 'responder',
          handshakeHash,
          commitment,
        }),
      };
    });
    return 'ok';
  }

  async #connect(
    open: () => Promise<{
      readonly transport: Transport;
      readonly payloadInitiator: Uint8Array;
      readonly payloadResponder: Uint8Array;
      readonly nonces: (handshakeHash: Uint8Array) => NonceExchangeOptions;
    }>,
  ): Promise<void> {
    const { grant, role, name } = this.#options;
    try {
      const link = await open();
      const { session, peerPublicKey, handshakeHash } = await this.secure(
        link.transport,
        {
          role,
          identity: grant.identity,
          payloadInitiator: link.payloadInitiator,
          payloadResponder: link.payloadResponder,
        },
        link.nonces,
        (key) => {
          grant.checkPeer(key);
        },
      );
      const peerRole: Role = role === 'initiator' ? 'responder' : 'initiator';
      let peerName = '';
      const { result, peerCommitted } = await readmit(session, {
        role,
        mac: () => grant.mac(role, handshakeHash),
        checkPeerMac: (mac) => grant.checkMac(peerRole, handshakeHash, mac),
        devices: { ...grant.held(peerPublicKey), name },
        admit: (writes, peer) =>
          mapped(() => {
            peerName = peer.name;
            return grant.admit(writes, peerPublicKey, peer.name, name);
          }),
        records: () => mapped(() => grant.records()),
        merge: (records) =>
          mapped(async () => {
            const merged = await grant.merge(records, peerPublicKey);
            this.#options.merged();
            return merged;
          }),
      });
      this.succeeded({ kind: 'readmitted', name: peerName, result, peerCommitted });
    } catch (error) {
      this.failed(error);
    }
  }

  protected release(): void {
    this.#nonce?.fill(0);
    this.#nonce = undefined;
  }
}
