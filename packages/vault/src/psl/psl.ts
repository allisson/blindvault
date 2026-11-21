// Public Suffix List (extension.md §5.5, D283): the list pinned in this directory (README.md),
// read by the list's own algorithm (https://publicsuffix.org/list/). Hosts are compared in their
// ASCII form, as `URL` returns them, so the list's Unicode rules are converted once.

import list from './public_suffix_list';

interface Rules {
  readonly normal: ReadonlySet<string>;
  /** `*.ck` is kept as `ck`: any one label under it is a public suffix. */
  readonly wildcard: ReadonlySet<string>;
  /** `!www.ck` is kept as `www.ck`: its parent is the public suffix. */
  readonly exception: ReadonlySet<string>;
}

let rules: Rules | undefined;

/** A host in the lowercase ASCII (punycode) form `URL` gives, or `null` when it does not parse. */
export function asciiHost(host: string): string | null {
  if (host === '' || /[/?#@:\s]/.test(host)) return null;
  try {
    return new URL(`https://${host}`).hostname;
  } catch {
    return null;
  }
}

function parse(text: string): Rules {
  const normal = new Set<string>();
  const wildcard = new Set<string>();
  const exception = new Set<string>();
  for (const raw of text.split('\n')) {
    // A rule is the line's first run of non-whitespace; comments start with `//`.
    const rule = raw.trim().split(/\s/)[0] ?? '';
    if (rule === '' || rule.startsWith('//')) continue;
    if (rule.startsWith('!')) {
      const host = asciiHost(rule.slice(1));
      if (host !== null) exception.add(host);
    } else if (rule.startsWith('*.')) {
      const host = asciiHost(rule.slice(2));
      if (host !== null) wildcard.add(host);
    } else {
      const host = asciiHost(rule);
      if (host !== null) normal.add(host);
    }
  }
  return { normal, wildcard, exception };
}

function isIpAddress(host: string): boolean {
  return host.startsWith('[') || /^[0-9]+(\.[0-9]+){3}$/.test(host);
}

/** The labels of an ASCII host, or `null` for an empty label or an IP address. */
function labelsOf(host: string): string[] | null {
  if (isIpAddress(host)) return null;
  const labels = host.split('.');
  return labels.every((l) => l !== '') ? labels : null;
}

/** How many of the host's last labels form its public suffix. */
function suffixLength(labels: readonly string[]): number {
  rules ??= parse(list);
  const n = labels.length;
  // An exception rule prevails over every other rule: its parent is the public suffix.
  for (let i = 0; i < n; i++) {
    if (rules.exception.has(labels.slice(i).join('.'))) return n - i - 1;
  }
  // The rule with the most labels prevails; with none, the implicit `*` rule (one label).
  let longest = 1;
  for (let i = 0; i < n; i++) {
    const candidate = labels.slice(i).join('.');
    if (rules.normal.has(candidate)) longest = Math.max(longest, n - i);
    if (i > 0 && rules.wildcard.has(candidate)) longest = Math.max(longest, n - i + 1);
  }
  return longest;
}

/**
 * The registrable domain of a host (its public suffix and one more label), in ASCII form, or `null`
 * when the host does not parse, is an IP address, or is itself a public suffix.
 */
export function registrableDomain(host: string): string | null {
  const ascii = asciiHost(host);
  const labels = ascii === null ? null : labelsOf(ascii);
  if (labels === null) return null;
  const length = suffixLength(labels);
  return labels.length > length ? labels.slice(-length - 1).join('.') : null;
}

/** Whether a host is a public suffix: a rule of the list, or a single label. */
export function isPublicSuffix(host: string): boolean {
  const ascii = asciiHost(host);
  const labels = ascii === null ? null : labelsOf(ascii);
  return labels !== null && suffixLength(labels) >= labels.length;
}
