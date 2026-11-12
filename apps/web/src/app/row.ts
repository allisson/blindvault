// What a list row shows of an item (D246): read only from non-secret fields, as search reads them
// (D132), so the row holds no secret, TOTP code or seed phrase (CRYPTO-INV-024). The password a
// row copies is passed to the clipboard on click, never rendered.

import { type Item } from '@blindvault/vault';

import { NEVER_READ, normalizeForSearch } from './search';

/** The roles a subtitle joins, per template; a template not listed shows none. */
const SUBTITLE = new Map<string, readonly string[]>([
  ['login', ['username', 'url']],
  ['card', ['cardholder', 'expiry']],
  ['identity', ['email', 'phone']],
  ['developer-credential', ['provider', 'baseUrl']],
  ['crypto-wallet', ['walletName', 'network']],
  ['document', ['documentType', 'issuer']],
]);

/** A URL's host, or the text itself when it is not a URL. */
export function host(url: string): string {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

/** The non-secret values of the template's subtitle roles, a URL as its host, joined by " · ". */
export function subtitle(item: Item): string {
  return (SUBTITLE.get(item.templateId) ?? [])
    .flatMap((role) => {
      const field = item.fields.find((f) => f.role === role);
      if (!field || NEVER_READ.has(field.type) || typeof field.value !== 'string') return [];
      const value = field.value.trim();
      if (value === '') return [];
      return [field.type === 'url' ? host(value) : value];
    })
    .join(' · ');
}

/** The password a row's Copy copies: a Login's password field, when it holds one. */
export function rowPassword(item: Item): string | undefined {
  const field = item.fields.find((f) => f.role === 'password' && f.type === 'secret');
  return typeof field?.value === 'string' && field.value !== '' ? field.value : undefined;
}

/** The first user-perceived character, so a flag or a family emoji stays whole. */
function first(text: string): string | undefined {
  for (const { segment } of new Intl.Segmenter().segment(text.trim())) return segment;
  return undefined;
}

/** The avatar: the title's first character and one of six color pairs, derived from the title. */
export function avatar(title: string): { readonly initial: string; readonly color: number } {
  let hash = 0;
  for (const c of title) hash = (hash * 31 + (c.codePointAt(0) ?? 0)) >>> 0;
  return { initial: (first(title) ?? '?').toUpperCase(), color: hash % 6 };
}

/** The phone list's group of a title: its first letter without marks, or "#". */
export function letter(title: string): string {
  const initial = first(normalizeForSearch(title))?.toUpperCase() ?? '';
  return /^\p{L}$/u.test(initial) ? initial : '#';
}
