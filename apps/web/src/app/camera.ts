// The camera that scans the other device's QR code (D208). Only video, the back camera preferred;
// the caller stops every track once the text is taken or the screen goes, so the camera is never
// held longer than the scan (D161).

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
