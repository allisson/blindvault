// Opens the WebRTC connection of a pairing from the two payloads (`pairing-protocol.md` §3, §4):
// a fresh DTLS certificate per session, non-trickled ICE, the peer's SDP rebuilt from its payload,
// and one reliable, ordered DataChannel made by the initiator. It resolves with a `Transport`, over
// which the Noise handshake runs; DTLS is never trusted (§8.2). Browser only: the Playwright tests
// in `e2e/` cover it.

import { type Payload, PayloadError, encodePayload } from './payload';
import { buildRemoteSdp, parseLocalSdp } from './sdp';
import { type Transport, TransportClosedError } from './transport';
import { dataChannelTransport } from './webrtc';

/**
 * Gathering stops at `complete`, at the first srflx candidate, or after this long. Not a
 * measurement: on mobile data in the Phase 0 spike `complete` never came within it.
 */
export const GATHER_TIMEOUT_MS = 10_000;

/** How long a closed transport waits for its channel to close before closing the connection. */
const CLOSE_GRACE_MS = 2_000;

export interface ConnectionOptions {
  /** STUN servers; none in LAN-only mode. */
  readonly iceServers: readonly RTCIceServer[];
  /** Aborting closes the connection and rejects what is pending. */
  readonly signal?: AbortSignal;
}

/** The payload fields that do not come from the connection. */
export interface PayloadContext {
  readonly holdsVault: boolean;
  readonly formatVersions: readonly number[];
  readonly recordTypes: readonly number[];
}

export interface InitiatorContext extends PayloadContext {
  /** 16 random bytes, new for every session. */
  readonly sessionId: Uint8Array;
  readonly commitment: Uint8Array;
}

export interface Initiator {
  /** This device's payload, to show first. */
  readonly payload: Payload;
  /**
   * Connects with the responder's decoded answer; resolves once the DataChannel is open. Once
   * only: a second answer is refused (§11).
   */
  accept(answer: Payload): Promise<Transport>;
  /** Closes the connection. */
  close(): void;
}

export interface Responder {
  /** This device's answer, to show back to the initiator. */
  readonly payload: Payload;
  /** Resolves once the initiator's DataChannel is open. */
  readonly transport: Promise<Transport>;
  close(): void;
}

export async function startInitiator(
  context: InitiatorContext,
  options: ConnectionOptions,
): Promise<Initiator> {
  const peer = await openPeer(options);
  try {
    const channel = peer.connection.createDataChannel('blindvault', { ordered: true });
    await peer.connection.setLocalDescription(await peer.connection.createOffer());
    const payload: Payload = {
      role: 'initiator',
      ...(await gathered(peer)),
      sessionId: context.sessionId.slice(),
      holdsVault: context.holdsVault,
      formatVersions: [...context.formatVersions],
      recordTypes: [...context.recordTypes],
      commitment: context.commitment.slice(),
    };
    // Refuses here, not when shown, a description the payload cannot carry.
    encodePayload(payload);
    let accepted = false;
    return {
      payload,
      async accept(answer) {
        if (accepted) throw new PayloadError('wrong-session', 'an answer was already accepted');
        if (answer.role !== 'responder')
          throw new PayloadError('wrong-role', 'expected the responder');
        if (!equal(answer.sessionId, payload.sessionId)) {
          throw new PayloadError('wrong-session', 'the answer is for another session');
        }
        if (peer.isClosed()) throw new TransportClosedError('local');
        accepted = true;
        await peer.connection.setRemoteDescription(buildRemoteSdp(answer));
        return peer.open(channel);
      },
      close: peer.close,
    };
  } catch (error) {
    peer.close();
    throw error;
  }
}

export async function startResponder(
  offer: Payload,
  context: PayloadContext,
  options: ConnectionOptions,
): Promise<Responder> {
  if (offer.role !== 'initiator') throw new PayloadError('wrong-role', 'expected the initiator');
  const peer = await openPeer(options);
  try {
    const channel = new Promise<RTCDataChannel>((resolve) => {
      peer.connection.addEventListener(
        'datachannel',
        (event) => {
          resolve(event.channel);
        },
        { once: true },
      );
    });
    await peer.connection.setRemoteDescription(buildRemoteSdp(offer));
    await peer.connection.setLocalDescription(await peer.connection.createAnswer());
    const payload: Payload = {
      role: 'responder',
      ...(await gathered(peer)),
      sessionId: offer.sessionId.slice(),
      holdsVault: context.holdsVault,
      formatVersions: [...context.formatVersions],
      recordTypes: [...context.recordTypes],
      commitment: null,
    };
    encodePayload(payload);
    const transport = peer.failed(channel).then((c) => peer.open(c));
    // The caller may never await it (an abandoned session); its rejection is not unhandled.
    transport.catch(() => undefined);
    return { payload, transport, close: peer.close };
  } catch (error) {
    peer.close();
    throw error;
  }
}

