// A page for the Playwright tests: one device's side of the WebRTC connection of a pairing, driven
// through `window.harness`. Two pages, in two browser contexts, pair by passing the base45 texts.

import { Keyring, generateDeviceIdentity, initCrypto } from '@blindvault/crypto';

import {
  type Initiator,
  PayloadError,
  type Role,
  type Transport,
  TransportClosedError,
  decodeBase45,
  decodePayloadText,
  encodePayloadText,
  pairingHandshake,
  startInitiator,
  startResponder,
} from '../src/index';

const context = { holdsVault: true, formatVersions: [1], recordTypes: [1, 2, 3, 4, 5, 6] };
const options = { iceServers: [] };

let initiator: Initiator | undefined;
let transport: Promise<Transport> | undefined;
let channel: Transport | undefined;
// The texts as exchanged, for the prologue: the initiator's, then the responder's.
const texts: { role?: Role; initiator?: string; responder?: string } = {};
const ready = initCrypto();
const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('');
const abort = new AbortController();

function outcome(error: unknown): string {
  if (error instanceof PayloadError) return error.reason;
  if (error instanceof TransportClosedError) return `closed:${error.by}`;
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
    initiator = await startInitiator(
      {
        ...context,
        sessionId: crypto.getRandomValues(new Uint8Array(16)),
        commitment: crypto.getRandomValues(new Uint8Array(32)),
      },
      { ...options, signal: abort.signal },
    );
    const text = encodePayloadText(initiator.payload);
    Object.assign(texts, { role: 'initiator', initiator: text, responder: undefined });
    return text;
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
