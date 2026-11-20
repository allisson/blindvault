// The local relying party of measure 3 (D281): the same files on two ports of localhost, the page
// on 5310 framing 5311, a cross-origin iframe. No dependency: `node rp/serve.mjs`.
import { readFile } from 'node:fs/promises';
import { createServer } from 'node:http';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('.', import.meta.url));
const types = { '.html': 'text/html', '.js': 'text/javascript' };

for (const port of [5310, 5311]) {
  createServer(async (req, res) => {
    const name = new URL(req.url, 'http://localhost').pathname.replace(/^\/$/, '/index.html');
    if (!/^\/[a-z]+\.(html|js)$/.test(name)) return res.writeHead(404).end();
    try {
      const body = await readFile(join(root, name));
      res.writeHead(200, { 'content-type': types[extname(name)], 'cache-control': 'no-store' }).end(body);
    } catch {
      res.writeHead(404).end();
    }
  }).listen(port, '127.0.0.1', () => console.log(`http://localhost:${port}/`));
}
