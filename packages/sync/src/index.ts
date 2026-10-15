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
export {
  FRAME_DATA_LENGTH,
  FrameError,
  FrameReader,
  MAX_PROTOCOL_MESSAGE_LENGTH,
  toFrames,
} from './frames';
export { type Direction, type MemoryPair, type MemoryPairOptions, memoryPair } from './memory';
export {
  ABORT_REASONS,
  MAX_RECORD_COUNT,
  type AbortReason,
  MESSAGE_VERSION,
  type Message,
  MessageError,
  type MessageRejection,
  type MessageType,
  decodeMessage,
  encodeMessage,
} from './messages';
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
export { type NonceExchangeOptions, type SasRejection, SasStage, exchangeNonces } from './sas';
export {
  type DevicesHeld,
  type DevicesMessage,
  type ReadmissionWrites,
  type Readmitted,
  type ReadmitOptions,
  readmissionWrites,
  readmit,
} from './readmission';
export { type LocalDescription, SdpError, buildRemoteSdp, parseLocalSdp } from './sdp';
export {
  IDLE_TIMEOUT_MS,
  PairingError,
  type PairingFailure,
  PairingSession,
  type PairingSessionOptions,
  SESSION_TIMEOUT_MS,
} from './session';
export {
  ReceivedVault,
  type ReceiveVaultOptions,
  type SendVaultOptions,
  TransferRefusal,
  receiveVault,
  sendVault,
} from './transfer';
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
