// @ts-check
// Chrome's offscreen document (extension.md §6.3, D282, D286): created by the service worker only to
// clear the clipboard, without the focus a page needs. It receives no secret and holds nothing: it
// writes the empty string through a copy event and is closed at once.

/** @param {Document} doc */
export function clearClipboard(doc) {
  /** @param {ClipboardEvent} event */
  const copy = (event) => {
    event.clipboardData?.setData('text/plain', '');
    event.preventDefault();
  };
  doc.addEventListener('copy', copy);
  try {
    return doc.execCommand('copy');
  } finally {
    doc.removeEventListener('copy', copy);
  }
}

if (globalThis.document) clearClipboard(globalThis.document);
