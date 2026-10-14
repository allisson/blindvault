// @blindvault/sync: Pairing, Noise handshake, WebRTC transport, sync protocol, HLC and merge.

export { Base45Error, decodeBase45, encodeBase45 } from './base45';
export { MAX_CHANNEL_MESSAGE_LENGTH, noiseChannel } from './channel';
export {
  type ConnectionOptions,
  GATHER_TIMEOUT_MS,
  type Initiator,
  type InitiatorContext,
  type PayloadContext,
  type Responder,
  startInitiator,
  startResponder,
} from './connection';
export {
  HandshakeError,
  type HandshakeFailure,
  type PairingHandshake,
  type PairingHandshakeOptions,
  pairingHandshake,
} from './handshake';
export { type Direction, type MemoryPair, type MemoryPairOptions, memoryPair } from './memory';
export {
  type Candidate,
  type CandidateKind,
  PAYLOAD_VERSION,
  type Payload,
  PayloadError,
  type PayloadExpectation,
  type PayloadRejection,
  type Role,
  type Setup,
  decodePayload,
  decodePayloadText,
  encodePayload,
  encodePayloadText,
} from './payload';
export { type LocalDescription, SdpError, buildRemoteSdp, parseLocalSdp } from './sdp';
export {
  type ClosedBy,
  MAX_MESSAGE_LENGTH,
  MessageTooLongError,
  type Transport,
  TransportClosedError,
  TransportError,
} from './transport';
export {
  type DataChannelEvent,
  type DataChannelLike,
  HIGH_WATER_MARK,
  LOW_WATER_MARK,
  dataChannelTransport,
} from './webrtc';
