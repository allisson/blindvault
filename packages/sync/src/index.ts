// @blindvault/sync: Pairing, Noise handshake, WebRTC transport, sync protocol, HLC and merge.

export { Base45Error, decodeBase45, encodeBase45 } from './base45';
export { MAX_CHANNEL_MESSAGE_LENGTH, noiseChannel } from './channel';
export {
  type ConnectionOptions,
  GATHER_TIMEOUT_MS,
  type Initiator,
  type InitiatorContext,
  type LinkAnswer,
  type LinkOffer,
  type PayloadContext,
  type Responder,
  answerLink,
  offerLink,
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
export { type LinkFields } from './link-fields';
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
export {
  DeliveryClosedError,
  type DeliveryDirection,
  type ManualDelivery,
  type MemoryDeliveryOptions,
  type MemoryDeliveryPair,
  type PayloadDelivery,
  manualDelivery,
  memoryDelivery,
  receiveReconnection,
} from './delivery';
export {
  MAX_RECONNECTION_MESSAGE_LENGTH,
  MIN_RECONNECTION_MESSAGE_LENGTH,
  RECONNECTION_VERSION,
  type Reconnection,
  ReconnectionError,
  type ReconnectionKeys,
  type ReconnectionRejection,
  type SealedReconnection,
  decodeReconnectionText,
  encodeReconnectionText,
  openReconnection,
  sealReconnection,
} from './reconnect';
export {
  MAX_SUMMARY_ENTRIES,
  SYNC_ABORT_REASONS,
  type SummaryEntry,
  type SyncAbortReason,
  type SyncMessage,
  type SyncMessageType,
  decodeSyncMessage,
  encodeSyncMessage,
} from './sync-messages';
export { SyncError, SyncSession, type SyncSessionFailure } from './sync-session';
export { type ExchangeOptions, SyncRefusal, exchange, selectRecords } from './exchange';
export { SessionError } from './channel-session';
export {
  type SessionPayload,
  type SyncHandshake,
  type SyncHandshakeOptions,
  syncHandshake,
} from './sync-handshake';
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
