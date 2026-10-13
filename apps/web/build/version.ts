// `version.txt` (D191): the version of package.json on one line, listed in the asset manifest like
// any file, so the service worker can name the version of an update it staged. The build refuses a
// version the service worker would not accept.

import { type Plugin } from 'vite';

export const VERSION_FILE = 'version.txt';

/** The service worker's rule (public/sw.js): one line, nothing that could pass for markup. */
const VERSION = /^[0-9A-Za-z][0-9A-Za-z.+-]{0,63}$/;

export function versionFile(version: string): string {
  if (!VERSION.test(version)) {
    throw new Error(`version ${JSON.stringify(version)} cannot be written to ${VERSION_FILE}`);
  }
  return `${version}\n`;
}

export function versionText(version: string): Plugin {
  return {
    name: 'blindvault-version',
    apply: 'build',
    generateBundle() {
      this.emitFile({ type: 'asset', fileName: VERSION_FILE, source: versionFile(version) });
    },
  };
}
