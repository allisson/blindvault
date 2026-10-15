// The STUN list (§9.2, D209): kept in `localStorage` for the installation, since the joining device
// has no vault and replace by pairing runs locked, so an encrypted setting could not be read. It
// holds no vault data. A stored list that cannot be read uses no STUN server, never the defaults,
// so no address goes to a provider the user did not choose.

/** The default STUN servers (§9.2). */
export const DEFAULT_STUN_URLS: readonly string[] = [
  'stun:stun.l.google.com:19302',
  'stun:stun.cloudflare.com:3478',
];

export const STUN_LIMITS = { urls: 8, length: 255 } as const;

export type StunSettings =
  | { readonly kind: 'default' }
  | { readonly kind: 'custom'; readonly urls: readonly string[] }
  | { readonly kind: 'unreadable' };

/** Why a URL or a list is refused. */
export type StunProblem = 'scheme' | 'query' | 'host' | 'port' | 'too-long' | 'empty' | 'too-many';

export type StunList =
  | { readonly kind: 'ok'; readonly urls: readonly string[] }
  | {
      readonly kind: 'invalid';
      readonly problem: StunProblem;
      /** The URL refused, when one is. */
      readonly url?: string;
    };

const STORAGE_KEY = 'blindvault.stun';
const SCHEME = 'stun:';
const LABEL = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;
const IPV4 = /^\d+(?:\.\d+){3}$/;
const IPV6 = /^[0-9a-f:.]+$/;
const PORT = /^\d{1,5}$/;

function validHost(host: string): boolean {
  if (host.startsWith('[')) {
    const inner = host.slice(1, -1);
    return host.endsWith(']') && inner.includes(':') && IPV6.test(inner);
  }
  if (IPV4.test(host)) return host.split('.').every((n) => Number(n) <= 255);
  return host.length <= 253 && host.split('.').every((label) => LABEL.test(label));
}

export type StunUrl =
  | { readonly ok: true; readonly url: string }
  | { readonly ok: false; readonly problem: StunProblem };

const refused = (problem: StunProblem): StunUrl => ({ ok: false, problem });

/**
 * One `stun:host[:port]` URL, lowercased and with its port as a number, or why it is refused.
 * TURN is refused: v1 uses none (§9.2).
 */
export function parseStunUrl(text: string): StunUrl {
  const url = text.trim().toLowerCase();
  if (url.length > STUN_LIMITS.length) return refused('too-long');
  if (!url.startsWith(SCHEME)) return refused('scheme');
  const rest = url.slice(SCHEME.length);
  if (rest.includes('?')) return refused('query');
  // The port follows the last `:` outside the brackets of an IPv6 address.
  const close = rest.lastIndexOf(']');
  const colon = rest.indexOf(':', close + 1);
  const host = colon < 0 ? rest : rest.slice(0, colon);
  if (close >= 0 && close !== host.length - 1) return refused('host');
  if (!validHost(host)) return refused('host');
  if (colon < 0) return { ok: true, url: `${SCHEME}${host}` };
  const port = rest.slice(colon + 1);
  // A second `:` outside brackets is an IPv6 address without them.
  if (port.includes(':')) return refused('host');
  if (!PORT.test(port) || Number(port) < 1 || Number(port) > 65535) return refused('port');
  return { ok: true, url: `${SCHEME}${host}:${String(Number(port))}` };
}

function checkList(urls: readonly string[]): StunList {
  const kept: string[] = [];
  for (const text of urls) {
    const parsed = parseStunUrl(text);
    if (!parsed.ok) return { kind: 'invalid', problem: parsed.problem, url: text.trim() };
    if (!kept.includes(parsed.url)) kept.push(parsed.url);
  }
  if (kept.length === 0) return { kind: 'invalid', problem: 'empty' };
  if (kept.length > STUN_LIMITS.urls) return { kind: 'invalid', problem: 'too-many' };
  return { kind: 'ok', urls: kept };
}

/** A list typed by the user, one URL per line; blank lines are skipped and duplicates dropped. */
export function parseStunList(text: string): StunList {
  return checkList(text.split(/\r?\n/).filter((line) => line.trim() !== ''));
}

/** The hosts of a list, for the same-network hint. */
export function stunHosts(urls: readonly string[]): string[] {
  return urls.map((url) => {
    const rest = url.slice(SCHEME.length);
    const colon = rest.indexOf(':', rest.lastIndexOf(']') + 1);
    return colon < 0 ? rest : rest.slice(0, colon);
  });
}

/** What is stored: only a list exactly as `saveStunList` writes it is read; anything else is unreadable. */
export function readStunSettings(raw: string | null): StunSettings {
  if (raw === null) return { kind: 'default' };
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { kind: 'unreadable' };
  }
  if (!Array.isArray(parsed) || !parsed.every((u): u is string => typeof u === 'string')) {
    return { kind: 'unreadable' };
  }
  const list = checkList(parsed);
  return list.kind === 'ok' &&
    list.urls.length === parsed.length &&
    list.urls.every((u, i) => u === parsed[i])
    ? { kind: 'custom', urls: list.urls }
    : { kind: 'unreadable' };
}

/**
 * The stored list. A browser that refuses `localStorage` can hold none, so the defaults apply: an
 * unreadable value there could never be fixed.
 */
export function loadStunSettings(): StunSettings {
  try {
    return readStunSettings(localStorage.getItem(STORAGE_KEY));
  } catch {
    return { kind: 'default' };
  }
}

/** Saves a valid list; returns false, saving nothing, for an invalid one or a refused write. */
export function saveStunList(urls: readonly string[]): boolean {
  const list = checkList(urls);
  if (list.kind !== 'ok') return false;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(list.urls));
    return true;
  } catch {
    return false;
  }
}

/** Restores the defaults. */
export function resetStunList(): void {
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing could have been stored.
  }
}
