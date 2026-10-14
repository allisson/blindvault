import { describe, expect, it } from 'vitest';

import {
  NEARLY_FULL,
  StorageMonitor,
  isSafari,
  nearlyFull,
  plainTab,
  storageWarnings,
} from './storage-state';

const UA = {
  safariMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Safari/605.1.15',
  safariIPhone:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.5 Mobile/15E148 Safari/604.1',
  chromeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) CriOS/138.0.7204.156 Mobile/15E148 Safari/604.1',
  firefoxIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) FxiOS/141.0 Mobile/15E148 Safari/605.1.15',
  edgeIOS:
    'Mozilla/5.0 (iPhone; CPU iPhone OS 18_5 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 EdgiOS/138.0.3351.95 Mobile/15E148 Safari/605.1.15',
  chromeMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36',
  edgeWindows:
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Safari/537.36 Edg/138.0.0.0',
  chromeAndroid:
    'Mozilla/5.0 (Linux; Android 10; K) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/138.0.0.0 Mobile Safari/537.36',
  firefoxMac:
    'Mozilla/5.0 (Macintosh; Intel Mac OS X 10.15; rv:141.0) Gecko/20100101 Firefox/141.0',
  chromiumLinux:
    'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chromium/138.0.0.0 Safari/537.36',
};

describe('Safari detection (D55, D196)', () => {
  it('finds Safari on macOS and iOS', () => {
    expect(isSafari(UA.safariMac)).toBe(true);
    expect(isSafari(UA.safariIPhone)).toBe(true);
  });

  it('does not take another browser that names Safari for Safari', () => {
    for (const ua of [
      UA.chromeIOS,
      UA.firefoxIOS,
      UA.edgeIOS,
      UA.chromeMac,
      UA.edgeWindows,
      UA.chromeAndroid,
      UA.firefoxMac,
      UA.chromiumLinux,
      '',
    ]) {
      expect(isSafari(ua), ua).toBe(false);
    }
  });

  it('is a plain tab unless the display mode is standalone or iOS says standalone', () => {
    expect(plainTab({ standaloneDisplay: false, navigatorStandalone: undefined })).toBe(true);
    expect(plainTab({ standaloneDisplay: false, navigatorStandalone: false })).toBe(true);
    expect(plainTab({ standaloneDisplay: true, navigatorStandalone: undefined })).toBe(false);
    expect(plainTab({ standaloneDisplay: false, navigatorStandalone: true })).toBe(false);
    // Only `true` counts: a value of another type is not iOS saying so.
    expect(plainTab({ standaloneDisplay: false, navigatorStandalone: 'true' })).toBe(true);
  });
});

describe('nearly full (D196)', () => {
  it('is 80% of the quota', () => {
    expect(NEARLY_FULL).toBe(0.8);
  });

  it('starts at exactly 80% of the quota, not a byte before', () => {
    expect(nearlyFull(799, 1000)).toBe(false);
    expect(nearlyFull(800, 1000)).toBe(true);
    expect(nearlyFull(1200, 1000)).toBe(true);
  });

  it('is not claimed when the browser gives no usage or no quota', () => {
    expect(nearlyFull(null, 1000)).toBe(false);
    expect(nearlyFull(900, null)).toBe(false);
    expect(nearlyFull(0, 0)).toBe(false);
  });
});

describe('storage warnings (D196)', () => {
  const fine = {
    safariTab: false,
    persisted: true,
    onlyDevice: true,
    usage: 1,
    quota: 1000,
  } as const;

  it('warns of nothing when the storage is kept and has room', () => {
    expect(storageWarnings(fine)).toEqual([]);
  });

  it('warns of a Safari plain tab whatever else holds', () => {
    expect(storageWarnings({ ...fine, safariTab: true })).toEqual(['safari-tab']);
  });

  it('warns of storage not kept only on the only device, and only when the browser says so', () => {
    expect(storageWarnings({ ...fine, persisted: false })).toEqual(['not-kept']);
    expect(storageWarnings({ ...fine, persisted: false, onlyDevice: false })).toEqual([]);
    expect(storageWarnings({ ...fine, persisted: null })).toEqual([]);
  });

  it('warns of nearly full storage on any device', () => {
    expect(storageWarnings({ ...fine, onlyDevice: false, usage: 800 })).toEqual(['nearly-full']);
  });

  it('orders them Safari tab, not kept, nearly full', () => {
    expect(
      storageWarnings({
        safariTab: true,
        persisted: false,
        onlyDevice: true,
        usage: 900,
        quota: 1000,
      }),
    ).toEqual(['safari-tab', 'not-kept', 'nearly-full']);
  });

  it('does not warn of storage not kept while the device count is unknown', () => {
    expect(
      storageWarnings({ ...fine, persisted: false, onlyDevice: undefined, usage: 900 }),
    ).toEqual(['nearly-full']);
  });
});

