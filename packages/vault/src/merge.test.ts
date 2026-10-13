import { RECORD_FORMAT_VERSION, type RecordHeader, RecordType } from '@blindvault/crypto';
import { describe, expect, it } from 'vitest';

import { incomingDeviceWins, incomingWins, sameVersion } from './merge';

function at(physicalMs: number, device = 1, recordFormatVersion = RECORD_FORMAT_VERSION) {
  const header: RecordHeader = {
    recordFormatVersion,
    recordType: RecordType.item,
    recordId: new Uint8Array(16),
    keyEpoch: 1,
    hlc: { physicalMs, counter: 0, deviceId: new Uint8Array(16).fill(device) },
    deleted: false,
  };
  return header;
}

describe('last-write-wins (sync-protocol.md §1.2, D19, D38)', () => {
  it('takes the greater hlc, the deviceId breaking a tie of time and counter', () => {
    expect(incomingWins(at(1), at(2))).toBe(true);
    expect(incomingWins(at(2), at(1))).toBe(false);
    expect(incomingWins(at(1, 1), at(1, 2))).toBe(true);
    expect(incomingWins(at(1, 2), at(1, 1))).toBe(false);
  });

  it('takes the higher recordFormatVersion for the same hlc, and keeps the local copy otherwise', () => {
    expect(incomingWins(at(1, 1, 1), at(1, 1, 2))).toBe(true);
    expect(incomingWins(at(1, 1, 2), at(1, 1, 1))).toBe(false);
    expect(incomingWins(at(1), at(1))).toBe(false);
    expect(sameVersion(at(1), at(1))).toBe(true);
    expect(sameVersion(at(1, 1, 1), at(1, 1, 2))).toBe(false);
    expect(sameVersion(at(1), at(2))).toBe(false);
  });

  it('lets a retired Device record win whatever the HLCs, and never lose to a non-retired one (D31)', () => {
    const retired = (h: RecordHeader) => ({ header: h, retired: true });
    const live = (h: RecordHeader) => ({ header: h, retired: false });
    expect(incomingDeviceWins(live(at(5)), retired(at(1)))).toBe(true);
    expect(incomingDeviceWins(retired(at(1)), live(at(5)))).toBe(false);
    expect(incomingDeviceWins(live(at(1)), live(at(5)))).toBe(true);
    expect(incomingDeviceWins(retired(at(5)), retired(at(1)))).toBe(false);
  });
});
