// Builds the throwaway extension twice, dist/chrome and dist/firefox (D281). The root of each is the
// apps/web build, unmodified but for `_headers`, a Cloudflare file Chrome refuses in an extension
// (names starting with "_" are reserved); the spike pages go under spike/, the content scripts and
// Chrome's service worker at the root as classic scripts.
import { cpSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { build } from 'vite';

const here = (p) => fileURLToPath(new URL(p, import.meta.url));
const web = here('../../apps/web/dist');
const CSP = "script-src 'self' 'wasm-unsafe-eval'; object-src 'self'";
const MATCHES = ['http://localhost/*', 'https://webauthn.io/*'];

function manifest(browser) {
  const common = {
    manifest_version: 3,
    name: 'BlindVault spike',
    version: '0.0.1',
    description: 'Throwaway Phase 10 measurements (D281). Holds no vault data.',
    action: { default_popup: 'spike/popup.html', default_title: 'BlindVault spike' },
    host_permissions: MATCHES,
    content_scripts: [
      { matches: MATCHES, js: ['main.js'], run_at: 'document_start', all_frames: true, world: 'MAIN' },
      { matches: MATCHES, js: ['relay.js'], run_at: 'document_start', all_frames: true },
    ],
    content_security_policy: { extension_pages: CSP },
  };
  if (browser === 'chrome') {
    return {
      ...common,
      minimum_chrome_version: '123',
      background: { service_worker: 'background.js' },
      permissions: ['storage', 'unlimitedStorage', 'offscreen', 'clipboardWrite', 'clipboardRead'],
    };
  }
  return {
    ...common,
    browser_specific_settings: { gecko: { id: 'spike@blindvault.invalid', strict_min_version: '128.0' } },
    background: { page: 'spike/background.html' },
    permissions: ['storage', 'unlimitedStorage', 'clipboardWrite', 'clipboardRead'],
  };
}

const resolve = { alias: {} };

for (const browser of ['chrome', 'firefox']) {
  const out = here(`dist/${browser}`);
  rmSync(out, { recursive: true, force: true });
  mkdirSync(out, { recursive: true });
  cpSync(web, out, { recursive: true, filter: (src) => !src.endsWith('/_headers') });

  await build({
    configFile: false,
    logLevel: 'warn',
    root: here('pages'),
    base: './',
    resolve,
    worker: { format: 'es' },
    build: {
      outDir: `${out}/spike`,
      emptyOutDir: true,
      target: 'es2022',
      minify: false,
      modulePreload: false,
      rollupOptions: {
        input: Object.fromEntries(
          ['spike', 'offscreen', 'host', 'background', 'confirm', 'popup'].map((n) => [n, here(`pages/${n}.html`)]),
        ),
      },
    },
  });

  const scripts = ['main', 'relay', ...(browser === 'chrome' ? ['background-chrome'] : [])];
  for (const name of scripts) {
    await build({
      configFile: false,
      logLevel: 'warn',
      resolve,
      build: {
        outDir: out,
        emptyOutDir: false,
        minify: false,
        target: 'es2022',
        lib: {
          entry: here(`scripts/${name}.ts`),
          formats: ['iife'],
          name: 'bvSpike',
          fileName: () => (name === 'background-chrome' ? 'background.js' : `${name}.js`),
        },
      },
    });
  }

  cpSync(here('rp'), `${out}/rp`, { recursive: true });
  writeFileSync(`${out}/manifest.json`, `${JSON.stringify(manifest(browser), null, 2)}\n`);
  console.log(`built ${out}`);
}
