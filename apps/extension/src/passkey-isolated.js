// @ts-check
/* global window */
// The isolated content script (extension.md §7.2, §7.7, D289): registered only while passkeys are
// on, in every frame. It carries a request of the MAIN-world script to the service worker, and the
// session host's answer back to the MAIN-world script that drew the request. The origin is not its
// to send: the service worker reads it from the browser. A classic script, shipped as written.

(function install(window, runtime) {
  const CHANNEL = 'blindvault-passkey';
  const REQUEST = /^[0-9a-f]{32}$/;
  const BROWSER = { kind: 'browser' };
  const post = window.postMessage.bind(window);

  /** @type {Set<string>} The requests of this frame the session host has not answered. */
  const relayed = new Set();
  let next = 0;

  /** @param {unknown} value @returns {value is Record<string, unknown>} */
  function object(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
  }

  /** @param {string} request @param {unknown} result */
  function back(request, result) {
    if (!relayed.delete(request)) return;
    post({ channel: CHANNEL, to: 'main', request, result }, '*');
  }

  window.addEventListener('message', (event) => {
    if (event.source !== window) return;
    const d = event.data;
    if (!object(d) || d.channel !== CHANNEL || d.to !== 'isolated') return;
    const { type, request, options } = d;
    if (type !== 'passkey-create' && type !== 'passkey-get') return;
    if (typeof request !== 'string' || !REQUEST.test(request) || relayed.has(request)) return;
    relayed.add(request);
    const id = next++;
    // Accepted at once by the session host; any other answer, or none, hands the call to the
    // browser (§7.7 Route, step 3).
    runtime.sendMessage({ v: 1, type, id, request, options }).then(
      /** @param {unknown} answer */
      (answer) => {
        const a = object(answer) ? answer : {};
        if (a.v !== 1 || a.id !== id || a.ok !== true) back(request, BROWSER);
      },
      () => {
        back(request, BROWSER);
      },
    );
  });

  runtime.onMessage.addListener(
    /** @param {unknown} message @param {{ id?: string, tab?: unknown }} sender */
    (message, sender) => {
      // From the extension's service worker only: a content script's message carries its tab.
      if (sender.id !== runtime.id || sender.tab !== undefined || !object(message)) return false;
      const keys = Object.keys(message).sort().join(',');
      if (keys !== 'id,request,result,type,v' || message.v !== 1) return false;
      if (message.type !== 'passkey-answer' || typeof message.request !== 'string') return false;
      if (!object(message.result)) return false;
      back(message.request, message.result);
      return false;
    },
  );
})(window, /** @type {any} */ (globalThis).chrome.runtime);
