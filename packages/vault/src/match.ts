// Matching items (extension.md §5, D283): which login items may be filled into a page.

import type { Item } from './item';
import { registrableDomain } from './psl/psl';

/** An origin filling can use: `https:` with a host, or `http:` on `localhost`. */
function fillable(url: URL): boolean {
  if (url.protocol === 'https:') return url.hostname !== '';
  return url.protocol === 'http:' && url.hostname === 'localhost';
}

/** A page's URL, when a fill may match it (§5.1); `null` for any other page. */
export function fillablePage(pageUrl: string): URL | null {
  try {
    const url = new URL(pageUrl);
    return fillable(url) ? url : null;
  } catch {
    return null;
  }
}

const WITH_AUTHORITY = /^[a-z][a-z0-9+.-]*:\/\//i;
const WITH_SCHEME = /^[a-z][a-z0-9+.-]*:/i;
/** `host:port` with nothing but a path, query or fragment after it: no scheme. */
const HOST_PORT = /^[^:/?#]+:[0-9]+(?:[/?#]|$)/;

/**
 * A `url` field's value as a URL filling can use (§5.2): trimmed, `https://` prepended when it has
 * no scheme, and `null` when it does not parse or its origin is not fillable.
 */
export function fieldUrl(value: string): URL | null {
  const trimmed = value.trim();
  let text = trimmed;
  if (!WITH_AUTHORITY.test(trimmed)) {
    // `mailto:a@b`, `javascript:…`: a scheme of its own, never filled.
    if (WITH_SCHEME.test(trimmed) && !HOST_PORT.test(trimmed)) return null;
    text = `https://${trimmed}`;
  }
  try {
    const url = new URL(text);
    return fillable(url) ? url : null;
  } catch {
    return null;
  }
}

/** Whether a `url` field matches a fillable page (§5.3). */
function fieldMatches(value: string, domain: boolean, page: URL): boolean {
  const field = fieldUrl(value);
  if (field === null) return false;
  if (domain && field.protocol === 'https:' && page.protocol === 'https:') {
    const site = registrableDomain(field.hostname);
    if (site !== null) return site === registrableDomain(page.hostname);
  }
  return field.origin === page.origin;
}

/**
 * The value of the first `url` field of a login item that matches a page (§5.3): a live item, one
 * of whose `url` fields has the page's exact origin, or its registrable domain when the field
 * carries `match: "domain"`. `null` when the item does not match.
 */
export function matchingUrl(item: Item, pageUrl: string): string | null {
  const page = fillablePage(pageUrl);
  if (page === null || item.templateId !== 'login' || item.trashOperationId !== undefined) {
    return null;
  }
  for (const f of item.fields) {
    if (f.type !== 'url' || typeof f.value !== 'string') continue;
    if (fieldMatches(f.value, f.match === 'domain', page)) return f.value;
  }
  return null;
}

/** Whether a login item matches a page (§5.3). */
export function itemMatches(item: Item, pageUrl: string): boolean {
  return matchingUrl(item, pageUrl) !== null;
}
