// The relying party's checks (measures 3 and 4, D281). The first lines run before any other page
// code, so they show whether the MAIN-world override was already installed.
const overrideBeforePage = !String(navigator.credentials.create).includes('[native code]');
const frame = window !== window.top ? 'iframe' : 'top';
const results = { frame, origin: location.origin, overrideBeforePage };
let publicKey = null;
let credentialId = null;

const b64 = (buf) => btoa(String.fromCharCode(...new Uint8Array(buf))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const unb64 = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));

function shape(cred, kind) {
  const out = {
    instanceofPublicKeyCredential: cred instanceof PublicKeyCredential,
    instanceofResponse:
      kind === 'create' ? cred.response instanceof AuthenticatorAttestationResponse : cred.response instanceof AuthenticatorAssertionResponse,
    rawIdIsArrayBuffer: cred.rawId instanceof ArrayBuffer,
  };
  try {
    out.clientExtensionResults = cred.getClientExtensionResults();
  } catch (e) {
    out.clientExtensionResults = `throws: ${e}`;
  }
  try {
    out.toJSONKeys = Object.keys(cred.toJSON());
  } catch (e) {
    out.toJSONKeys = `throws: ${e}`;
  }
  const cd = JSON.parse(new TextDecoder().decode(cred.response.clientDataJSON));
  out.clientData = { type: cd.type, origin: cd.origin, crossOrigin: cd.crossOrigin, topOrigin: cd.topOrigin ?? null };
  return out;
}

function flags(authData) {
  const f = new Uint8Array(authData)[32];
  return { UP: !!(f & 1), UV: !!(f & 4), BE: !!(f & 8), BS: !!(f & 16), AT: !!(f & 64) };
}

// DER ECDSA signature to r ‖ s for WebCrypto.
function raw(der) {
  const d = new Uint8Array(der);
  let i = 2;
  const take = () => {
    const len = d[i + 1];
    let v = d.slice(i + 2, i + 2 + len);
    i += 2 + len;
    while (v.length > 32 && v[0] === 0) v = v.slice(1);
    const out = new Uint8Array(32);
    out.set(v, 32 - v.length);
    return out;
  };
  const r = take();
  const s = take();
  const out = new Uint8Array(64);
  out.set(r);
  out.set(s, 32);
  return out;
}

async function register() {
  try {
    const cred = await navigator.credentials.create({
      publicKey: {
        rp: { id: 'localhost', name: 'Spike RP' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: `spike-${frame}`, displayName: 'Spike' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        extensions: { credProps: true },
      },
    });
    publicKey = cred.response.getPublicKey();
    credentialId = cred.id;
    results.register = { ...shape(cred, 'create'), flags: flags(cred.response.getAuthenticatorData()), algorithm: cred.response.getPublicKeyAlgorithm() };
  } catch (e) {
    results.register = { error: `${e.name}: ${e.message}` };
  }
  show();
}

async function signIn() {
  try {
    const cred = await navigator.credentials.get({
      publicKey: {
        rpId: 'localhost',
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: credentialId ? [{ type: 'public-key', id: unb64(credentialId) }] : [],
      },
    });
    let signatureValid = null;
    if (publicKey) {
      const key = await crypto.subtle.importKey('spki', publicKey, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['verify']);
      const hash = await crypto.subtle.digest('SHA-256', cred.response.clientDataJSON);
      const signed = new Uint8Array([...new Uint8Array(cred.response.authenticatorData), ...new Uint8Array(hash)]);
      signatureValid = await crypto.subtle.verify({ name: 'ECDSA', hash: 'SHA-256' }, key, raw(cred.response.signature), signed);
    }
    results.signIn = { ...shape(cred, 'get'), flags: flags(cred.response.authenticatorData), signatureValid };
  } catch (e) {
    results.signIn = { error: `${e.name}: ${e.message}` };
  }
  show();
}

// A message the page forges to the relay, claiming another origin: the background must log the
// real origin and the claim only as claimedOrigin.
function forge() {
  window.postMessage(
    {
      ch: 'bv-spike',
      dir: 'to-relay',
      id: 999999,
      kind: 'get',
      origin: 'https://bank.example',
      options: { publicKey: { rpId: 'bank.example', challenge: { $b: 'AAAA' } } },
    },
    '*',
  );
  results.forgedSent = true;
  show();
}

function show() {
  document.getElementById('out').textContent = JSON.stringify(results, null, 2);
}

addEventListener('DOMContentLoaded', () => {
  const c = document.getElementById('controls');
  for (const [label, fn] of [
    ['Register', register],
    ['Sign in', signIn],
    ['Forge relay message', forge],
    ['Copy result', () => navigator.clipboard.writeText(JSON.stringify(results, null, 2))],
  ]) {
    const b = document.createElement('button');
    b.textContent = label;
    b.onclick = fn;
    c.append(b, ' ');
  }
  const pre = document.createElement('pre');
  pre.id = 'out';
  pre.style.cssText = 'background:#8881;padding:8px;white-space:pre-wrap';
  c.append(pre);
  show();
});
