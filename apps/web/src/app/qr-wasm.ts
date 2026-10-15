import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

import { createQrReader } from './qr-reader';

// The QR reader with the WASM module the build serves from this origin (D208). Imported only when
// a scan starts, so the app loads neither the reader nor its WASM before.

export const readQr = createQrReader({
  locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
});
