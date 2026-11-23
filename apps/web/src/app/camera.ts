// The camera that scans the other device's QR code (D208). Only video, the back camera preferred;
// the caller stops every track once the text is taken or the screen goes, so the camera is never
// held longer than the scan (D161). The device that shows the first code holds it a moment before
// it gathers, so its host candidate is a raw IP address where the browser allows it (D296).

export type MediaPort = Pick<MediaDevices, 'getUserMedia'>;

export type CameraOpen =
  | { readonly kind: 'ok'; readonly stream: MediaStream }
  /** The user or the browser refused the permission. */
  | { readonly kind: 'denied' }
  /** No camera, or none that fits. */
  | { readonly kind: 'none' }
  | { readonly kind: 'failed' };

/** Whether this browser can ask for a camera at all. */
export function cameraAvailable(nav: { readonly mediaDevices?: Partial<MediaDevices> }): boolean {
  return typeof nav.mediaDevices?.getUserMedia === 'function';
}

export async function openCamera(port: MediaPort | undefined): Promise<CameraOpen> {
  if (!port) return { kind: 'none' };
  try {
    const stream = await port.getUserMedia({
      video: { facingMode: { ideal: 'environment' } },
      audio: false,
    });
    return { kind: 'ok', stream };
  } catch (error) {
    if (!(error instanceof DOMException)) return { kind: 'failed' };
    switch (error.name) {
      case 'NotAllowedError':
      case 'SecurityError':
        return { kind: 'denied' };
      case 'NotFoundError':
      case 'OverconstrainedError':
        return { kind: 'none' };
      default:
        return { kind: 'failed' };
    }
  }
}

/**
 * Opens the camera and stops every track at once: the page then holds the capture permission while
 * it gathers (D161, D296). A refused, missing or failing camera changes nothing.
 */
export async function holdCamera(port: MediaPort | undefined): Promise<void> {
  const opened = await openCamera(port);
  if (opened.kind !== 'ok') return;
  for (const track of opened.stream.getTracks()) track.stop();
}

/**
 * `gather`, run once the camera was held (D296): the side that shows the first code. The port is
 * read at each call, as the scanner reads it (WebKit replaces `navigator.mediaDevices`).
 */
export function heldCameraFirst<A extends unknown[], R>(
  port: () => MediaPort | undefined,
  gather: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  return async (...args) => {
    await holdCamera(port());
    return gather(...args);
  };
}
