// The Mac side of the Android spike (D281): serves dist/assets/web on http://localhost:5320, for
// Chrome on the A54 through `adb reverse tcp:5320 tcp:5320` (measure 1's Argon2id comparison) and
// for the Mac peer page, and relays the DataChannel offer and answer and the QR nonce (measure 3).
// No dependency, nothing kept on disk.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join, normalize } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('./dist/assets/web/', import.meta.url));
const headers = JSON.parse(await readFile(fileURLToPath(new URL('./dist/assets/headers.json', import.meta.url)), 'utf8'));
delete headers['Strict-Transport-Security'];
const TYPES = {
  '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css',
  '.wasm': 'application/wasm', '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.txt': 'text/plain',
};
const signal = { offer: '', answer: '', nonce: '' };

createServer(async (req, res) => {
  const path = new URL(req.url, 'http://localhost').pathname;
  const slot = path.slice(1);
  if (slot in signal) {
    if (req.method === 'POST') {
      let body = '';
      for await (const chunk of req) body += chunk;
      signal[slot] = body;
      if (slot === 'offer') signal.answer = '';
      res.writeHead(204).end();
    } else {
      res.writeHead(signal[slot] ? 200 : 204, { 'Content-Type': 'text/plain' }).end(signal[slot]);
    }
    return;
  }
  const file = normalize(join(root, path === '/' ? 'index.html' : path));
  if (!file.startsWith(root)) return res.writeHead(403).end();
  try {
    const body = await readFile(file);
    res.writeHead(200, { ...headers, 'Content-Type': TYPES[extname(file)] ?? 'application/octet-stream' }).end(body);
  } catch {
    res.writeHead(404).end();
  }
}).listen(5320, '127.0.0.1', () => console.log('http://localhost:5320/spike/peer.html'));
