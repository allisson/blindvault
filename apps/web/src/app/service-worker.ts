// Registers the service worker (overview §11, D190): `/sw.js` at the root, with its updates fetched
// past the HTTP cache. The production build calls it; the dev server does not. Under Trusted Types
// the URL goes through a policy that vouches for `/sw.js` only (D83).

export const SERVICE_WORKER_URL = '/sw.js';

interface Container {
  register(url: string, options: RegistrationOptions): Promise<unknown>;
}

interface ScriptUrlPolicy {
  createScriptURL(input: string): unknown;
}

interface TrustedTypes {
  createPolicy(
    name: string,
    rules: { createScriptURL: (input: string) => string },
  ): ScriptUrlPolicy;
}

/** The policy's rule: only the service worker's URL becomes a script URL. */
export function onlyServiceWorker(input: string): string {
  if (input !== SERVICE_WORKER_URL) throw new TypeError('not the service worker');
  return input;
}

export async function registerServiceWorker(
  container: Container | undefined,
  trustedTypes?: TrustedTypes,
): Promise<void> {
  if (!container) return;
  const url = trustedTypes
    ? // register() takes a TrustedScriptURL where the DOM types say string.
      (trustedTypes
        .createPolicy('blindvault-service-worker', { createScriptURL: onlyServiceWorker })
        .createScriptURL(SERVICE_WORKER_URL) as string)
    : SERVICE_WORKER_URL;
  try {
    await container.register(url, { scope: '/', updateViaCache: 'none' });
  } catch {
    // Without a service worker the app still runs, from the network (D190).
  }
}
