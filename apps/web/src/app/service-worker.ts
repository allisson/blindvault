// Registers the service worker (overview §11, D190, D191): `/sw.js` at the root, with its updates
// fetched past the HTTP cache, as soon as the app starts, so the update monitor watches it early. The
// production build calls it; the dev server does not. Under Trusted Types the URL goes through a
// policy that vouches for `/sw.js` only (D83).

export const SERVICE_WORKER_URL = '/sw.js';

interface Container<R> {
  register(url: string, options: RegistrationOptions): Promise<R>;
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

/** The registration, or `undefined` where there is none. */
export async function registerServiceWorker<R>(
  container: Container<R> | undefined,
  trustedTypes?: TrustedTypes,
): Promise<R | undefined> {
  if (!container) return undefined;
  const url = trustedTypes
    ? // register() takes a TrustedScriptURL where the DOM types say string.
      (trustedTypes
        .createPolicy('blindvault-service-worker', { createScriptURL: onlyServiceWorker })
        .createScriptURL(SERVICE_WORKER_URL) as string)
    : SERVICE_WORKER_URL;
  try {
    return await container.register(url, { scope: '/', updateViaCache: 'none' });
  } catch {
    // Without a service worker the app still runs, from the network (D190).
    return undefined;
  }
}