/** A `StorageManager` whose answers the test sets, counting its calls. */
function fakeStorage(state: { persisted: boolean; usage: number; quota: number; grant?: boolean }) {
  const calls = { persist: 0, persisted: 0, estimate: 0 };
  const storage = {
    persist: () => {
      calls.persist += 1;
      if (state.grant) state.persisted = true;
      return Promise.resolve(state.grant ?? false);
    },
    persisted: () => {
      calls.persisted += 1;
      return Promise.resolve(state.persisted);
    },
    estimate: () => {
      calls.estimate += 1;
      return Promise.resolve({ usage: state.usage, quota: state.quota });
    },
  } as unknown as StorageManager;
  return { storage, calls };
}

describe('storage monitor (D196)', () => {
  it('knows nothing until read, then holds what the browser said', async () => {
    const { storage } = fakeStorage({ persisted: false, usage: 10, quota: 100 });
    const monitor = new StorageMonitor(storage);
    expect(monitor.getState()).toBeUndefined();
    await monitor.refresh();
    expect(monitor.getState()).toEqual({ persisted: false, usage: 10, quota: 100 });
  });

  it('tells its listeners of each read, and not after they unsubscribe', async () => {
    const { storage } = fakeStorage({ persisted: true, usage: 10, quota: 100 });
    const monitor = new StorageMonitor(storage);
    let heard = 0;
    const off = monitor.subscribe(() => {
      heard += 1;
    });
    await monitor.refresh();
    expect(heard).toBe(1);
    off();
    await monitor.refresh();
    expect(heard).toBe(1);
  });

  it('keeps the newest read when an older one answers last', async () => {
    let answer: ((v: boolean) => void) | undefined;
    let first = true;
    const storage = {
      persisted: () => {
        if (first) {
          first = false;
          return new Promise<boolean>((resolve) => {
            answer = resolve;
          });
        }
        return Promise.resolve(true);
      },
      estimate: () => Promise.resolve({ usage: 1, quota: 100 }),
    } as unknown as StorageManager;
    const monitor = new StorageMonitor(storage);
    const older = monitor.refresh();
    await monitor.refresh();
    answer?.(false);
    await older;
    expect(monitor.getState()?.persisted).toBe(true);
  });

  it('asks the browser to keep the storage only when told to, then reads again', async () => {
    const { storage, calls } = fakeStorage({
      persisted: false,
      usage: 10,
      quota: 100,
      grant: true,
    });
    const monitor = new StorageMonitor(storage);
    await monitor.refresh();
    expect(calls.persist).toBe(0);
    expect(await monitor.keep()).toBe(true);
    expect(calls.persist).toBe(1);
    expect(monitor.getState()?.persisted).toBe(true);
  });

  it('reports a refused request, and the status stays not kept', async () => {
    const { storage } = fakeStorage({ persisted: false, usage: 10, quota: 100, grant: false });
    const monitor = new StorageMonitor(storage);
    expect(await monitor.keep()).toBe(false);
    expect(monitor.getState()?.persisted).toBe(false);
  });

  it('reads unknowns from a browser with no storage manager', async () => {
    const monitor = new StorageMonitor(undefined);
    await monitor.refresh();
    expect(monitor.getState()).toEqual({ persisted: null, usage: null, quota: null });
    expect(await monitor.keep()).toBe(false);
  });
});