interface Peer {
  readonly connection: RTCPeerConnection;
  /** Rejects when the connection fails, closes or is aborted, whichever comes first. */
  failed<T>(promise: Promise<T>): Promise<T>;
  /** Waits for the channel to open and wraps it; closing the transport closes the connection. */
  open(channel: RTCDataChannel): Promise<Transport>;
  isClosed(): boolean;
  readonly close: () => void;
}

async function openPeer({ iceServers, signal }: ConnectionOptions): Promise<Peer> {
  signal?.throwIfAborted();
  // A new certificate for every session (§11), not one the browser might reuse.
  const algorithm: EcKeyGenParams = { name: 'ECDSA', namedCurve: 'P-256' };
  const certificate = await RTCPeerConnection.generateCertificate(algorithm);
  signal?.throwIfAborted();
  const connection = new RTCPeerConnection({
    iceServers: [...iceServers],
    certificates: [certificate],
  });

  let closed = false;
  const failures = new Set<(error: Error) => void>();
  const fail = (error: Error) => {
    for (const reject of failures) reject(error);
    failures.clear();
  };
  const close = () => {
    if (closed) return;
    closed = true;
    signal?.removeEventListener('abort', onAbort);
    connection.close();
    fail(new TransportClosedError('local'));
  };
  const onAbort = () => {
    close();
  };
  signal?.addEventListener('abort', onAbort);
  connection.addEventListener('connectionstatechange', () => {
    if (connection.connectionState === 'failed') fail(new TransportClosedError('error'));
  });

  const failed = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      if (closed) {
        reject(new TransportClosedError('local'));
        return;
      }
      failures.add(reject);
      promise.then(resolve, reject).finally(() => failures.delete(reject));
    });

  const open = async (channel: RTCDataChannel) => {
    if (channel.readyState === 'closing' || channel.readyState === 'closed') {
      throw new TransportClosedError('remote');
    }
    if (channel.readyState !== 'open') {
      await failed(
        new Promise<void>((resolve, reject) => {
          channel.addEventListener(
            'open',
            () => {
              resolve();
            },
            { once: true },
          );
          channel.addEventListener(
            'close',
            () => {
              reject(new TransportClosedError('remote'));
            },
            { once: true },
          );
        }),
      );
    }
    const transport = dataChannelTransport(channel);
    // Closing the connection at once would cut the channel's own close short, and Firefox and
    // WebKit would report it to the peer as an error: wait for it, a bounded time.
    void transport.closed.then(() => {
      if (channel.readyState === 'closed') {
        close();
        return;
      }
      channel.addEventListener('close', close, { once: true });
      setTimeout(close, CLOSE_GRACE_MS);
    });
    return transport;
  };

  return { connection, failed, open, isClosed: () => closed, close };
}

/** Waits for gathering to stop (see `GATHER_TIMEOUT_MS`), then reads the local description. */
async function gathered(peer: Peer): Promise<ReturnType<typeof parseLocalSdp>> {
  const { connection } = peer;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let onCandidate: ((event: RTCPeerConnectionIceEvent) => void) | undefined;
  let onState: (() => void) | undefined;
  try {
    await peer.failed(
      new Promise<void>((resolve) => {
        if (connection.iceGatheringState === 'complete') {
          resolve();
          return;
        }
        onState = () => {
          if (connection.iceGatheringState === 'complete') resolve();
        };
        onCandidate = (event) => {
          if (event.candidate === null || / typ srflx( |$)/.test(event.candidate.candidate)) {
            resolve();
          }
        };
        connection.addEventListener('icegatheringstatechange', onState);
        connection.addEventListener('icecandidate', onCandidate);
        timer = setTimeout(resolve, GATHER_TIMEOUT_MS);
      }),
    );
  } finally {
    clearTimeout(timer);
    if (onState) connection.removeEventListener('icegatheringstatechange', onState);
    if (onCandidate) connection.removeEventListener('icecandidate', onCandidate);
  }
  const sdp = connection.localDescription?.sdp;
  if (!sdp) throw new TransportClosedError('error');
  return parseLocalSdp(sdp);
}

function equal(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((value, k) => value === b[k]);
}
