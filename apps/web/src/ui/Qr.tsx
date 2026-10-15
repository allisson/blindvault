import { useEffect, useMemo, useRef, useState } from 'react';

import { type CameraOpen, cameraAvailable, openCamera } from '../app/camera';
import { QUIET_ZONE, qrMatrix, qrPath } from '../app/qr';
import { useMessages } from '../i18n/context';
import { Button } from './components';

// The QR code of a payload and the camera that scans the other device's (D208). The code is an SVG
// built by React, dark on light whatever the theme, so no markup is injected (Trusted Types, D83).

/** A payload's QR code. */
export function QrCode({ text, label }: { readonly text: string; readonly label: string }) {
  const { size, path } = useMemo(() => {
    const matrix = qrMatrix(text);
    return { size: matrix.length + 2 * QUIET_ZONE, path: qrPath(matrix) };
  }, [text]);
  return (
    <svg
      xmlns="http://www.w3.org/2000/svg"
      viewBox={`0 0 ${String(size)} ${String(size)}`}
      shapeRendering="crispEdges"
      role="img"
      aria-label={label}
      className="w-full max-w-72 self-center rounded-md"
      data-testid="pairing-qr"
    >
      <rect width={size} height={size} fill="#fff" />
      <path d={path} fill="#000" />
    </svg>
  );
}

/** How often a frame is read: enough for a held phone, light on the CPU. */
const FRAME_MS = 200;
/** Frames are read at most this wide; the measured codes are version 8 or less (D4). */
const MAX_WIDTH = 640;

type Problem = Exclude<CameraOpen['kind'], 'ok'> | 'reader';

/**
 * "Scan with the camera", then the viewfinder. `onRead` takes each text read and says whether it was
 * taken; a text refused is not offered again while the camera stays open, so its error stays on
 * screen. Every track stops when the scanner closes or unmounts, which a lock or the next stage does.
 */
export function QrScanner({ onRead }: { readonly onRead: (text: string) => Promise<boolean> }) {
  const m = useMessages().pairing;
  const [open, setOpen] = useState(false);
  const [problem, setProblem] = useState<Problem>();
  const [available] = useState(() => cameraAvailable(navigator));
  if (!available || problem === 'none') {
    return <p className="text-sm text-zinc-500">{m.noCamera}</p>;
  }
  return (
    <div className="flex flex-col gap-2">
      {open ? (
        <Viewfinder
          onRead={onRead}
          onProblem={(p) => {
            setProblem(p);
            setOpen(false);
          }}
        />
      ) : null}
      {problem ? (
        <p
          role="alert"
          className="text-sm text-red-700 dark:text-red-400"
          data-testid="scan-problem"
        >
          {problem === 'denied'
            ? m.cameraDenied
            : problem === 'reader'
              ? m.readerFailed
              : m.cameraFailed}
        </p>
      ) : null}
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          setProblem(undefined);
          setOpen(!open);
        }}
        data-testid={open ? 'scan-stop' : 'scan-start'}
      >
        {open ? m.scanStop : m.scan}
      </Button>
    </div>
  );
}

function Viewfinder({
  onRead,
  onProblem,
}: {
  readonly onRead: (text: string) => Promise<boolean>;
  readonly onProblem: (problem: Problem) => void;
}) {
  const m = useMessages().pairing;
  const video = useRef<HTMLVideoElement>(null);
  // The latest callbacks, without restarting the camera when the parent renders again.
  const latest = useRef({ onRead, onProblem });
  latest.current = { onRead, onProblem };
  useEffect(() => {
    // Set to false by `stop`, which a callback may call while another one awaits.
    const state = { live: true };
    // A function, so a check after an await is not narrowed away by the one before it.
    const alive = () => state.live;
    let stream: MediaStream | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const stop = () => {
      state.live = false;
      clearTimeout(timer);
      for (const track of stream?.getTracks() ?? []) track.stop();
    };
    void (async () => {
      const opened = await openCamera(navigator.mediaDevices);
      if (opened.kind !== 'ok') {
        if (alive()) latest.current.onProblem(opened.kind);
        return;
      }
      stream = opened.stream;
      if (!alive() || !video.current) {
        stop();
        return;
      }
      let read: (frame: ImageData) => Promise<string | undefined>;
      try {
        read = (await import('../app/qr-wasm')).readQr;
      } catch {
        stop();
        latest.current.onProblem('reader');
        return;
      }
      const element = video.current;
      element.srcObject = stream;
      await element.play().catch(() => undefined);
      const canvas = document.createElement('canvas');
      const context = canvas.getContext('2d', { willReadFrequently: true });
      let refused: string | undefined;
      const tick = async () => {
        if (!alive()) return;
        if (context && element.videoWidth > 0) {
          const scale = Math.min(1, MAX_WIDTH / element.videoWidth);
          canvas.width = Math.round(element.videoWidth * scale);
          canvas.height = Math.round(element.videoHeight * scale);
          context.drawImage(element, 0, 0, canvas.width, canvas.height);
          let text: string | undefined;
          try {
            text = await read(context.getImageData(0, 0, canvas.width, canvas.height));
          } catch {
            if (alive()) {
              stop();
              latest.current.onProblem('reader');
            }
            return;
          }
          if (!alive()) return;
          if (text !== undefined && text !== refused) {
            if (await latest.current.onRead(text)) {
              stop();
              return;
            }
            refused = text;
          }
        }
        if (alive()) timer = setTimeout(() => void tick(), FRAME_MS);
      };
      void tick();
    })();
    return stop;
  }, []);
  return (
    <div className="flex flex-col gap-1">
      <video
        ref={video}
        muted
        playsInline
        className="w-full max-w-72 self-center rounded-md bg-black"
        data-testid="scan-video"
      />
      <p role="status" className="text-sm">
        {m.scanning}
      </p>
    </div>
  );
}
