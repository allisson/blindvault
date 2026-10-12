import { expect, test } from '@playwright/test';

// The policy of overview §11 (D83, D91), written out here rather than imported from the build.
const POLICY = [
  "default-src 'none'",
  "script-src 'self' 'wasm-unsafe-eval'",
  "style-src 'self'",
  "img-src 'self' data: blob:",
  "worker-src 'self'",
  "manifest-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "require-trusted-types-for 'script'",
].join('; ');

// A 1×1 transparent PNG, so an image request that got through would load.
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=',
  'base64',
);

test('ships the CSP and the referrer policy by <meta>, before any script (D83, D91, D147)', async ({
  page,
}) => {
  await page.goto('/');
  const csp = page.locator('meta[http-equiv="Content-Security-Policy"]');
  await expect(csp).toHaveAttribute('content', POLICY);
  await expect(page.locator('meta[name="referrer"]')).toHaveAttribute('content', 'no-referrer');
  const order = await page.evaluate(() => {
    const all = [...document.head.children];
    const meta = all.findIndex((e) => e.getAttribute('http-equiv') === 'Content-Security-Policy');
    const script = all.findIndex((e) => e.tagName === 'SCRIPT' || e.tagName === 'LINK');
    return { meta, script };
  });
  expect(order.meta).toBeGreaterThanOrEqual(0);
  expect(order.meta).toBeLessThan(order.script);
});

// Code run by page.evaluate escapes the CSP's eval check, so `eval` is covered by the policy above
// (no 'unsafe-eval'), not here.
test('blocks an inline script, and a connection and an image to another origin (D91)', async ({
  page,
}) => {
  const outside: string[] = [];
  await page.route('https://outside.test/**', (route) => {
    outside.push(route.request().url());
    return route.fulfill({
      status: 200,
      headers: { 'access-control-allow-origin': '*', 'content-type': 'image/png' },
      body: PNG,
    });
  });
  await page.goto('/');
  await expect(page.getByTestId('new-password')).toBeVisible();
  const result = await page.evaluate(async () => {
    const violations: string[] = [];
    document.addEventListener('securitypolicyviolation', (e) => {
      violations.push(e.effectiveDirective);
    });
    const flags = window as unknown as { inlineRan?: boolean };
    try {
      const script = document.createElement('script');
      script.textContent = 'window.inlineRan = true';
      document.head.append(script);
    } catch {
      // Trusted Types refuse the script text itself where they are enforced.
    }
    const fetched = await fetch('https://outside.test/connect').then(
      () => true,
      () => false,
    );
    const image = await new Promise<boolean>((resolve) => {
      const img = new Image();
      img.onload = () => {
        resolve(true);
      };
      img.onerror = () => {
        resolve(false);
      };
      img.src = 'https://outside.test/image.png';
    });
    await new Promise((resolve) => setTimeout(resolve, 200));
    return { inline: flags.inlineRan === true, fetched, image, violations };
  });
  expect(result).toMatchObject({ inline: false, fetched: false, image: false });
  expect(result.violations).toEqual(expect.arrayContaining(['connect-src', 'img-src']));
  expect(outside).toEqual([]);
});

test('requires Trusted Types where the browser supports them (D83)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('new-password')).toBeVisible();
  const result = await page.evaluate(() => {
    if (!('trustedTypes' in window)) return 'unsupported';
    try {
      document.createElement('div').innerHTML = '<b>x</b>';
      return 'accepted';
    } catch {
      return 'refused';
    }
  });
  test.skip(result === 'unsupported', 'this browser has no Trusted Types');
  expect(result).toBe('refused');
});

test('sends no Referer header, even to its own origin (D147)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByTestId('new-password')).toBeVisible();
  const request = page.waitForRequest((r) => r.url().endsWith('/referrer-probe'));
  await page.evaluate(() => {
    void fetch('/referrer-probe').catch(() => undefined);
  });
  expect(await (await request).headerValue('referer')).toBeNull();
});
