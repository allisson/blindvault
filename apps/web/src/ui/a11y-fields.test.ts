// On Android a field is described by its own label, since the WebView drops every name a field
// gets and keeps only its description (D299): the shared field components, rendered as the
// Android build renders them.

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';

import { LanguageProvider } from '../i18n/context';
import { Field, TextArea } from './components';
import { SecretInput } from './Secret';

vi.mock('../platform', () => ({ platform: { kind: 'android' } }));

const render = (child: ReturnType<typeof createElement>) =>
  renderToStaticMarkup(createElement(LanguageProvider, null, child));

/** The text of each element the first `tag` of `html` names in `aria-describedby`. */
function description(html: string, tag: string): string[] {
  const control = new RegExp(`<${tag}\\b[^>]*>`).exec(html)?.[0] ?? '';
  const ids = /aria-describedby="([^"]*)"/.exec(control)?.[1]?.split(' ') ?? [];
  return ids.map((id) => {
    const text = new RegExp(`id="${id}"[^>]*>([^<]*)<`).exec(html)?.[1];
    if (text === undefined) throw new Error(`no element ${id}`);
    return text;
  });
}

describe('the field components on Android (D299)', () => {
  it('describes a field by its label, then its error', () => {
    const html = render(createElement(Field, { label: 'Local password', error: 'Too short' }));
    expect(description(html, 'input')).toEqual(['Local password', 'Too short']);
  });

  it('describes a field with no message by its label alone', () => {
    const html = render(createElement(Field, { label: 'Title', type: 'password' }));
    expect(description(html, 'input')).toEqual(['Title']);
  });

  it('describes a text area by its label, then its hint', () => {
    const html = render(createElement(TextArea, { label: 'Notes', hint: 'Plain text' }));
    expect(description(html, 'textarea')).toEqual(['Notes', 'Plain text']);
  });

  it('describes a secret by its label', () => {
    const html = render(
      createElement(SecretInput, { label: 'Password', value: '', onChange: () => undefined }),
    );
    expect(description(html, 'input')).toEqual(['Password']);
  });
});
