// Measure 3 (D281): the isolated content script. It forwards the MAIN world's requests to the
// background and passes on `origin` only as `claimedOrigin`, which the background logs and ignores.

declare const chrome: any;

const CH = 'bv-spike';

window.addEventListener('message', (e) => {
  if (e.source !== window || e.data?.ch !== CH || e.data.dir !== 'to-relay') return;
  const { id, kind, options, origin } = e.data;
  chrome.runtime
    .sendMessage({ to: 'bg', op: 'webauthn', kind, options, claimedOrigin: origin })
    .then(
      (r: any) => window.postMessage({ ch: CH, dir: 'to-main', id, ...r }, '*'),
      (err: unknown) =>
        window.postMessage(
          { ch: CH, dir: 'to-main', id, error: { name: 'UnknownError', message: String(err) } },
          '*',
        ),
    );
});
