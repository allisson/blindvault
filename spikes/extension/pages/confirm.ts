// The confirming click of every use (UP, D268), and "another authenticator", which hands the call
// back to the browser (D267).

declare const chrome: any;

const id = new URLSearchParams(location.search).get('id') ?? '';
const el = document.querySelector<HTMLPreElement>('#request')!;

void chrome.storage.session.get(`req:${id}`).then((r: any) => {
  const req = r[`req:${id}`];
  el.textContent = req ? JSON.stringify(req, null, 2) : 'Request not found (the background restarted?)';
});

for (const choice of ['use', 'browser', 'cancel'] as const) {
  document.getElementById(choice)?.addEventListener('click', () => {
    void chrome.runtime.sendMessage({ to: 'bg', op: 'decision', id, choice }).then(() => window.close());
  });
}
