// The confirmation window's side of the passkey messages (extension.md §7.4, §7.7, D289). The window
// holds no key: it shows what the session host answers and sends the user's choice. Answers are
// checked as strictly as requests, and one that does not fit is treated as none.

import { type Fields, type PopupRuntime, ask, refused } from './popup-client';
import { type ConfirmChoice, type ConfirmState, type Refusal } from './rpc';

const optional = (value: unknown) => value === undefined || typeof value === 'string';

function origins(s: Fields): boolean {
  return typeof s.origin === 'string' && optional(s.topOrigin) && typeof s.rpId === 'string';
}

function listOf(value: unknown, keys: readonly string[], optionalKey: string): boolean {
  return (
    Array.isArray(value) &&
    value.every(
      (entry: unknown) =>
        typeof entry === 'object' &&
        entry !== null &&
        keys.every((k) => typeof (entry as Fields)[k] === 'string') &&
        optional((entry as Fields)[optionalKey]),
    )
  );
}

function confirmState(value: unknown): value is ConfirmState {
  if (typeof value !== 'object' || value === null) return false;
  const s = value as Fields;
  switch (s.kind) {
    case 'locked':
      return true;
    case 'get':
      return origins(s) && listOf(s.passkeys, ['credentialId', 'title'], 'userName');
    case 'create':
      return (
        origins(s) &&
        typeof s.rpName === 'string' &&
        typeof s.userName === 'string' &&
        typeof s.displayName === 'string' &&
        typeof s.replaces === 'boolean' &&
        listOf(s.items, ['itemId', 'title'], 'username')
      );
    default:
      return false;
  }
}

/** What the window with `token` shows, or why it cannot (`not-found`: the request ended). */
export async function confirmDetails(
  runtime: PopupRuntime,
  token: string,
): Promise<ConfirmState | Refusal | undefined> {
  const a = await ask(runtime, { type: 'confirm-details', token });
  if (!a) return undefined;
  if (a.ok === true && confirmState(a.state)) return a.state;
  return refused(a);
}

/** Sends the user's choice: `true` once the session host took it. */
export async function confirmChoice(
  runtime: PopupRuntime,
  token: string,
  choice: ConfirmChoice,
): Promise<true | Refusal | undefined> {
  const a = await ask(runtime, { type: 'confirm-choice', token, ...choice });
  if (!a) return undefined;
  if (a.ok === true) return true;
  return refused(a);
}
