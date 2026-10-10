import { $, errorText, log, mountResults, record, tracked } from './common';

// WebAuthn PRF support (§5.5, D75, D84, D120). The credential is a throwaway for this origin.

const STORE = 'spike-prf-credential';
const prfInput = new Uint8Array(32).fill(7);

function flags(authData: ArrayBuffer): Record<string, boolean> {
  const f = new Uint8Array(authData)[32] ?? 0;
  return { UP: (f & 1) !== 0, UV: (f & 4) !== 0, BE: (f & 8) !== 0, BS: (f & 16) !== 0 };
}

function b64url(b: ArrayBuffer): string {
  return btoa(String.fromCharCode(...new Uint8Array(b)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

function fromB64url(s: string): Uint8Array<ArrayBuffer> {
  const bin = atob(s.replace(/-/g, '+').replace(/_/g, '/'));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function capabilities(): Promise<void> {
  const PKC = PublicKeyCredential as unknown as {
    getClientCapabilities?: () => Promise<Record<string, boolean>>;
    isUserVerifyingPlatformAuthenticatorAvailable(): Promise<boolean>;
    signalUnknownCredential?: unknown;
  };
  record('capabilities', {
    platformAuthenticator: await PKC.isUserVerifyingPlatformAuthenticatorAvailable(),
    clientCapabilities: PKC.getClientCapabilities ? await PKC.getClientCapabilities() : 'not supported',
    signalUnknownCredential: typeof PKC.signalUnknownCredential === 'function',
  });
}

async function create(): Promise<void> {
  const { result: cred, hidden } = await tracked('WebAuthn create', async () =>
    (await navigator.credentials.create({
      publicKey: {
        rp: { name: 'BlindVault spike' },
        user: { id: crypto.getRandomValues(new Uint8Array(16)), name: 'spike', displayName: 'BlindVault spike' },
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 },
          { type: 'public-key', alg: -257 },
        ],
        authenticatorSelection: { userVerification: 'required', residentKey: 'preferred' },
        extensions: { prf: { eval: { first: prfInput } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential,
  );
  const response = cred.response as AuthenticatorAttestationResponse;
  const ext = cred.getClientExtensionResults() as { prf?: { enabled?: boolean; results?: { first?: ArrayBuffer } } };
  localStorage.setItem(STORE, b64url(cred.rawId));
  record('create', {
    pageHidden: hidden,
    authenticatorAttachment: cred.authenticatorAttachment,
    flags: flags(response.getAuthenticatorData()),
    prfEnabled: ext.prf?.enabled ?? null,
    prfResultAtCreate: ext.prf?.results?.first ? ext.prf.results.first.byteLength : null,
  });
  log(`created; PRF enabled: ${String(ext.prf?.enabled)}`);
}

async function assertPrf(): Promise<void> {
  const id = localStorage.getItem(STORE);
  const { result: cred, hidden } = await tracked('WebAuthn get', async () =>
    (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        userVerification: 'required',
        ...(id ? { allowCredentials: [{ type: 'public-key' as const, id: fromB64url(id) }] } : {}),
        extensions: { prf: { eval: { first: prfInput } } } as AuthenticationExtensionsClientInputs,
      },
    })) as PublicKeyCredential,
  );
  const response = cred.response as AuthenticatorAssertionResponse;
  const ext = cred.getClientExtensionResults() as { prf?: { results?: { first?: ArrayBuffer } } };
  const first = ext.prf?.results?.first;
  const previous = sessionStorage.getItem('spike-prf-output');
  const now = first ? b64url(first) : null;
  if (now) sessionStorage.setItem('spike-prf-output', now);
  record('get', {
    pageHidden: hidden,
    flags: flags(response.authenticatorData),
    prfOutputBytes: first ? first.byteLength : null,
    sameOutputAsPreviousGet: previous && now ? previous === now : null,
  });
  log(`assertion; PRF output: ${first ? `${String(first.byteLength)} bytes` : 'none'}`);
}

function run(name: string, fn: () => Promise<void>): () => void {
  return () => {
    fn().catch((e: unknown) => {
      log(`${name} failed: ${errorText(e)}`);
      record(`error ${name}`, errorText(e));
    });
  };
}

$('#create').addEventListener('click', run('create', create));
$('#get').addEventListener('click', run('get', assertPrf));
mountResults('prf');
void capabilities();
