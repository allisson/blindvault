// A page for the Playwright tests: one device's side of the WebRTC connection of a pairing, driven
// through `window.harness`. Two pages, in two browser contexts, pair by passing the base45 texts.

import {
  type Initiator,
  PayloadError,
  type Transport,
  TransportClosedError,
  decodePayloadText,
  encodePayloadText,
  startInitiator,
  startResponder,
} from '../src/index';

const context = { holdsVault: true, formatVersions: [1], recordTypes: [1, 2, 3, 4, 5, 6] };
const options = { iceServers: [] };

let initiator: Initiator | undefined;
let transport: Promise<Transport> | undefined;
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
    return encodePayloadText(initiator.payload);
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
    return encodePayloadText(responder.payload);
  },

  /** Accepts the responder's answer; "open", a refusal reason, or "pending" after `ms`. */
  async accept(answerText: string, tamper = false, ms = 20_000): Promise<string> {
    if (!initiator) throw new Error('start the initiator first');
    const expected = { role: 'responder', sessionId: initiator.payload.sessionId } as const;
    const answer = tamper
      ? tamperFingerprint(answerText, 'responder', initiator.payload.sessionId)
      : decodePayloadText(answerText, expected);
    transport = initiator.accept(answer);
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
