// The Android app's platform (android.md §2, D290): the app runs in a WebView of the shell, which it
// reaches over the bridge (§9). No service worker and no update prompt (§10, D282); the locks follow
// the activity and the screen (§4.2); the clipboard and its clear are the shell's (§6.1); a file is
// saved through the shell, in chunks (§6.2); the Keystore KEK's key is the shell's (§5). The bridge is looked up on first use, so importing this
// module needs no shell.

// A type only: `app/clipboard` reads the platform when it loads.
import type { ClipboardPort } from '../app/clipboard';
import { KEYSTORE_SECRET_LENGTH } from '@blindvault/crypto';
import { KEYSTORE_IV_LENGTH, KEYSTORE_SEALED_LENGTH } from '@blindvault/vault';
import {
  KeystoreCancelledError,
  KeystoreInvalidatedError,
  type KeystorePort,
  KeystoreUnavailableError,
} from '../app/keystore';
import { fromBase64url, toBase64url } from '../extension/passkey-options';
import {
  type ShellAnswer,
  type ShellBridge,
  ShellRefusedError,
  androidShell,
  shellBridge,
} from './android-bridge';
import { type FilePort, type LockSignals, type Platform } from './platform';
import { pageLockSignals } from './web';

/** The most bytes one `file-chunk` carries, before base64. */
export const FILE_CHUNK_BYTES = 1024 * 1024;

type Bridge = () => ShellBridge | undefined;

function needed(bridge: Bridge): ShellBridge {
  const b = bridge();
  if (!b) throw new Error('No Android shell');
  return b;
}

/**
 * Hidden from the shell's `hidden` (`onStop`) to its `shown` (`onStart`); the operating system's lock
 * is the screen turning off; activity is input in the window. On first use the window sends
 * `lifecycle-watch` (D293); until the shell answers, the window that just started is shown.
 */
export function androidLockSignals(
  bridge: Bridge,
  page: Pick<LockSignals, 'onActivity'>,
): LockSignals {
  let hidden = false;
  let watching = false;
  const hiddenListeners = new Set<(hidden: boolean) => void>();
  const systemListeners = new Set<() => void>();
  const shownOrHidden = (next: boolean): void => {
    if (next === hidden) return;
    hidden = next;
    for (const l of hiddenListeners) l(next);
  };
  const watch = (): void => {
    const b = bridge();
    if (watching || !b) return;
    watching = true;
    b.onLifecycle((state) => {
      if (state === 'screen-off') {
        for (const l of systemListeners) l();
        return;
      }
      shownOrHidden(state === 'hidden');
    });
    // The shell reaches the window only once the window has written to it (D293): this first
    // message opens the way for every `lifecycle`, and its answer is the state now.
    b.request('lifecycle-watch').then(
      (answer) => {
        const keys = Object.keys(answer).filter((k) => k !== 'v' && k !== 'id' && k !== 'ok');
        if (keys.length !== 1 || (answer.state !== 'hidden' && answer.state !== 'shown')) return;
        shownOrHidden(answer.state === 'hidden');
      },
      () => undefined,
    );
  };
  return {
    hidden: () => {
      watch();
      return hidden;
    },
    onHidden: (listener) => {
      watch();
      hiddenListeners.add(listener);
      return () => {
        hiddenListeners.delete(listener);
      };
    },
    onActivity: (listener) => page.onActivity(listener),
    onSystemLock: (listener) => {
      watch();
      systemListeners.add(listener);
      return () => {
        systemListeners.delete(listener);
      };
    },
  };
}

/**
 * `clipboard-copy` with the clear's time, which the shell keeps, so the clear needs no focus; `''` is
 * `clipboard-clear`, sent at the guard's own clear and on lock.
 */
export function androidClipboard(bridge: Bridge): ClipboardPort {
  return {
    write: async (text, clearSeconds) => {
      if (text === '') {
        await needed(bridge).request('clipboard-clear');
        return;
      }
      if (clearSeconds === undefined) throw new RangeError('A copy needs its clear time');
      await needed(bridge).request('clipboard-copy', { text, clearSeconds });
    },
    hasFocus: () => true,
    onFocus: () => () => undefined,
  };
}

function base64(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(binary);
}

