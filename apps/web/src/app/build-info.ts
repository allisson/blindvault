// The running build, for the About screen (overview §11, D192): its version and the SHA-256 of its
// asset manifest. Under the service worker the manifest comes from the active cache, the bundle that
// runs. The value is informational only: a modified app can show any value.

export const MANIFEST_URL = '/asset-manifest.txt';

const LINE = /^[0-9a-f]{64} {2}\S.*$/;

function isManifest(text: string): boolean {
  if (!text.endsWith('\n')) return false;
  return text
    .slice(0, -1)
    .split('\n')
    .every((line) => LINE.test(line));
}

/** The manifest hash, or `undefined` where no manifest is served (the dev server). */
export async function readManifestHash(
  fetcher: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<string | undefined> {
  try {
    const response = await fetcher(MANIFEST_URL);
    if (!response.ok) return undefined;
    const bytes = await response.arrayBuffer();
    if (!isManifest(new TextDecoder().decode(bytes))) return undefined;
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    return Array.from(digest, (b) => b.toString(16).padStart(2, '0')).join('');
  } catch {
    return undefined;
  }
}

let running: Promise<string | undefined> | undefined;

/** Read once, at startup, so it names the bundle this window loaded. */
export function manifestHash(): Promise<string | undefined> {
  running ??= readManifestHash();
  return running;
}
