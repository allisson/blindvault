import { RECORD_FORMAT_VERSION, RecordType } from '@blindvault/crypto';
import {
  HandshakeError,
  PairingError,
  TransferRefusal,
  TransportClosedError,
} from '@blindvault/sync';
import {
  JoinRejectedError,
  PairingRefusedError,
  UnlockRejectedError,
  VaultLockedError,
} from '@blindvault/vault';
import { describe, expect, it } from 'vitest';

import {
  FORMAT_VERSIONS,
  RECORD_TYPES,
  STUN_SERVERS,
  endingOf,
  iceServers,
  refusal,
  supportsOurs,
} from './pairing';

describe('the pairing as the app runs it (pairing-protocol.md, D203)', () => {
  it('maps each vault error to the abort reason of §10.3', () => {
    const reason = (error: unknown) => {
      const mapped = refusal(error);
      if (!(mapped instanceof TransferRefusal)) throw new Error('not a refusal');
      expect(mapped.cause).toBe(error);
      return mapped.reason;
    };
    for (const r of [
      'unsupported-format',
      'verification-failed',
      'retired-peer',
      'protocol-error',
    ] as const) {
      expect(reason(new JoinRejectedError(r))).toBe(r);
    }
    expect(reason(new VaultLockedError())).toBe('locked');
    expect(reason(new PairingRefusedError('corrupt-record'))).toBe('verification-failed');
    for (const r of ['read-only', 'retired', 'known-device'] as const) {
      expect(reason(new PairingRefusedError(r))).toBe('protocol-error');
    }
    // Anything else is left as it is: the transfer aborts with protocol-error.
    const other = new UnlockRejectedError();
    expect(refusal(other)).toBe(other);
  });

  it('says why a session ended, and who ended it', () => {
    expect(endingOf(new PairingError('sas-mismatch', 'remote'))).toEqual({
      reason: 'sas-mismatch',
      by: 'remote',
    });
    expect(endingOf(new HandshakeError('closed'))).toEqual({ reason: 'closed', by: 'remote' });
    expect(endingOf(new HandshakeError('invalid'))).toEqual({
      reason: 'protocol-error',
      by: 'local',
    });
    expect(endingOf(new HandshakeError('same-identity'))).toEqual({
      reason: 'protocol-error',
      by: 'local',
    });
    expect(endingOf(new TransportClosedError('error'))).toEqual({ reason: 'closed', by: 'remote' });
    expect(endingOf(new Error('anything'))).toEqual({ reason: 'protocol-error', by: 'local' });
  });

  it('lists the formats and types this version supports, ascending (D122)', () => {
    expect(FORMAT_VERSIONS).toEqual([RECORD_FORMAT_VERSION]);
    expect(RECORD_TYPES).toEqual([1, 2, 3, 4, 5, 6]);
    expect(RECORD_TYPES).toEqual(Object.values(RecordType).sort((a, b) => a - b));
  });

  it('refuses a joining device that lacks a format or type this version supports (D122, D203)', () => {
    const ours = { formatVersions: FORMAT_VERSIONS, recordTypes: RECORD_TYPES };
    expect(supportsOurs(ours)).toBe(true);
    expect(supportsOurs({ formatVersions: [1, 2], recordTypes: [1, 2, 3, 4, 5, 6, 7] })).toBe(true);
    expect(supportsOurs({ ...ours, formatVersions: [2] })).toBe(false);
    expect(supportsOurs({ ...ours, recordTypes: [1, 2, 3, 4, 5] })).toBe(false);
  });

  it('uses no STUN server on the same network only, and the defaults otherwise (§9.2, D203)', () => {
    expect(iceServers(true)).toEqual([]);
    expect(iceServers(false)).toEqual(STUN_SERVERS);
    expect(STUN_SERVERS.map((s) => s.urls)).toEqual([
      'stun:stun.l.google.com:19302',
      'stun:stun.cloudflare.com:3478',
    ]);
  });

  it('uses the stored STUN list, and none when it cannot be read or on the same network (D209)', () => {
    const custom = {
      kind: 'custom',
      urls: ['stun:a.example.org', 'stun:[2001:db8::1]:3478'],
    } as const;
    expect(iceServers(false, custom)).toEqual([
      { urls: 'stun:a.example.org' },
      { urls: 'stun:[2001:db8::1]:3478' },
    ]);
    expect(iceServers(true, custom)).toEqual([]);
    expect(iceServers(false, { kind: 'default' })).toEqual(STUN_SERVERS);
    expect(iceServers(false, { kind: 'unreadable' })).toEqual([]);
    expect(iceServers(true, { kind: 'unreadable' })).toEqual([]);
  });
});
