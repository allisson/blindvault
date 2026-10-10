import sodium from 'libsodium-wrappers-sumo';

export interface Job {
  opslimit: number;
  memlimit: number;
}

self.onmessage = async (e: MessageEvent<Job>) => {
  try {
    const loadStart = performance.now();
    await sodium.ready;
    const loadMs = Math.round(performance.now() - loadStart);
    const salt = sodium.randombytes_buf(sodium.crypto_pwhash_SALTBYTES);
    const t0 = performance.now();
    sodium.crypto_pwhash(
      32,
      'spike password',
      salt,
      e.data.opslimit,
      e.data.memlimit,
      sodium.crypto_pwhash_ALG_ARGON2ID13,
    );
    self.postMessage({ ok: true, ms: Math.round(performance.now() - t0), loadMs });
  } catch (err) {
    self.postMessage({ ok: false, error: err instanceof Error ? `${err.name}: ${err.message}` : String(err) });
  }
};
