// The "Vault ready" screen after a creation, a restore or a pairing (overview §13.3, D198): which
// recommendations it lists, in the order of section 13.3.

import { type BlobRestore } from '@blindvault/vault';

import { type DeviceAdvice } from './devices';

/** How the vault came to this device, set by the controller until the screen is closed. */
export type Ready =
  | { readonly start: 'created' }
  | {
      readonly start: 'restored';
      readonly openedWith: 'phrase' | 'password';
      /** What step 11 did with the backup's blobs, once it ends (backup-format.md §8, D279). */
      readonly blobs?: BlobRestore;
    }
  /** Joined a pairing (§13.3, D203). */
  | { readonly start: 'paired' };

export type ReadyAdvice = 'passkey' | 'keystore' | 'check-phrase' | 'readmit' | 'pair' | 'backup';

export interface ReadyInput {
  readonly ready: Ready;
  /** `devicesOf(session).advice`. */
  readonly devices: DeviceAdvice | undefined;
  /** Whether this browser can set up passkey unlock. */
  readonly passkeys: boolean;
  /** Whether the Android app can set up the Keystore KEK: a strong biometric enrolled (D292). */
  readonly keystore?: boolean;
  /** Whether the vault can export a backup: it holds its Recovery Envelope (D179). */
  readonly exportable: boolean;
}

export function readyAdvice({
  ready,
  devices,
  passkeys,
  keystore = false,
  exportable,
}: ReadyInput): ReadyAdvice[] {
  const advice: ReadyAdvice[] = passkeys ? ['passkey'] : keystore ? ['keystore'] : [];
  if (ready.start === 'created') {
    if (exportable) advice.push('backup');
    // A vault just created is on its only device.
    advice.push('pair');
    return advice;
  }
  // A paired device holds the vault with its pairing peer: a backup is what is left (§13.3).
  if (ready.start === 'paired') {
    if (exportable) advice.push('backup');
    return advice;
  }
  if (ready.openedWith === 'password') advice.push('check-phrase');
  if (devices === 'readmit') advice.push('readmit');
  else if (devices === 'only-device') advice.push('pair');
  if (exportable) advice.push('backup');
  return advice;
}
