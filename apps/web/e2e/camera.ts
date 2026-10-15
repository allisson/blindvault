// A camera that shows another page's QR code (D208). Playwright's fake cameras show a fixed
// pattern, so this wraps `getUserMedia`: it still opens the browser's fake camera, which gives the
// page the capture permission the scanning device holds before it gathers (D161), and returns
// instead a canvas stream that draws whatever `showQr` set. Stopping the returned track stops the
// fake camera too, so a test can check that every track the page got has ended. Playwright's WebKit
// replaces `navigator.mediaDevices` with a new object shortly after the page loads, so each fake is
// put on whichever object the page reads, through the `Navigator.prototype` getter.

import { type BrowserContext, type Page, expect } from '@playwright/test';

declare global {
  interface Window {
    __camera: {
      frame: HTMLImageElement | undefined;
      tracks: MediaStreamTrack[];
    };
  }
}

export async function fakeQrCamera(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    window.__camera = { frame: undefined, tracks: [] };
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices');
    const done = new WeakSet<MediaDevices>();
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      configurable: true,
      get(this: Navigator) {
        const media = original?.get?.call(this) as MediaDevices;
        if (!done.has(media)) {
          done.add(media);
          install(media);
        }
        return media;
      },
    });
    function install(media: MediaDevices) {
      const open = media.getUserMedia.bind(media);
      const fake = async (): Promise<MediaStream> => {
        const real = await open({ video: true });
        const canvas = document.createElement('canvas');
        canvas.width = 480;
        canvas.height = 480;
        const context = canvas.getContext('2d');
        const draw = () => {
          if (!context) return;
          context.fillStyle = '#fff';
          context.fillRect(0, 0, 480, 480);
          const frame = window.__camera.frame;
          if (frame) context.drawImage(frame, 40, 40, 400, 400);
        };
        draw();
        const timer = setInterval(draw, 100);
        const stream = canvas.captureStream(10);
        for (const track of stream.getTracks()) {
          const stop = track.stop.bind(track);
          track.stop = () => {
            stop();
            clearInterval(timer);
            for (const t of real.getTracks()) t.stop();
          };
        }
        window.__camera.tracks.push(...stream.getTracks(), ...real.getTracks());
        return stream;
      };
      Object.defineProperty(media, 'getUserMedia', { value: fake });
    }
  });
}

/** `getUserMedia` refuses, as when the user denies the camera. */
export async function deniedCamera(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    // Through the getter, as for `fakeQrCamera`.
    const original = Object.getOwnPropertyDescriptor(Navigator.prototype, 'mediaDevices');
    Object.defineProperty(Navigator.prototype, 'mediaDevices', {
      configurable: true,
      get(this: Navigator) {
        const media = original?.get?.call(this) as MediaDevices;
        Object.defineProperty(media, 'getUserMedia', {
          configurable: true,
          value: () => Promise.reject(new DOMException('denied', 'NotAllowedError')),
        });
        return media;
      },
    });
  });
}

/** No `navigator.mediaDevices`, as on a page with no camera API. */
export async function noCamera(context: BrowserContext): Promise<void> {
  await context.addInitScript(() => {
    Object.defineProperty(navigator, 'mediaDevices', { value: undefined, configurable: true });
  });
}

/** The QR code `from` shows, in front of `to`'s camera. */
export async function showQr(from: Page, to: Page): Promise<void> {
  const svg = await from.getByTestId('pairing-qr').evaluate((e) => e.outerHTML);
  await to.evaluate(
    (markup) =>
      new Promise<void>((resolve, reject) => {
        const image = new Image();
        image.onload = () => {
          window.__camera.frame = image;
          resolve();
        };
        image.onerror = () => {
          reject(new Error('the QR code did not load as an image'));
        };
        // A size, which an SVG image needs to be drawn on a canvas in every engine.
        const sized = markup.replace('<svg ', '<svg width="400" height="400" ');
        image.src = URL.createObjectURL(new Blob([sized], { type: 'image/svg+xml' }));
      }),
    svg,
  );
}

/** Every track the page's camera gave has ended: the scan let the camera go (D208). */
export async function expectCameraReleased(page: Page): Promise<void> {
  await expect
    .poll(() =>
      page.evaluate(() => {
        const tracks = window.__camera.tracks;
        return tracks.length > 0 && tracks.every((t) => t.readyState === 'ended');
      }),
    )
    .toBe(true);
}
