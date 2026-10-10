import { BarcodeDetector, prepareZXingModule } from 'barcode-detector/ponyfill';
import qrcode from 'qrcode-generator';
import wasmUrl from 'zxing-wasm/reader/zxing_reader.wasm?url';

// Serve the WASM from this origin, never from a CDN (D83, D142).
prepareZXingModule({
  overrides: {
    locateFile: (path: string, prefix: string) => (path.endsWith('.wasm') ? wasmUrl : prefix + path),
  },
});

export interface RenderedQr {
  version: number;
  modules: number;
  characters: number;
}

/** Renders base45 text as a QR in alphanumeric mode, error correction M. */
export function renderQr(container: HTMLElement, text: string): RenderedQr {
  const qr = qrcode(0, 'M');
  qr.addData(text, 'Alphanumeric');
  qr.make();
  container.innerHTML = qr.createSvgTag({ cellSize: 4, margin: 4, scalable: true });
  const modules = qr.getModuleCount();
  return { version: (modules - 17) / 4, modules, characters: text.length };
}

export interface ScanResult {
  text: string;
  native: boolean;
  ms: number;
}

/** Opens the rear camera and resolves with the first QR found. */
export async function scanQr(video: HTMLVideoElement, signal: AbortSignal): Promise<ScanResult> {
  const nativeDetector = (globalThis as { BarcodeDetector?: unknown }).BarcodeDetector;
  const native =
    typeof nativeDetector === 'function' &&
    (await (nativeDetector as unknown as { getSupportedFormats(): Promise<string[]> }).getSupportedFormats()).includes('qr_code');
  const detector = new BarcodeDetector({ formats: ['qr_code'] });
  const stream = await navigator.mediaDevices.getUserMedia({
    video: { facingMode: 'environment' },
    audio: false,
  });
  const started = performance.now();
  video.srcObject = stream;
  video.setAttribute('playsinline', '');
  await video.play();
  try {
    while (!signal.aborted) {
      // detect() throws InvalidStateError until the video has a frame.
      if (video.readyState < HTMLMediaElement.HAVE_CURRENT_DATA) {
        await new Promise((r) => setTimeout(r, 50));
        continue;
      }
      const found = await detector.detect(video);
      const first = found[0];
      if (first) return { text: first.rawValue, native, ms: Math.round(performance.now() - started) };
      await new Promise((r) => setTimeout(r, 150));
    }
    throw new Error('scan cancelled');
  } finally {
    stream.getTracks().forEach((t) => {
      t.stop();
    });
    // A newer scan may already own the shared video element.
    if (video.srcObject === stream) video.srcObject = null;
  }
}
