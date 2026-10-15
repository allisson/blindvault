import qrcode from 'qrcode-generator';

// The QR code of a pairing or re-admission payload (D4, D208). The payload's text is base45 (RFC
// 9285), which is the QR alphanumeric alphabet, so the code uses that mode, with error correction M
// as the Phase 0 spike measured. The text a scan reads goes through the same parser as a pasted one.

/** Modules of light margin on each side, which readers need to find the code. */
export const QUIET_ZONE = 4;

/** The dark modules, row by row; throws on a text outside the alphanumeric alphabet. */
export function qrMatrix(text: string): readonly (readonly boolean[])[] {
  if (text === '') throw new Error('QR: empty text');
  const code = qrcode(0, 'M');
  code.addData(text, 'Alphanumeric');
  code.make();
  const size = code.getModuleCount();
  return Array.from({ length: size }, (_, r) =>
    Array.from({ length: size }, (_, c) => code.isDark(r, c)),
  );
}

/** An SVG path of one unit square per dark module, in a box of the matrix plus the quiet zone. */
export function qrPath(matrix: readonly (readonly boolean[])[]): string {
  let path = '';
  matrix.forEach((row, r) => {
    row.forEach((dark, c) => {
      if (dark) path += `M${String(c + QUIET_ZONE)} ${String(r + QUIET_ZONE)}h1v1h-1z`;
    });
  });
  return path;
}
