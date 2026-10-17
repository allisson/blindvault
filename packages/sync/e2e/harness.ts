// A page for the Playwright tests: one device's side of the WebRTC connection of a pairing or a
// sync, driven through `window.harness`. Two pages, in two browser contexts, pair or reconnect by
// passing the base45 texts.

import {
  type DeviceIdentity,
  Keyring,
  generateDeviceIdentity,
  initCrypto,
  pairingNonce,
} from '@blindvault/crypto';

import {
  HandshakeError,
  type Initiator,
  type LinkOffer,
  PairingError,
  PairingSession,
  PayloadError,
  type Role,
  type SessionPayload,
  type Transport,
  type SasStage,
  ReconnectionError,
  TransportClosedError,
  answerLink,
  decodeBase45,
  decodePayloadText,
  decodeReconnectionText,
  encodePayloadText,
  encodeReconnectionText,
  exchangeNonces,
  offerLink,
  openReconnection,
  pairingHandshake,
  sealReconnection,
  startInitiator,
  startResponder,
  syncHandshake,
} from '../src/index';

const context = { holdsVault: true, formatVersions: [1], recordTypes: [1, 2, 3, 4, 5, 6] };
const options = { iceServers: [] };

let initiator: Initiator | undefined;
// A sync: this device's identity, the peer's public key, and the initiator's side of the link.
let identity: DeviceIdentity | undefined;
let peerPublicKey: Uint8Array | undefined;
let syncOffer: LinkOffer | undefined;
// What `prologue_KK` binds of each side's reconnection payload, and this side's role in the sync.
const sessionPayloads: { role?: Role; initiator?: SessionPayload; responder?: SessionPayload } = {};
const vaultId = new Uint8Array(16).fill(0x42);
let transport: Promise<Transport> | undefined;
let channel: Transport | undefined;
let session: PairingSession | undefined;
let stage: SasStage | undefined;
// The initiator's nonce and the commitment its payload carries (`pairing-protocol.md` §6.1).
let drawn: { nonce: Uint8Array; commitment: Uint8Array } | undefined;
// The texts as exchanged, for the prologue: the initiator's, then the responder's.
const texts: { role?: Role; initiator?: string; responder?: string } = {};
const ready = initCrypto();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const abort = new AbortController();

function outcome(error: unknown): string {
  if (error instanceof PayloadError || error instanceof ReconnectionError) return error.reason;
  if (error instanceof TransportClosedError) return `closed:${error.by}`;
  throw error;
}

function ended(error: unknown): string {
  if (error instanceof PairingError) return `${error.reason}:${error.by}`;
  throw error;
}

/** Resolves with "open" once the transport opens, or with how it failed, or "pending" after `ms`. */
async function settle(promise: Promise<Transport>, ms: number): Promise<string> {
  const timeout = new Promise<string>((resolve) =>
    setTimeout(() => {
      resolve('pending');
    }, ms),
  );
  return Promise.race([promise.then(() => 'open', outcome), timeout]);
}

function tamperFingerprint(text: string, role: 'initiator' | 'responder', sessionId?: Uint8Array) {
  const payload = decodePayloadText(
    text,
    role === 'initiator' ? { role } : { role, sessionId: sessionId ?? new Uint8Array() },
  );
  const fingerprint = payload.fingerprint.slice();
  fingerprint[0] = (fingerprint[0] ?? 0) ^ 1;
  return { ...payload, fingerprint };
}

function syncKeys() {
  if (!identity || !peerPublicKey) throw new Error('exchange the identities first');
  return { identity, peerPublicKey, vaultId };
}

