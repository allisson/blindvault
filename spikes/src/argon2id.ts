import { $, log, mountResults, record } from './common';

const MiB = 1024 * 1024;

interface Run {
  memMiB: number;
  opslimit: number;
  ok: boolean;
  ms?: number;
  error?: string;
}

// One fresh worker per run, so a crash or an out-of-memory kill is attributed to that run.
function derive(opslimit: number, memMiB: number): Promise<Run> {
  return new Promise((resolve) => {
    const worker = new Worker(new URL('./argon2id-worker.ts', import.meta.url), { type: 'module' });
    const done = (r: Run) => {
      worker.terminate();
      resolve(r);
    };
    const timeout = setTimeout(() => {
      done({ memMiB, opslimit, ok: false, error: 'timeout after 120 s' });
    }, 120_000);
    worker.onmessage = (e: MessageEvent<{ ok: boolean; ms?: number; error?: string }>) => {
      clearTimeout(timeout);
      done({ memMiB, opslimit, ...e.data });
    };
    worker.onerror = (e) => {
      clearTimeout(timeout);
      done({ memMiB, opslimit, ok: false, error: `worker error: ${e.message || 'crashed'}` });
    };
    worker.postMessage({ opslimit, memlimit: memMiB * MiB });
  });
}

const runs: Run[] = [];

async function matrix(memories: number[], opsList: number[] = [2, 3]): Promise<void> {
  for (const memMiB of memories) {
    for (const ops of opsList) {
      for (let i = 0; i < 3; i++) {
        log(`running ${String(memMiB)} MiB, ops ${String(ops)}, #${String(i + 1)}`);
        const r = await derive(ops, memMiB);
        runs.push(r);
        log(r.ok ? `  ${String(r.ms)} ms` : `  failed: ${String(r.error)}`);
        record('runs', runs);
        if (!r.ok) break;
      }
    }
  }
}

async function calibrate(): Promise<void> {
  const steps: Run[] = [];
  let ops = 2;
  for (; ops <= 64; ops++) {
    const r = await derive(ops, 64);
    steps.push(r);
    log(`calibrate ops ${String(ops)}: ${r.ok ? `${String(r.ms)} ms` : String(r.error)}`);
    if (!r.ok || (r.ms ?? 0) >= 1000) break;
  }
  record('calibration64MiB', { opsReaching1s: ops > 64 ? null : ops, steps });
}

function button(id: string, fn: () => Promise<void>): void {
  $(id).addEventListener('click', () => {
    const b = $(id) as HTMLButtonElement;
    b.disabled = true;
    fn().finally(() => {
      b.disabled = false;
    });
  });
}

button('#run-matrix', () => matrix([64, 128, 256]));
button('#run-calibrate', calibrate);
// D126: libsodium's SENSITIVE limits are 1 GiB at opslimit 4.
button('#run-1gib', () => matrix([1024], [4]));
record('hardwareConcurrency', navigator.hardwareConcurrency);
record('deviceMemoryGiB', (navigator as Navigator & { deviceMemory?: number }).deviceMemory ?? null);
mountResults('argon2id');
