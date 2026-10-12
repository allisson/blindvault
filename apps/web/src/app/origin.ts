/**
 * True when the app runs under a sub-path of a `github.io` host: a project site there shares its
 * origin, so its IndexedDB, Web Lock and app windows, with every other Pages site of the account
 * (D90). It catches a misconfigured deployment, not a malicious host.
 */
export function sharedOrigin(location: {
  readonly hostname: string;
  readonly pathname: string;
}): boolean {
  const host = location.hostname.toLowerCase().replace(/\.$/, '');
  if (!host.endsWith('.github.io')) return false;
  const first = location.pathname.split('/').find((segment) => segment !== '');
  return first !== undefined && first !== 'index.html';
}
