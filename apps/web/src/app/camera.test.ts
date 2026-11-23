import { describe, expect, it } from 'vitest';

import { type MediaPort, cameraAvailable, heldCameraFirst, holdCamera, openCamera } from './camera';

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

function track(): MediaStreamTrack & { stopped: boolean } {
  const t = {
    stopped: false,
    stop() {
      t.stopped = true;
    },
  };
  return t as unknown as MediaStreamTrack & { stopped: boolean };
}

function streamOf(...tracks: MediaStreamTrack[]): MediaStream {
  return { getTracks: () => tracks } as unknown as MediaStream;
}

describe('the camera held before gathering (D161, D296)', () => {
  it('opens the camera and stops every track at once', async () => {
    const tracks = [track(), track()];
    let asked = 0;
    const port: MediaPort = {
      getUserMedia: () => {
        asked++;
        return Promise.resolve(streamOf(...tracks));
      },
    };
    await holdCamera(port);
    expect(asked).toBe(1);
    expect(tracks.map((t) => t.stopped)).toEqual([true, true]);
  });

  it.each(['NotAllowedError', 'NotFoundError', 'NotReadableError'])(
    'a %s changes nothing: it resolves',
    async (name) => {
      await expect(holdCamera(failing(name))).resolves.toBeUndefined();
    },
  );

  it('a non-DOM error or no camera API resolves too', async () => {
    await expect(
      holdCamera({ getUserMedia: () => Promise.reject(new Error('x')) }),
    ).resolves.toBeUndefined();
    await expect(holdCamera(undefined)).resolves.toBeUndefined();
  });

  it('gathers only once the camera was held and released', async () => {
    const order: string[] = [];
    const t = track();
    const port: MediaPort = {
      getUserMedia: () => {
        order.push('camera');
        return Promise.resolve(streamOf(t));
      },
    };
    const gather = heldCameraFirst(
      () => port,
      (x: number, y: string) => {
        order.push(t.stopped ? 'gather, camera stopped' : 'gather, camera live');
        return Promise.resolve(`${String(x)}${y}`);
      },
    );
    expect(await gather(1, 'a')).toBe('1a');
    expect(order).toEqual(['camera', 'gather, camera stopped']);
  });

  it('still gathers when the camera is refused', async () => {
    let gathered = false;
    const gather = heldCameraFirst(
      () => failing('NotAllowedError'),
      () => {
        gathered = true;
        return Promise.resolve();
      },
    );
    await gather();
    expect(gathered).toBe(true);
  });
});
