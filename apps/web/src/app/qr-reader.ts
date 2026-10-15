import { type ReadResult, prepareZXingModule, readBarcodes } from 'zxing-wasm/reader';

// Reads a QR code from a camera frame, with zxing-wasm alone (D208): Safari has no BarcodeDetector,
// and one decoder behaves the same in every engine. The library would fetch its WASM from a CDN by
// default; the app always passes where its own copy is served (`qr-wasm.ts`), and the CSP's
// `connect-src 'self'` refuses any other origin anyway.

/** The RGBA pixels of a frame, as `ImageData` holds them. */
export interface Pixels {
  readonly data: Uint8ClampedArray;
  readonly width: number;
  readonly height: number;
}

/** Where the WASM module comes from: `locateFile` in the app, `wasmBinary` in tests. */
export interface ReaderModule {
  readonly locateFile?: (path: string, prefix: string) => string;
  readonly wasmBinary?: ArrayBuffer;
}

/**
 * A reader of the first valid QR code in a frame, or `undefined`.
 */
export function createQrReader(
  module: ReaderModule,
): (frame: Pixels) => Promise<string | undefined> {
  prepareZXingModule({ overrides: { ...module } });
  return async (frame) => {
    const results: ReadResult[] = await readBarcodes(frame as ImageData, {
      formats: ['QRCode'],
      maxNumberOfSymbols: 1,
      tryHarder: true,
    });
    return results.find((r) => r.isValid)?.text;
  };
}