/** `file-save`, the chunks in order, `file-end`; a lock sends `file-abort` and stops the chunks. */
export function androidFiles(bridge: Bridge): FilePort {
  let current: { aborted: boolean } | undefined;
  return {
    save: async (file, name) => {
      const b = needed(bridge);
      if (current) return 'cancelled';
      const save = { aborted: false };
      current = save;
      try {
        try {
          await b.request('file-save', {
            name,
            mediaType: file.type === '' ? 'application/octet-stream' : file.type,
          });
        } catch (error) {
          if (error instanceof ShellRefusedError && error.error === 'cancelled') return 'cancelled';
          throw error;
        }
        // Read through a call: a lock sets it while this save awaits.
        const aborted = (): boolean => save.aborted;
        for (let offset = 0; offset < file.size; offset += FILE_CHUNK_BYTES) {
          const chunk = new Uint8Array(
            await file.slice(offset, offset + FILE_CHUNK_BYTES).arrayBuffer(),
          );
          if (aborted()) return 'cancelled';
          await b.request('file-chunk', { data: base64(chunk) });
        }
        if (aborted()) return 'cancelled';
        await b.request('file-end');
        return 'saved';
      } finally {
        if (current === save) current = undefined;
      }
    },
    lock: () => {
      if (!current) return;
      current.aborted = true;
      current = undefined;
      // The shell deletes the partial document; there is nothing to wait for.
      bridge()
        ?.request('file-abort')
        .catch(() => undefined);
    },
  };
}

class MalformedAnswerError extends Error {
  override name = 'MalformedAnswerError';
  constructor(type: string) {
    super(`The shell sent a malformed answer to ${type}`);
  }
}

/** The answer's fields beyond `v`, `id` and `ok`, refused unless exactly `required` and `optional`. */
function fieldsOf(
  type: string,
  answer: ShellAnswer,
  required: readonly string[],
  optional: readonly string[] = [],
): Readonly<Record<string, unknown>> {
  const keys = Object.keys(answer).filter((k) => k !== 'v' && k !== 'id' && k !== 'ok');
  const known = keys.every((k) => required.includes(k) || optional.includes(k));
  if (!known || !required.every((k) => keys.includes(k))) throw new MalformedAnswerError(type);
  return answer;
}

function bytesOf(type: string, value: unknown, length: number): Uint8Array {
  const bytes = typeof value === 'string' ? fromBase64url(value) : undefined;
  if (bytes?.length !== length) throw new MalformedAnswerError(type);
  return bytes;
}

function booleanOf(type: string, value: unknown): boolean {
  if (typeof value !== 'boolean') throw new MalformedAnswerError(type);
  return value;
}

/**
 * `keystore-status`, `-seal`, `-open` and `-delete`, each naming the key by `localConfigId` (D292).
 * Every answer is checked key by key and length by length; a refusal the user or the device caused
 * becomes its own error.
 */
export function androidKeystore(bridge: Bridge): KeystorePort {
  const call = async (
    type: string,
    localConfigId: Uint8Array,
    fields: Readonly<Record<string, string>> = {},
  ): Promise<ShellAnswer> => {
    const b = needed(bridge);
    try {
      return await b.request(type, { localConfigId: toBase64url(localConfigId), ...fields });
    } catch (error) {
      if (error instanceof ShellRefusedError) {
        if (error.error === 'cancelled') throw new KeystoreCancelledError();
        if (error.error === 'invalidated') throw new KeystoreInvalidatedError();
        if (error.error === 'unavailable') throw new KeystoreUnavailableError();
      }
      throw error;
    }
  };
  return {
    status: async (localConfigId) => {
      const type = 'keystore-status';
      const f = fieldsOf(type, await call(type, localConfigId), ['available'], ['strongBox']);
      return {
        available: booleanOf(type, f.available),
        ...('strongBox' in f ? { strongBox: booleanOf(type, f.strongBox) } : {}),
      };
    },
    seal: async (localConfigId, secret) => {
      const type = 'keystore-seal';
      const answer = await call(type, localConfigId, { secret: toBase64url(secret) });
      const f = fieldsOf(type, answer, ['iv', 'sealed', 'strongBox']);
      return {
        iv: bytesOf(type, f.iv, KEYSTORE_IV_LENGTH),
        sealed: bytesOf(type, f.sealed, KEYSTORE_SEALED_LENGTH),
        strongBox: booleanOf(type, f.strongBox),
      };
    },
    open: async (localConfigId, iv, sealed) => {
      const type = 'keystore-open';
      const answer = await call(type, localConfigId, {
        iv: toBase64url(iv),
        sealed: toBase64url(sealed),
      });
      return bytesOf(type, fieldsOf(type, answer, ['secret']).secret, KEYSTORE_SECRET_LENGTH);
    },
    delete: async (localConfigId) => {
      const type = 'keystore-delete';
      fieldsOf(type, await call(type, localConfigId), []);
    },
  };
}

let bridge: ShellBridge | undefined;

/** The shell's bridge, made once, on first use. */
function shell(): ShellBridge | undefined {
  if (!bridge) {
    const object = androidShell();
    if (object) bridge = shellBridge(object);
  }
  return bridge;
}

export const androidPlatform: Platform = {
  kind: 'android',
  clipboard: androidClipboard(shell),
  lockSignals: androidLockSignals(shell, pageLockSignals),
  files: androidFiles(shell),
  keystore: androidKeystore(shell),
  startUpdates: () => undefined,
};
