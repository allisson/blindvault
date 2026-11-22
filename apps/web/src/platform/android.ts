// The Android app's platform (android.md §2, D290): the app runs in a WebView of the shell, which it
// reaches over the bridge (§9). No service worker and no update prompt (§10, D282); the locks follow
// the activity and the screen (§4.2); the clipboard and its clear are the shell's (§6.1); a file is
// saved through the shell, in chunks (§6.2). The bridge is looked up on first use, so importing this
// module needs no shell.

// A type only: `app/clipboard` reads the platform when it loads.
import type { ClipboardPort } from '../app/clipboard';
import { type ShellBridge, ShellRefusedError, androidShell, shellBridge } from './android-bridge';
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
 * is the screen turning off; activity is input in the window. Until the shell says otherwise, the
 * window that just started is shown.
 */
export function androidLockSignals(
  bridge: Bridge,
  page: Pick<LockSignals, 'onActivity'>,
): LockSignals {
  let hidden = false;
  let watching = false;
  const hiddenListeners = new Set<(hidden: boolean) => void>();
  const systemListeners = new Set<() => void>();
  const watch = (): void => {
    const b = bridge();
    if (watching || !b) return;
    watching = true;
    b.onLifecycle((state) => {
      if (state === 'screen-off') {
        for (const l of systemListeners) l();
        return;
      }
      const next = state === 'hidden';
      if (next === hidden) return;
      hidden = next;
      for (const l of hiddenListeners) l(next);
    });
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
  startUpdates: () => undefined,
};
