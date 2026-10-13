import { describe, expect, it, vi } from 'vitest';

import { SERVICE_WORKER_URL, onlyServiceWorker, registerServiceWorker } from './service-worker';

describe('service worker registration (D190)', () => {
  it('registers /sw.js at the root, bypassing the HTTP cache for its updates', async () => {
    const register = vi.fn(() => Promise.resolve({}));
    await registerServiceWorker({ register });
    expect(register).toHaveBeenCalledWith(SERVICE_WORKER_URL, {
      scope: '/',
      updateViaCache: 'none',
    });
    expect(SERVICE_WORKER_URL).toBe('/sw.js');
  });

  it('does nothing without service workers, and swallows a refused registration', async () => {
    await expect(registerServiceWorker(undefined)).resolves.toBeUndefined();
    const register = vi.fn(() => Promise.reject(new Error('SecurityError')));
    await expect(registerServiceWorker({ register })).resolves.toBeUndefined();
  });

  it('passes the URL through a policy that vouches for /sw.js only, where Trusted Types exist (D83)', async () => {
    const register = vi.fn(() => Promise.resolve({}));
    const createPolicy = vi.fn(
      (_name: string, rules: { createScriptURL: (input: string) => string }) => ({
        createScriptURL: (input: string) => ({ trusted: rules.createScriptURL(input) }),
      }),
    );
    await registerServiceWorker({ register }, { createPolicy });
    expect(createPolicy).toHaveBeenCalledWith('blindvault-service-worker', expect.anything());
    expect(register).toHaveBeenCalledWith({ trusted: '/sw.js' }, expect.anything());

    expect(onlyServiceWorker('/sw.js')).toBe('/sw.js');
    for (const other of ['/sw.js?x', '/assets/sw.js', 'https://outside.test/sw.js', 'data:,1']) {
      expect(() => onlyServiceWorker(other)).toThrow('not the service worker');
    }
  });
});
