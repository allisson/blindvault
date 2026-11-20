// Result panel shared by the spike pages: results are kept in storage.local, so a browser restart
// (measure 5) or an extension reload (measure 6) keeps them, and copied as one JSON.

declare const chrome: any;

export const ext = chrome;

export function browserName(): 'chrome' | 'firefox' {
  return chrome.runtime.getURL('').startsWith('moz-extension:') ? 'firefox' : 'chrome';
}

export function environment(): Record<string, unknown> {
  return {
    browser: browserName(),
    userAgent: navigator.userAgent,
    extensionOrigin: location.origin,
    version: chrome.runtime.getManifest().version,
    at: new Date().toISOString(),
  };
}

export async function record(key: string, value: unknown): Promise<void> {
  const { results = {} } = await chrome.storage.local.get('results');
  results[key] = value;
  await chrome.storage.local.set({ results });
  await render();
}

export async function render(): Promise<void> {
  const el = document.querySelector<HTMLPreElement>('#results');
  if (!el) return;
  const { results = {} } = await chrome.storage.local.get('results');
  el.textContent = JSON.stringify({ environment: environment(), results }, null, 2);
}

export function button(id: string, fn: () => Promise<void>): void {
  const el = document.getElementById(id) as HTMLButtonElement | null;
  if (!el) return;
  el.addEventListener('click', () => {
    el.disabled = true;
    fn()
      .catch((e) => record(`error:${id}`, String(e)))
      .finally(() => {
        el.disabled = false;
      });
  });
}

export function setupResults(): void {
  button('copy', async () => {
    await render();
    await navigator.clipboard.writeText(document.querySelector('#results')?.textContent ?? '');
  });
  button('reset', async () => {
    await chrome.storage.local.remove('results');
    await render();
  });
  void render();
}

export function errorOf(e: unknown): { name: string; message: string } {
  return e instanceof Error ? { name: e.name, message: e.message } : { name: 'Error', message: String(e) };
}

export async function send(msg: Record<string, unknown>): Promise<any> {
  return chrome.runtime.sendMessage(msg);
}
