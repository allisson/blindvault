// The Mac side of measure 3 (D281), served by serve.mjs: answers the phone's DataChannel offer,
// echoing "pong:<message>", and shows a QR code of a random nonce for the phone's camera.

import { QUIET_ZONE, qrMatrix } from '../../../apps/web/src/app/qr';

const status = document.getElementById('status')!;
const say = (s: string): void => {
  status.textContent = `${new Date().toLocaleTimeString()} ${s}\n${status.textContent ?? ''}`;
};

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
const nonce = [...crypto.getRandomValues(new Uint8Array(16))].map((b) => ALPHABET[b % 36]).join('');
document.getElementById('nonce')!.textContent = nonce;
await fetch('/nonce', { method: 'POST', body: nonce });

const matrix = qrMatrix(nonce);
const canvas = document.getElementById('qr') as HTMLCanvasElement;
const ctx = canvas.getContext('2d')!;
const size = matrix.length + 2 * QUIET_ZONE;
const scale = Math.floor(canvas.width / size);
ctx.fillStyle = '#fff';
ctx.fillRect(0, 0, canvas.width, canvas.height);
ctx.fillStyle = '#000';
matrix.forEach((row, y) =>
  row.forEach((dark, x) => dark && ctx.fillRect((x + QUIET_ZONE) * scale, (y + QUIET_ZONE) * scale, scale, scale)),
);

let pc: RTCPeerConnection | null = null;
let lastOffer = '';
async function poll(): Promise<void> {
  const r = await fetch('/offer');
  const body = r.status === 200 ? await r.text() : '';
  if (body && body !== lastOffer) {
    lastOffer = body;
    say('offer received');
    pc?.close();
    pc = new RTCPeerConnection({ iceServers: [] });
    pc.ondatachannel = (e) => {
      e.channel.onmessage = (m) => {
        say(`message: ${String(m.data)}`);
        e.channel.send(`pong:${String(m.data)}`);
      };
    };
    pc.onconnectionstatechange = () => say(`connection: ${pc?.connectionState}`);
    await pc.setRemoteDescription(JSON.parse(body));
    await pc.setLocalDescription(await pc.createAnswer());
    await new Promise<void>((resolve) => {
      if (pc!.iceGatheringState === 'complete') resolve();
      pc!.onicegatheringstatechange = () => pc!.iceGatheringState === 'complete' && resolve();
      setTimeout(resolve, 5000);
    });
    await fetch('/answer', { method: 'POST', body: JSON.stringify(pc.localDescription!.toJSON()) });
    say('answer sent');
  }
  setTimeout(() => void poll(), 1000);
}
say('waiting for the phone');
void poll();
