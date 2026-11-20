// Chrome's MV3 service worker: interception (measures 3 and 4) and the offscreen document that
// hosts the session (measure 1). It holds no key itself.

import { onMessage } from './webauthn';

declare const chrome: any;

async function ensureOffscreen(): Promise<{ created: boolean }> {
  const url = chrome.runtime.getURL('spike/offscreen.html');
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'], documentUrls: [url] });
  if (contexts.length > 0) return { created: false };
  await chrome.offscreen.createDocument({
    url,
    reasons: ['WORKERS', 'WEB_RTC', 'CLIPBOARD'],
    justification: 'BlindVault spike: session host, Argon2id worker, DataChannel and clipboard clear (D281).',
  });
  return { created: true };
}

chrome.runtime.onMessage.addListener((msg: any, sender: any, sendResponse: (r: unknown) => void) => {
  if (msg?.to === 'bg' && msg.op === 'ensure-offscreen') {
    ensureOffscreen().then(sendResponse, (e) => sendResponse({ error: String(e) }));
    return true;
  }
  return onMessage(msg, sender, sendResponse);
});
