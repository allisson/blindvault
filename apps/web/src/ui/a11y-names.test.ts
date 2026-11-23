// The Android WebView drops a checkable control's name when it comes from another element: a
// checkbox or radio named by its `<label>` or by `aria-labelledby`, a toggle button named by
// `aria-label`, reach TalkBack without a name, where Chrome reads them (D299, android.md §11). A
// checkbox or radio carries its own `aria-label`, and a toggle button has its name as its text.
// A text field, text area or select loses every name, `aria-label` included, and keeps only its
// description: on Android its label also describes it.

import ts from 'typescript';
import { describe, expect, it } from 'vitest';

import { describedBy } from './components';

/** Input types that are not a text field: named as checkable controls, or not named here. */
const NOT_TEXT = new Set(['checkbox', 'radio', 'file', 'hidden', 'range', 'button', 'submit']);

/** Where `source` breaks D299: one line per control, with its line number. */
function unnamed(source: string, file = 'probe.tsx'): string[] {
  const tree = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
  const problems: string[] = [];
  const line = (node: ts.Node) => tree.getLineAndCharacterOfPosition(node.getStart()).line + 1;
  const attribute = (attributes: ts.JsxAttributes, name: string) =>
    attributes.properties.find(
      (p): p is ts.JsxAttribute => ts.isJsxAttribute(p) && p.name.getText() === name,
    );
  const literal = (a: ts.JsxAttribute | undefined) =>
    a?.initializer && ts.isStringLiteral(a.initializer) ? a.initializer.text : undefined;
  // Text a reader would get from the element's contents: JSX text or an expression child.
  const hasText = (children: ts.NodeArray<ts.JsxChild>): boolean =>
    children.some((child) => {
      if (ts.isJsxText(child)) return child.text.trim() !== '';
      if (ts.isJsxExpression(child)) return child.expression !== undefined;
      if (ts.isJsxElement(child)) return hasText(child.children);
      return false;
    });
  const visit = (node: ts.Node) => {
    const opening = ts.isJsxElement(node)
      ? node.openingElement
      : ts.isJsxSelfClosingElement(node)
        ? node
        : undefined;
    if (opening) {
      const tag = opening.tagName.getText();
      const type = literal(attribute(opening.attributes, 'type'));
      if (tag === 'input' && (type === 'checkbox' || type === 'radio')) {
        if (!attribute(opening.attributes, 'aria-label')) {
          problems.push(`${file}:${String(line(node))} ${type} without aria-label`);
        }
      }
      const field =
        tag === 'textarea' || tag === 'select' || (tag === 'input' && !NOT_TEXT.has(type ?? ''));
      // A spread may carry it, as SecretInput's shared props do.
      const spreads = opening.attributes.properties.some(ts.isJsxSpreadAttribute);
      if (field && !attribute(opening.attributes, 'aria-describedby') && !spreads) {
        problems.push(`${file}:${String(line(node))} ${tag} without aria-describedby`);
      }
      if (attribute(opening.attributes, 'aria-pressed')) {
        if (!ts.isJsxElement(node) || !hasText(node.children)) {
          problems.push(`${file}:${String(line(node))} toggle button without text`);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(tree);
  return problems;
}

describe('the check (D299)', () => {
  it('refuses a checkbox or radio named only by its label or aria-labelledby', () => {
    expect(unnamed('<label><input type="checkbox" />Text</label>')).toHaveLength(1);
    expect(unnamed('<input type="radio" aria-labelledby="x" />')).toHaveLength(1);
    expect(unnamed('<input type="checkbox" id="a" /><label htmlFor="a">Text</label>')).toHaveLength(
      1,
    );
  });

  it('refuses a toggle button with no text of its own', () => {
    expect(
      unnamed('<button aria-pressed={on} aria-label="Show"><Icon name="eye" /></button>'),
    ).toHaveLength(1);
    expect(unnamed('<Button aria-pressed={on} aria-label="Show" />')).toHaveLength(1);
    expect(unnamed('<button aria-pressed={on}>   </button>')).toHaveLength(1);
  });

  it('accepts aria-label on the control, and a toggle with text', () => {
    expect(unnamed('<label><input type="checkbox" aria-label="Text" />Text</label>')).toEqual([]);
    expect(unnamed('<button aria-pressed={on}><Icon /><span>{label}</span></button>')).toEqual([]);
    expect(unnamed('<Button aria-pressed={on}>{on ? hide : show}</Button>')).toEqual([]);
    expect(unnamed('<input type="file" />')).toEqual([]);
  });

  it('refuses a text field, text area or select with no description', () => {
    expect(unnamed('<label htmlFor="a">A</label><input id="a" />')).toHaveLength(1);
    expect(unnamed('<input type="search" aria-label="Search" />')).toHaveLength(1);
    expect(unnamed('<input type={kind} />')).toHaveLength(1);
    expect(unnamed('<textarea aria-label="Notes" />')).toHaveLength(1);
    expect(unnamed('<label>Folder<select><option /></select></label>')).toHaveLength(1);
  });

  it('accepts a field described, or given its props by a spread', () => {
    expect(unnamed('<input aria-describedby={describedBy(kind, id)} />')).toEqual([]);
    expect(unnamed('<select aria-describedby={x}><option /></select>')).toEqual([]);
    expect(unnamed('<input {...common} />')).toEqual([]);
  });
});

describe('a field described by its label on Android (D299)', () => {
  it('puts the label first on Android, then the message', () => {
    expect(describedBy('android', 'l', 'm')).toBe('l m');
    expect(describedBy('android', 'l')).toBe('l');
    expect(describedBy('android', 'l', undefined)).toBe('l');
  });

  it('leaves the label out on the web and in the extension', () => {
    for (const kind of ['web', 'extension'] as const) {
      expect(describedBy(kind, 'l', 'm')).toBe('m');
      expect(describedBy(kind, 'l')).toBeUndefined();
      expect(describedBy(kind, 'l', undefined)).toBeUndefined();
    }
  });
});

describe('the UI (D299)', () => {
  it('names every checkbox, radio and toggle button itself, and describes every field', () => {
    const sources = import.meta.glob<string>('../**/*.tsx', {
      query: '?raw',
      import: 'default',
      eager: true,
    });
    expect(Object.keys(sources).length).toBeGreaterThan(20);
    const problems = Object.entries(sources).flatMap(([file, text]) => unnamed(text, file));
    expect(problems).toEqual([]);
  });
});
