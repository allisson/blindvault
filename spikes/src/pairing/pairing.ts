import { $, errorText, log, mountResults, record, tracked } from '../common';
import { ALPHABET as BASE45, decode as fromBase45, encode as toBase45 } from './base45';
import { buildSdp, decodePayload, encodePayload, parseSdp, type Payload } from './payload';
import { renderQr, scanQr } from './qr';

const STUN: RTCIceServer[] = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

let pc: RTCPeerConnection | null = null;
let channel: RTCDataChannel | null = null;
let startedAt = 0;
let cameraGranted = false;
let sessionId: Uint8Array = new Uint8Array(0);
let scanAbort: AbortController | null = null;

const lanOnly = () => ($('#lan-only') as HTMLInputElement).checked;
const role = () => ($('#role') as HTMLSelectElement).value as 'A' | 'B';

function newConnection(): RTCPeerConnection {
  pc?.close();
  const conn = new RTCPeerConnection({ iceServers: lanOnly() ? [] : STUN });
  conn.onconnectionstatechange = () => {
    log(`connection: ${conn.connectionState}`);
    record('connectionState', conn.connectionState);
  };
  conn.oniceconnectionstatechange = () => {
    log(`ice: ${conn.iceConnectionState}`);
  };
  conn.ondatachannel = (e) => {
    wireChannel(e.channel);
  };
  pc = conn;
  return conn;
}

async function gathered(conn: RTCPeerConnection): Promise<number> {
  const t0 = performance.now();
  if (conn.iceGatheringState !== 'complete') {
    await new Promise<void>((resolve) => {
      const done = () => {
        if (conn.iceGatheringState === 'complete') resolve();
      };
      conn.addEventListener('icegatheringstatechange', done);
      setTimeout(resolve, 10_000); // some browsers never report complete without STUN
    });
  }
  return Math.round(performance.now() - t0);
}

function showPayload(p: Payload, label: string, gatherMs: number, dropped: string[]): void {
  const bytes = encodePayload(p);
  const text = toBase45(bytes);
  const qr = renderQr($('#qr'), text);
  ($('#outgoing') as HTMLTextAreaElement).value = text;
  $('#outgoing-label').textContent = label;
  const summary = {
    payloadBytes: bytes.length,
    base45Chars: text.length,
    qrVersion: qr.version,
    qrModules: qr.modules,
    gatherMs,
    lanOnly: p.lanOnly,
    cameraGrantedBeforeGather: p.cameraGranted,
    candidates: p.candidates.map((c) => c.kind),
    droppedCandidateLines: dropped.length,
  };
  record(`${label} payload`, summary);
  log(`${label}: ${String(bytes.length)} bytes, ${String(text.length)} chars, QR version ${String(qr.version)}`);
}

function localPayload(conn: RTCPeerConnection, offer: boolean): { payload: Payload; dropped: string[] } {
  const sdp = conn.localDescription?.sdp;
  if (!sdp) throw new Error('no local description');
  const parsed = parseSdp(sdp);
  return {
    payload: {
      version: 1,
      offer,
      setup: parsed.setup,
      lanOnly: lanOnly(),
      cameraGranted,
      sessionId,
      fingerprint: parsed.fingerprint,
      ufrag: parsed.ufrag,
      pwd: parsed.pwd,
      candidates: parsed.candidates,
    },
    dropped: parsed.dropped,
  };
}

async function createOffer(): Promise<void> {
  startedAt = performance.now();
  sessionId = crypto.getRandomValues(new Uint8Array(8));
  const conn = newConnection();
  wireChannel(conn.createDataChannel('spike', { ordered: true }));
  await conn.setLocalDescription(await conn.createOffer());
  const gatherMs = await gathered(conn);
  const { payload, dropped } = localPayload(conn, true);
  showPayload(payload, 'A offer', gatherMs, dropped);
}

// Messaging apps may wrap long text: line breaks and tabs are dropped. An encoded payload never starts
// or ends with a space, so trim() is safe. Failures record what arrived, to compare with the sender's
// base45Chars.
function readIncoming(raw: string, label: string): Payload {
  const text = raw.replace(/[\r\n\t]/g, '').trim();
  try {
    const payload = decodePayload(fromBase45(text));
    log(`${label}: ${String(text.length)} chars received`);
    return payload;
  } catch (e) {
    const outside = [...new Set([...text].filter((ch) => !BASE45.includes(ch)))];
    record(`${label} received`, {
      chars: text.length,
      rawChars: raw.length,
      charsMod3: text.length % 3,
      charsOutsideBase45: outside.map((ch) => `U+${ch.codePointAt(0)?.toString(16).toUpperCase() ?? ''}`),
      head: text.slice(0, 6),
      tail: text.slice(-6),
      error: errorText(e),
    });
    throw e;
  }
}

async function acceptOffer(text: string): Promise<void> {
  startedAt = performance.now();
  const offer = readIncoming(text, 'B offer');
  if (!offer.offer) throw new Error('this is an answer, not an offer');
  sessionId = offer.sessionId;
  const conn = newConnection();
  await conn.setRemoteDescription(buildSdp(offer));
  await conn.setLocalDescription(await conn.createAnswer());
  const gatherMs = await gathered(conn);
  const { payload, dropped } = localPayload(conn, false);
  showPayload(payload, 'B answer', gatherMs, dropped);
}

