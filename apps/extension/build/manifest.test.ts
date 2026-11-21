import { describe, expect, it } from 'vitest';

import { EXTENSION_CSP, GECKO_ID, manifestFor, manifestJson, storeVersion } from './manifest';

describe('storeVersion', () => {
  it.each([
    ['1.0.0', '1.0.0'],
    ['1.0.0-rc.2', '1.0.0'],
    ['0.12.65535', '0.12.65535'],
  ])('takes the numbers of %s', (version, numbers) => {
    expect(storeVersion(version)).toBe(numbers);
  });

  it.each(['1.0', '01.0.0', '1.0.0+build', 'v1.0.0', '1.0.65536', ''])('refuses %s', (version) => {
    expect(() => storeVersion(version)).toThrow();
  });
});

describe('manifestFor (extension.md §2)', () => {
  it('gives Chrome its permissions, service worker, minimum and pre-release name', () => {
    const m = manifestFor('chrome', '1.0.0-rc.2');
    expect(m).toMatchObject({
      manifest_version: 3,
      version: '1.0.0',
      version_name: '1.0.0-rc.2',
      minimum_chrome_version: '127',
      permissions: [
        'activeTab',
        'scripting',
        'idle',
        'clipboardWrite',
        'offscreen',
        'unlimitedStorage',
      ],
      action: { default_popup: 'popup.html' },
      optional_host_permissions: ['<all_urls>'],
      background: { service_worker: 'background.js', type: 'module' },
    });
    expect(m).not.toHaveProperty('browser_specific_settings');
    expect(m).not.toHaveProperty('key');
  });

  it('gives a release no version_name', () => {
    expect(manifestFor('chrome', '1.2.3')).not.toHaveProperty('version_name');
  });

  it('gives Firefox its event page, fixed ID, minimum and no data collection', () => {
    const m = manifestFor('firefox', '1.0.0-rc.2');
    expect(m).toMatchObject({
      version: '1.0.0',
      permissions: ['activeTab', 'scripting', 'idle', 'clipboardWrite'],
      action: { default_popup: 'popup.html' },
      optional_host_permissions: ['<all_urls>'],
      background: { scripts: ['background.js'], type: 'module' },
      browser_specific_settings: {
        gecko: {
          id: GECKO_ID,
          strict_min_version: '149.0',
          data_collection_permissions: { required: ['none'] },
        },
      },
    });
    expect(m).not.toHaveProperty('version_name');
  });

  it.each(['chrome', 'firefox'] as const)('gives %s the CSP and the fill command', (browser) => {
    expect(manifestFor(browser, '1.0.0')).toMatchObject({
      content_security_policy: { extension_pages: EXTENSION_CSP },
      commands: {
        fill: { suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' } },
      },
      icons: { '192': 'icon-192.png', '512': 'icon-512.png' },
    });
  });

  it('grants no host and declares no content script: filling needs the user’s gesture (CRYPTO-INV-026)', () => {
    for (const browser of ['chrome', 'firefox'] as const) {
      const m = manifestFor(browser, '1.0.0');
      expect(m).not.toHaveProperty('host_permissions');
      expect(m).not.toHaveProperty('content_scripts');
    }
  });

  it('allows no remote script, eval, plugin, base or form target', () => {
    expect(EXTENSION_CSP.split('; ')).toEqual([
      "script-src 'self' 'wasm-unsafe-eval'",
      "object-src 'none'",
      "base-uri 'none'",
      "form-action 'none'",
    ]);
  });

  it('writes the same bytes on every build', () => {
    const json = manifestJson('firefox', '1.0.0');
    expect(json).toBe(manifestJson('firefox', '1.0.0'));
    expect(json.endsWith('}\n')).toBe(true);
    expect(JSON.parse(json)).toEqual(manifestFor('firefox', '1.0.0'));
  });
});
