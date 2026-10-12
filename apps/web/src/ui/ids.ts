/** An ID as hex, for React keys and comparisons in the UI; never put in the URL (D167). */
export function hex(id: Uint8Array): string {
  return Array.from(id, (b) => b.toString(16).padStart(2, '0')).join('');
}