async function acceptAnswer(text: string): Promise<void> {
  const answer = readIncoming(text, 'A answer');
  if (answer.offer) throw new Error('this is an offer, not an answer');
  if (answer.sessionId.join() !== sessionId.join()) throw new Error('answer is for another session');
  if (!pc) throw new Error('create the offer first');
  await pc.setRemoteDescription(buildSdp(answer));
  log('answer applied, connecting');
}

function wireChannel(dc: RTCDataChannel): void {
  channel = dc;
  dc.onopen = () => {
    void connected();
  };
  dc.onmessage = (e) => {
    const msg = String(e.data);
    if (msg.startsWith('ping:')) dc.send(`pong:${msg.slice(5)}`);
  };
}

async function connected(): Promise<void> {
  const connectMs = Math.round(performance.now() - startedAt);
  log(`data channel open after ${String(connectMs)} ms`);
  const rtts: number[] = [];
  for (let i = 0; i < 5 && channel; i++) {
    const t0 = performance.now();
    const dc = channel;
    await new Promise<void>((resolve) => {
      const onMsg = (e: MessageEvent) => {
        if (String(e.data) === `pong:${String(i)}`) {
          dc.removeEventListener('message', onMsg);
          resolve();
        }
      };
      dc.addEventListener('message', onMsg);
      dc.send(`ping:${String(i)}`);
      setTimeout(resolve, 3000);
    });
    rtts.push(Math.round(performance.now() - t0));
  }
  record('connected', { role: role(), connectMsFromStart: connectMs, rttMs: rtts, selectedPair: await selectedPair() });
}

async function selectedPair(): Promise<unknown> {
  if (!pc) return null;
  const stats = await pc.getStats();
  const all = [...stats.values()] as Record<string, unknown>[];
  const transport = all.find((s) => s.type === 'transport');
  const pair =
    all.find((s) => s.type === 'candidate-pair' && s.id === transport?.selectedCandidatePairId) ??
    all.find((s) => s.type === 'candidate-pair' && s.state === 'succeeded' && s.nominated === true);
  if (!pair) return null;
  const cand = (id: unknown) => {
    const c = all.find((s) => s.id === id);
    if (!c) return null;
    const address = String(c.address ?? c.ip ?? '');
    return {
      candidateType: c.candidateType,
      protocol: c.protocol,
      addressKind: address.endsWith('.local') ? 'mdns' : address.includes(':') ? 'ipv6' : address ? 'ipv4' : 'hidden',
    };
  };
  return { local: cand(pair.localCandidateId), remote: cand(pair.remoteCandidateId) };
}

async function grantCamera(): Promise<void> {
  const stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: false });
  stream.getTracks().forEach((t) => {
    t.stop();
  });
  cameraGranted = true;
  log('camera permission granted (host candidates may now expose IP addresses)');
}

async function scanInto(target: (text: string) => Promise<void>): Promise<void> {
  scanAbort?.abort();
  scanAbort = new AbortController();
  const video = $('#video') as HTMLVideoElement;
  video.hidden = false;
  try {
    const { result: scan, hidden } = await tracked('camera scan', () => scanQr(video, scanAbort!.signal));
    cameraGranted = true;
    record(`scan ${role()}`, { ms: scan.ms, nativeBarcodeDetector: scan.native, pageHiddenDuringScan: hidden });
    log(`scanned ${String(scan.text.length)} chars in ${String(scan.ms)} ms (native detector: ${String(scan.native)})`);
    await target(scan.text);
  } finally {
    video.hidden = true;
  }
}

// The box wins when filled; otherwise the clipboard is read (iOS shows its Paste callout). An empty
// box once reached decodePayload and failed as "payload truncated".
async function incomingText(): Promise<string> {
  const box = $('#incoming') as HTMLTextAreaElement;
  if (box.value.trim() === '') {
    box.value = await navigator.clipboard.readText();
    log(`read ${String(box.value.length)} chars from the clipboard`);
  }
  if (box.value.trim() === '') throw new Error('nothing to use: the paste box and the clipboard are empty');
  return box.value;
}

function run(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((e: unknown) => {
      log(`${name} failed: ${errorText(e)}`);
      record(`error ${name}`, errorText(e));
    });
  };
}

function updateRole(): void {
  const a = role() === 'A';
  $('#a-steps').hidden = !a;
  $('#b-steps').hidden = a;
}

$('#role').addEventListener('change', updateRole);
$('#grant-camera').addEventListener('click', run('grant camera', grantCamera));
$('#create-offer').addEventListener('click', run('create offer', createOffer));
$('#scan-answer').addEventListener('click', run('scan answer', () => scanInto(acceptAnswer)));
$('#paste-answer').addEventListener(
  'click',
  run('paste answer', async () => acceptAnswer(await incomingText())),
);
$('#scan-offer').addEventListener('click', run('scan offer', () => scanInto(acceptOffer)));
$('#paste-offer').addEventListener(
  'click',
  run('paste offer', async () => acceptOffer(await incomingText())),
);
$('#copy-outgoing').addEventListener(
  'click',
  run('copy payload', async () => {
    const text = ($('#outgoing') as HTMLTextAreaElement).value;
    await navigator.clipboard.writeText(text);
    log(`copied ${String(text.length)} chars`);
  }),
);
updateRole();
mountResults('pairing');
