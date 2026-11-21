// The extension's `manifest.json`, one per browser, from one source (extension.md §2, D283).

export const BROWSERS = ['chrome', 'firefox'] as const;
export type Browser = (typeof BROWSERS)[number];

/** Fixed, so the installation's storage survives updates (extension.md §2). */
export const GECKO_ID = 'blindvault@allisson.github.io';

export const EXTENSION_CSP =
  "script-src 'self' 'wasm-unsafe-eval'; object-src 'none'; base-uri 'none'; form-action 'none'";

/** `action.openPopup` without a policy (extension.md §10). */
export const MINIMUM_CHROME = '127';
/** `action.openPopup` out of its preference (Bugzilla 1799344). */
export const MINIMUM_FIREFOX = '149.0';

const RELEASE = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z.-]+)?$/;

/**
 * The browsers' `version`: the numbers of the package version, each at most 65535 (Chrome's limit).
 * A pre-release keeps its full name in Chrome's `version_name`; it is for testing and goes to no
 * store, since the release that follows has the same numbers.
 */
export function storeVersion(version: string): string {
  const match = RELEASE.exec(version);
  if (!match) throw new Error(`${JSON.stringify(version)} is not a release version`);
  const numbers = match.slice(1, 4);
  if (numbers.some((n) => Number(n) > 65535)) {
    throw new Error(`${version}: a browser takes no number above 65535`);
  }
  return numbers.join('.');
}

export function manifestFor(browser: Browser, version: string): Record<string, unknown> {
  const numbers = storeVersion(version);
  const icons = { '192': 'icon-192.png', '512': 'icon-512.png' };
  const common = {
    manifest_version: 3,
    name: 'BlindVault',
    version: numbers,
    description: 'A local-first, end-to-end encrypted personal vault.',
    icons,
    action: { default_title: 'BlindVault', default_icon: icons },
    optional_host_permissions: ['<all_urls>'],
    content_security_policy: { extension_pages: EXTENSION_CSP },
    commands: {
      fill: {
        suggested_key: { default: 'Ctrl+Shift+L', mac: 'Command+Shift+L' },
        description: 'Fill the login of the page',
      },
    },
  };
  if (browser === 'chrome') {
    return {
      ...common,
      ...(numbers === version ? {} : { version_name: version }),
      minimum_chrome_version: MINIMUM_CHROME,
      // unlimitedStorage: Chrome refuses persist() to an extension (D282).
      permissions: ['activeTab', 'scripting', 'idle', 'offscreen', 'unlimitedStorage'],
      background: { service_worker: 'background.js', type: 'module' },
    };
  }
  return {
    ...common,
    permissions: ['activeTab', 'scripting', 'idle'],
    background: { scripts: ['background.js'], type: 'module' },
    browser_specific_settings: {
      gecko: {
        id: GECKO_ID,
        strict_min_version: MINIMUM_FIREFOX,
        data_collection_permissions: { required: ['none'] },
      },
    },
  };
}

/** The file's bytes: two-space JSON and a final newline, the same on every build. */
export function manifestJson(browser: Browser, version: string): string {
  return `${JSON.stringify(manifestFor(browser, version), null, 2)}\n`;
}
