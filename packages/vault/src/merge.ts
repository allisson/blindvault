// Merge rules (sync-protocol.md §1, D182): which of two copies of one record wins. Pure decisions
// on verified headers, applied by the vault session to a backup merge and, from Phase 5, to sync.

import { type RecordHeader } from '@blindvault/crypto';

import { compareHlc } from './hlc';

/** Whether two copies have the same `hlc` and `recordFormatVersion`: the same record (§9.2). */
export function sameVersion(local: RecordHeader, incoming: RecordHeader): boolean {
  return (
    compareHlc(local.hlc, incoming.hlc) === 0 &&
    local.recordFormatVersion === incoming.recordFormatVersion
  );
}

/**
 * Last-write-wins (sync-protocol.md §1.2, D19, D38): the greater `hlc`, then the higher
 * `recordFormatVersion`; with both equal the local copy stays.
 */
export function incomingWins(local: RecordHeader, incoming: RecordHeader): boolean {
  const order = compareHlc(incoming.hlc, local.hlc);
  if (order !== 0) return order > 0;
  return incoming.recordFormatVersion > local.recordFormatVersion;
}

/** A Device record: a retired copy beats a non-retired one whatever the HLCs (D31). */
export function incomingDeviceWins(
  local: { readonly header: RecordHeader; readonly retired: boolean },
  incoming: { readonly header: RecordHeader; readonly retired: boolean },
): boolean {
  if (local.retired !== incoming.retired) return incoming.retired;
  return incomingWins(local.header, incoming.header);
}
