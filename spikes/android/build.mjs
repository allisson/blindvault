// Builds the assets of the throwaway Android spike (D281) into dist/assets: web/ is the apps/web
// build, unmodified (its `_headers` left out), with the spike pages under web/spike/; headers.json
// holds the headers `_headers` sets on `/*`, which the Kotlin shell and serve.mjs add to every
// response, so the app runs under its real CSP.
import { cpSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const web = here('../../apps/web/dist');
const out = here('dist/assets');

rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/web`, { recursive: true });
cpSync(web, `${out}/web`, { recursive: true, filter: (src) => !src.endsWith('/_headers') });

// `_headers`: a path line, then indented `Name: value` lines; `! Name` removes a header.
const headers = {};
let inRoot = false;
for (const line of readFileSync(`${web}/_headers`, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  if (!/^\s/.test(line)) {
    inRoot = line.trim() === '/*';
    continue;
  }
  const m = /^\s+([^!:\s][^:]*):\s*(.*)$/.exec(line);
  if (inRoot && m) headers[m[1].trim()] = m[2].trim();
}
writeFileSync(`${out}/headers.json`, JSON.stringify(headers, null, 2));

await build({
  configFile: false,
  logLevel: 'warn',
  root: here('pages'),
  base: './',
  worker: { format: 'es' },
  build: {
    outDir: `${out}/web/spike`,
    emptyOutDir: true,
    target: 'es2022',
    minify: false,
    modulePreload: false,
    rollupOptions: { input: { spike: here('pages/spike.html'), peer: here('pages/peer.html') } },
  },
});
console.log(`assets in ${out}, headers: ${Object.keys(headers).join(', ')}`);
