import { createHash } from 'node:crypto';

import { expect, test } from '@playwright/test';
import { startScreen } from './create';

// The served asset manifest matches the served files (overview §11, D189, docs/build.md).
test('serves asset-manifest.txt, whose lines match the served files and cover every loaded asset (D189)', async ({
  page,
  request,
}) => {
  const response = await request.get('/asset-manifest.txt');
  expect(response.ok()).toBe(true);
  const text = await response.text();
  expect(text.endsWith('\n')).toBe(true);
  const lines = text.slice(0, -1).split('\n');
  const listed = new Map<string, string>();
  for (const line of lines) {
    const match = /^([0-9a-f]{64}) {2}(\S.*)$/.exec(line);
    expect(match, line).not.toBeNull();
    listed.set(match?.[2] ?? '', match?.[1] ?? '');
  }
  const paths = [...listed.keys()];
  expect(paths).toEqual([...paths].sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b))));
  expect(paths).toContain('index.html');
  expect(paths).not.toContain('asset-manifest.txt');
  expect(paths).not.toContain('sw.js');

  for (const [path, hash] of listed) {
    const body = await (await request.get(`/${path}`)).body();
    expect(createHash('sha256').update(body).digest('hex'), path).toBe(hash);
  }

  // Every script and stylesheet the app loads is listed.
  const loaded: string[] = [];
  page.on('requestfinished', (r) => {
    const url = new URL(r.url());
    if (url.pathname.startsWith('/assets/')) loaded.push(url.pathname.slice(1));
  });
  await page.goto('/');
  await startScreen(page);
  expect(loaded.length).toBeGreaterThan(0);
  for (const path of loaded) expect(paths, path).toContain(path);
});
