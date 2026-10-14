// The "Vault ready" screen after a creation or a restore (overview §13.3, D198): which
// recommendations it lists, in the order of section 13.3.

import { type DeviceAdvice } from './devices';

/** How the vault came to this device, set by the controller until the screen is closed. */
export type Ready =
  | { readonly start: 'created' }
  | { readonly start: 'restored'; readonly openedWith: 'phrase' | 'password' };

export type ReadyAdvice = 'passkey' | 'check-phrase' | 'readmit' | 'pair' | 'backup';

export interface ReadyInput {
  readonly ready: Ready;
  /** `devicesOf(session).advice`. */
  readonly devices: DeviceAdvice | undefined;
  /** Whether this browser can set up passkey unlock. */
  readonly passkeys: boolean;
  /** Whether the vault can export a backup: it holds its Recovery Envelope (D179). */
  readonly exportable: boolean;
}

export function readyAdvice({ ready, devices, passkeys, exportable }: ReadyInput): ReadyAdvice[] {
  const advice: ReadyAdvice[] = passkeys ? ['passkey'] : [];
  if (ready.start === 'created') {
    if (exportable) advice.push('backup');
    // A vault just created is on its only device.
    advice.push('pair');
    return advice;
  }
  if (ready.openedWith === 'password') advice.push('check-phrase');
  if (devices === 'readmit') advice.push('readmit');
  else if (devices === 'only-device') advice.push('pair');
  if (exportable) advice.push('backup');
  return advice;
}
