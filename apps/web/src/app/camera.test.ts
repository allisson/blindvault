import { describe, expect, it } from 'vitest';

import { type MediaPort, cameraAvailable, openCamera } from './camera';

function failing(name: string): MediaPort {
  return {
    getUserMedia: () => Promise.reject(new DOMException('no', name)),
  };
}

describe('camera for scanning a QR code (D208)', () => {
  it('asks for video only, the back camera preferred, no audio', async () => {
    let asked: MediaStreamConstraints | undefined;
    const stream = {} as MediaStream;
    const port: MediaPort = {
      getUserMedia: (constraints) => {
        asked = constraints;
        return Promise.resolve(stream);
      },
    };
    expect(await openCamera(port)).toEqual({ kind: 'ok', stream });
    expect(asked).toEqual({ video: { facingMode: { ideal: 'environment' } }, audio: false });
  });

  it.each([
    ['NotAllowedError', 'denied'],
    ['SecurityError', 'denied'],
    ['NotFoundError', 'none'],
    ['OverconstrainedError', 'none'],
    ['NotReadableError', 'failed'],
    ['AbortError', 'failed'],
  ])('%s is %s', async (name, kind) => {
    expect(await openCamera(failing(name))).toEqual({ kind });
  });

  it('a non-DOM error is a failure, not a denial', async () => {
    const port: MediaPort = { getUserMedia: () => Promise.reject(new Error('x')) };
    expect(await openCamera(port)).toEqual({ kind: 'failed' });
  });

  it('no media devices, or no getUserMedia: no camera', async () => {
    expect(cameraAvailable({})).toBe(false);
    expect(cameraAvailable({ mediaDevices: {} })).toBe(false);
    expect(
      cameraAvailable({ mediaDevices: { getUserMedia: () => Promise.reject(new Error('x')) } }),
    ).toBe(true);
    expect(await openCamera(undefined)).toEqual({ kind: 'none' });
  });
});