export const harness = {
  /**
   * Opens and stops the camera, as the scanning device does before it gathers: the browser then
   * sends a raw IP host candidate rather than an mDNS name (D161).
   */
  async holdCamera(): Promise<void> {
    const stream = await navigator.mediaDevices.getUserMedia({ video: true });
    for (const track of stream.getTracks()) track.stop();
  },

  /** Starts as the initiator; returns its payload text. */
  async startInitiator(): Promise<string> {
    await ready;
    drawn = pairingNonce();
    initiator = await startInitiator(
      {
        ...context,
        sessionId: crypto.getRandomValues(new Uint8Array(16)),
        commitment: drawn.commitment,
      },
      { ...options, signal: abort.signal },
    );
    const text = encodePayloadText(initiator.payload);
    Object.assign(texts, { role: 'initiator', initiator: text, responder: undefined });
    return text;
  },

  /** A new identity for a sync; returns its public key as hex, for the other page's `syncPeer`. */
  async syncIdentity(): Promise<string> {
    await ready;
    identity = generateDeviceIdentity(new Keyring());
    return hex(identity.publicKey);
  },

  /** The public key of the peer this device syncs with, as its Device record would hold it. */
  syncPeer(publicKey: string): void {
    peerPublicKey = Uint8Array.from(publicKey.match(/../g) ?? [], (b) => parseInt(b, 16));
  },

  /** Starts a sync as I (`sync-protocol.md` §4, §5); returns its reconnection payload text. */
  async startSyncInitiator(): Promise<string> {
    syncOffer = await offerLink(crypto.getRandomValues(new Uint8Array(16)), options);
    const sealed = sealReconnection(syncOffer.link, syncKeys());
    sessionPayloads.role = 'initiator';
    sessionPayloads.initiator = {
      message: sealed.message,
      fingerprint: syncOffer.link.fingerprint,
    };
    return encodeReconnectionText(sealed.bytes);
  },

  /** Opens I's text as R, gathers and returns R's sealed answer; a refusal reason otherwise. */
  async startSyncResponder(offerText: string): Promise<string> {
    let opened;
    try {
      opened = openReconnection(decodeReconnectionText(offerText), syncKeys(), {
        role: 'initiator',
      });
    } catch (error) {
      return outcome(error);
    }
    const offer = opened.reconnection;
    const answer = await answerLink(offer, options);
    transport = answer.transport;
    const sealed = sealReconnection(answer.link, syncKeys());
    sessionPayloads.role = 'responder';
    sessionPayloads.initiator = { message: opened.message, fingerprint: offer.fingerprint };
    sessionPayloads.responder = { message: sealed.message, fingerprint: answer.link.fingerprint };
    return encodeReconnectionText(sealed.bytes);
  },

  /** Opens R's text as I and connects: "open", a refusal reason, or "pending" after `ms`. */
  async acceptSync(answerText: string, ms = 20_000): Promise<string> {
    if (!syncOffer) throw new Error('start the sync first');
    let opened;
    try {
      opened = openReconnection(decodeReconnectionText(answerText), syncKeys(), {
        role: 'responder',
        sessionId: syncOffer.link.sessionId,
      });
    } catch (error) {
      return outcome(error);
    }
    const answer = opened.reconnection;
    sessionPayloads.responder = { message: opened.message, fingerprint: answer.fingerprint };
    const opening = syncOffer.accept(answer);
    transport = opening;
    return settle(opening, ms);
  },

  /**
   * Runs `Noise_KK` over the open connection (`sync-protocol.md` §5, D217); returns the handshake
   * hash as hex, or how it failed.
   */
  async syncHandshake(): Promise<string> {
    const { role, initiator, responder } = sessionPayloads;
    if (!transport || !role || !initiator || !responder) throw new Error('no connection');
    const keys = syncKeys();
    try {
      const result = await syncHandshake(await transport, {
        role,
        identity: keys.identity,
        peerPublicKey: keys.peerPublicKey,
        initiator,
        responder,
      });
      channel = result.channel;
      return hex(result.handshakeHash);
    } catch (error) {
      if (error instanceof HandshakeError) return `handshake:${error.reason}`;
      throw error;
    }
  },

  /** The SHA-256 fingerprint of the initiator's certificate, as hex. */
  fingerprint(): string {
    return Array.from(initiator?.payload.fingerprint ?? [], (b) => b.toString(16)).join('');
  },

  /** Answers an initiator's text, optionally altering its fingerprint first; returns the answer. */
  async startResponder(offerText: string, tamper = false): Promise<string> {
    const offer = tamper
      ? tamperFingerprint(offerText, 'initiator')
      : decodePayloadText(offerText, { role: 'initiator' });
    const responder = await startResponder(offer, { ...context, holdsVault: false }, options);
    transport = responder.transport;
    const text = encodePayloadText(responder.payload);
    Object.assign(texts, { role: 'responder', initiator: offerText, responder: text });
    return text;
  },

  /** Accepts the responder's answer; "open", a refusal reason, or "pending" after `ms`. */
  async accept(answerText: string, tamper = false, ms = 20_000): Promise<string> {
    if (!initiator) throw new Error('start the initiator first');
    const expected = { role: 'responder', sessionId: initiator.payload.sessionId } as const;
    const answer = tamper
      ? tamperFingerprint(answerText, 'responder', initiator.payload.sessionId)
      : decodePayloadText(answerText, expected);
    transport = initiator.accept(answer);
    texts.responder = answerText;
    return settle(transport, ms);
  },

  /** Accepts an answer for another session: the refusal reason. */
  async acceptForAnotherSession(answerText: string): Promise<string> {
    if (!initiator) throw new Error('start the initiator first');
    const answer = decodePayloadText(answerText, {
      role: 'responder',
      sessionId: initiator.payload.sessionId,
    });
    const sessionId = answer.sessionId.slice();
    sessionId[0] = (sessionId[0] ?? 0) ^ 1;
    return initiator.accept({ ...answer, sessionId }).then(() => 'open', outcome);
  },

  /** How this side's transport settles within `ms`. */
  async connected(ms = 20_000): Promise<string> {
    if (!transport) throw new Error('no connection');
    return settle(transport, ms);
  },

  /** Aborts the session's signal. */
  abort(): void {
    abort.abort();
  },

  /**
   * Runs the Noise_XX handshake over the open connection with a new identity; returns the
   * handshake hash and both public keys as hex.
   */
  async handshake(): Promise<{ hash: string; self: string; peer: string }> {
    if (!transport || !texts.role || !texts.initiator || !texts.responder) {
      throw new Error('no connection');
    }
    await ready;
    const identity = generateDeviceIdentity(new Keyring());
    const result = await pairingHandshake(await transport, {
      role: texts.role,
      identity,
      payloadInitiator: decodeBase45(texts.initiator),
      payloadResponder: decodeBase45(texts.responder),
    });
    channel = result.channel;
    return {
      hash: hex(result.handshakeHash),
      self: hex(identity.publicKey),
      peer: hex(result.peerPublicKey),
    };
  },

  /**
   * Runs the handshake, then the nonces of §6 over the Noise channel; returns the SAS to show.
   */
  async sas(): Promise<string> {
    if (!transport || !texts.role || !texts.initiator || !texts.responder) {
      throw new Error('no connection');
    }
    await ready;
    const result = await pairingHandshake(await transport, {
      role: texts.role,
      identity: generateDeviceIdentity(new Keyring()),
      payloadInitiator: decodeBase45(texts.initiator),
      payloadResponder: decodeBase45(texts.responder),
    });
    session = new PairingSession(result.channel);
    const commitment = decodePayloadText(texts.initiator, { role: 'initiator' }).commitment;
    stage = await exchangeNonces(
      session,
      texts.role === 'initiator'
        ? {
            role: 'initiator',
            handshakeHash: result.handshakeHash,
            nonce: drawn?.nonce ?? new Uint8Array(),
          }
        : {
            role: 'responder',
            handshakeHash: result.handshakeHash,
            commitment: commitment ?? new Uint8Array(),
          },
    );
    return stage.sas;
  },

  /** The user says the SAS matches: "confirmed" once both did, or how the session ended. */
  async confirmSas(): Promise<string> {
    if (!stage) throw new Error('no SAS');
    return stage.confirm().then(() => 'confirmed', ended);
  },

  /** The user says the SAS does not match. */
  async rejectSas(): Promise<void> {
    if (!stage) throw new Error('no SAS');
    await stage.reject('sas-mismatch');
  },

  /** How the session ended, as "reason:by". */
  async sessionEnded(): Promise<string> {
    if (!session) throw new Error('no session');
    return ended(await session.ended);
  },

  async channelSend(length: number, seed: number): Promise<void> {
    if (!channel) throw new Error('no channel');
    await channel.send(Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff));
  },

  async channelReceive(): Promise<{ length: number; sum: number }> {
    if (!channel) throw new Error('no channel');
    const message = await channel.receive();
    return {
      length: message.length,
      sum: message.reduce((s, b, i) => (s + b * (i + 1)) % 1_000_003, 0),
    };
  },

  async channelClose(): Promise<string> {
    if (!channel) throw new Error('no channel');
    channel.close();
    return channel.closed;
  },

  async channelClosed(): Promise<string> {
    if (!channel) throw new Error('no channel');
    return channel.closed;
  },

  async send(length: number, seed: number): Promise<void> {
    if (!transport) throw new Error('no connection');
    const message = Uint8Array.from({ length }, (_, i) => (i * 31 + seed) & 0xff);
    await (await transport).send(message);
  },

  /** The next message's length and a checksum of its bytes. */
  async receive(): Promise<{ length: number; sum: number }> {
    if (!transport) throw new Error('no connection');
    const message = await (await transport).receive();
    return {
      length: message.length,
      sum: message.reduce((s, b, i) => (s + b * (i + 1)) % 1_000_003, 0),
    };
  },

  async close(): Promise<string> {
    if (!transport) throw new Error('no connection');
    const t = await transport;
    t.close();
    return t.closed;
  },

  async closed(): Promise<string> {
    if (!transport) throw new Error('no connection');
    return (await transport).closed;
  },
};

export type Harness = typeof harness;

(window as unknown as { harness: Harness }).harness = harness;
