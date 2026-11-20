// Measure 6 (D281): the popup copies a fake secret and asks the session host to clear the clipboard
// 10 seconds later, since the popup closes as soon as it loses focus.

import { browserName } from './common';

declare const chrome: any;

document.getElementById('copy-secret')?.addEventListener('click', () => {
  const secret = `spike-secret-${crypto.randomUUID().slice(0, 8)}`;
  void navigator.clipboard.writeText(secret).then(
    async () => {
      localStorage.setItem('clipboard-copied', JSON.stringify({ at: Date.now(), ok: true }));
      const kind = browserName() === 'chrome' ? 'offscreen' : 'background';
      if (kind === 'offscreen') await chrome.runtime.sendMessage({ to: 'bg', op: 'ensure-offscreen' });
      void chrome.runtime.sendMessage({ to: `host:${kind}`, op: 'clipboard-clear', delayMs: 10_000 });
      document.querySelector('#status')!.textContent = 'Copied. Close the popup; the host clears it in 10 s.';
    },
    (e: unknown) => {
      localStorage.setItem('clipboard-copied', JSON.stringify({ at: Date.now(), ok: false, error: String(e) }));
      document.querySelector('#status')!.textContent = `Copy failed: ${String(e)}`;
    },
  );
});
