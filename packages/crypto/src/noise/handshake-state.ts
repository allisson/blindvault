// noise-protocol 3.0.2, handshake-state.js (see LICENSE): the Noise HandshakeState and the
// handshake patterns. The pattern table is unchanged; the handshake logic has one fix, `split`
// assigning the CipherStates by role (D200, marked below).
// Deviations: TypeScript, with `HandshakeState` a class; `Uint8Array` instead of `sodium_malloc`,
// and `destroy` wipes with `memzero` instead of `sodium_free`; `assert` from ./assert, and
// `required` where the original let a null key fail with a TypeError; arrays copied with spread
// instead of `clone`; no `keygen`, `seedKeygen` or `createHandshake` in the returned object (the
// identity comes from `identity.ts`); `split` called without `dhlen` and `pklen`; the asserts on
// argument types (`initiator` a boolean, `prologue` and buffers having a length) are TypeScript types.

import { lib } from '../sodium';
import { assert, required } from './assert';
import type { Cipher } from './cipher';
import type { CipherState } from './cipher-state';
import type { Dh } from './dh';
import type { Hash } from './hash';
import type { SymmetricState } from './symmetric-state';

export interface KeyPair {
  readonly publicKey: Uint8Array;
  readonly secretKey: Uint8Array;
}

export interface Split {
  readonly tx: Uint8Array;
  readonly rx: Uint8Array;
}

export interface Algorithms {
  readonly dh: Dh;
  readonly hash: Hash;
  readonly cipher: Cipher;
  readonly symmetricState: SymmetricState;
  readonly cipherState: CipherState;
}

const INITIATOR = Symbol('initiator');
const RESPONDER = Symbol('responder');

const TOK_S = Symbol('s');
const TOK_E = Symbol('e');
const TOK_ES = Symbol('es');
const TOK_SE = Symbol('se');
const TOK_EE = Symbol('ee');
const TOK_SS = Symbol('es');

export class HandshakeState {
  symmetricState: Uint8Array | null;
  role: symbol | null = null;

  spk: Uint8Array | null = null;
  ssk: Uint8Array | null = null;

  epk: Uint8Array | null = null;
  esk: Uint8Array | null = null;

  rs: Uint8Array | null = null;
  re: Uint8Array | null = null;

  messagePatterns: symbol[][] | null = null;

  constructor(statelen: number) {
    this.symmetricState = new Uint8Array(statelen);
  }
}

export function createHandshake({ dh, hash, cipher, symmetricState, cipherState }: Algorithms) {
  const DhResult = new Uint8Array(dh.DHLEN);

  function initialize(
    handshakePattern: string,
    initiator: boolean,
    prologue: Uint8Array,
    s?: KeyPair | null,
    e?: KeyPair | null,
    rs?: Uint8Array | null,
    re?: Uint8Array | null,
  ): HandshakeState {
    assert(Object.keys(PATTERNS).includes(handshakePattern), 'Unsupported handshake pattern');

    assert(
      e == null ? true : e.publicKey.byteLength === dh.PKLEN,
      `e.publicKey must be ${String(dh.PKLEN)} bytes`,
    );
    assert(
      e == null ? true : e.secretKey.byteLength === dh.SKLEN,
      `e.secretKey must be ${String(dh.SKLEN)} bytes`,
    );

    assert(rs == null ? true : rs.byteLength === dh.PKLEN, `rs must be ${String(dh.PKLEN)} bytes`);
    assert(re == null ? true : re.byteLength === dh.PKLEN, `re must be ${String(dh.PKLEN)} bytes`);

    const state = new HandshakeState(symmetricState.STATELEN);
    const ss = required(state.symmetricState);

    const protocolName = Uint8Array.from(
      `Noise_${handshakePattern}_${dh.ALG}_${cipher.ALG}_${hash.ALG}`,
      toCharCode,
    );

    symmetricState.initializeSymmetric(ss, protocolName);
    symmetricState.mixHash(ss, prologue);

    state.role = initiator ? INITIATOR : RESPONDER;

    if (s != null) {
      assert(s.publicKey.byteLength === dh.PKLEN, `s.publicKey must be ${String(dh.PKLEN)} bytes`);
      assert(s.secretKey.byteLength === dh.SKLEN, `s.secretKey must be ${String(dh.SKLEN)} bytes`);

      state.spk = sodiumBufferCopy(s.publicKey);
      state.ssk = sodiumBufferCopy(s.secretKey);
    }

    if (e != null) {
      assert(e.publicKey.byteLength === dh.PKLEN);
      assert(e.secretKey.byteLength === dh.SKLEN);

      state.epk = sodiumBufferCopy(e.publicKey);
      state.esk = sodiumBufferCopy(e.secretKey);
    }

    if (rs != null) {
      assert(rs.byteLength === dh.PKLEN);
      state.rs = sodiumBufferCopy(rs);
    }
    if (re != null) {
      assert(re.byteLength === dh.PKLEN);
      state.re = sodiumBufferCopy(re);
    }

    // hashing
    const pat = PATTERNS[handshakePattern as keyof typeof PATTERNS];

    for (const pattern of pat.premessages.map((p) => [...p])) {
      const patternRole = pattern.shift();

      for (const token of pattern) {
        switch (token) {
          case TOK_E:
            symmetricState.mixHash(ss, required(state.role === patternRole ? state.epk : state.re));
            break;
          case TOK_S:
            symmetricState.mixHash(ss, required(state.role === patternRole ? state.spk : state.rs));
            break;
          default:
            throw new Error('Invalid premessage pattern');
        }
      }
    }

    state.messagePatterns = pat.messagePatterns.map((p) => [...p]);

    assert(
      state.messagePatterns.filter((p) => p[0] === INITIATOR).some((p) => p.includes(TOK_S))
        ? state.spk !== null && state.ssk !== null
        : true, // Default if none is found
      'This handshake pattern requires a static keypair',
    );

    return state;
  }

  function writeMessage(
    state: HandshakeState,
    payload: Uint8Array,
    messageBuffer: Uint8Array,
  ): Split | undefined {
    assert(state instanceof HandshakeState);
    const ss = required(state.symmetricState);

    const mpat = state.messagePatterns?.shift();
    let moffset = 0;

    assert(mpat != null);

    assert(state.role === mpat.shift());

    for (const token of mpat) {
      switch (token) {
        case TOK_E: {
          assert(state.epk == null);
          assert(state.esk == null);

          const epk = new Uint8Array(dh.PKLEN);
          const esk = new Uint8Array(dh.SKLEN);
          state.epk = epk;
          state.esk = esk;

          dh.generateKeypair(epk, esk);

          messageBuffer.set(epk, moffset);
          moffset += epk.byteLength;

          symmetricState.mixHash(ss, epk);

          break;
        }

        case TOK_S: {
          const spk = required(state.spk);
          assert(spk.byteLength === dh.PKLEN);

          symmetricState.encryptAndHash(ss, messageBuffer.subarray(moffset), spk);
          moffset += symmetricState.encryptAndHash.bytesWritten;

          break;
        }

        case TOK_EE:
          dh.dh(DhResult, required(state.esk), required(state.re));
          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_ES:
          if (state.role === INITIATOR) dh.dh(DhResult, required(state.esk), required(state.rs));
          else dh.dh(DhResult, required(state.ssk), required(state.re));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_SE:
          if (state.role === INITIATOR) dh.dh(DhResult, required(state.ssk), required(state.re));
          else dh.dh(DhResult, required(state.esk), required(state.rs));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_SS:
          dh.dh(DhResult, required(state.ssk), required(state.rs));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;

        default:
          throw new Error('Invalid message pattern');
      }
    }

    symmetricState.encryptAndHash(ss, messageBuffer.subarray(moffset), payload);
    moffset += symmetricState.encryptAndHash.bytesWritten;

    writeMessage.bytes = moffset;

    if (state.messagePatterns?.length === 0) {
      const tx = new Uint8Array(cipherState.STATELEN);
      const rx = new Uint8Array(cipherState.STATELEN);
      // BlindVault fix (D200): c1 is the initiator's sending key whoever processes the last
      // message (Noise spec §5.2). The original split by writer and reader, which swaps the keys
      // in patterns of an even number of messages (KK); the official KK vectors catch it.
      if (state.role === INITIATOR) symmetricState.split(ss, tx, rx);
      else symmetricState.split(ss, rx, tx);

      return { tx, rx };
    }
    return undefined;
  }
  writeMessage.bytes = 0;

  function readMessage(
    state: HandshakeState,
    message: Uint8Array,
    payloadBuffer: Uint8Array,
  ): Split | undefined {
    assert(state instanceof HandshakeState);
    const ss = required(state.symmetricState);

    const mpat = state.messagePatterns?.shift();
    let moffset = 0;

    assert(mpat != null);
    assert(mpat.shift() !== state.role);

    for (const token of mpat) {
      switch (token) {
        case TOK_E: {
          assert(state.re == null);
          assert(message.byteLength - moffset >= dh.PKLEN);

          // PKLEN instead of DHLEN since they are different in out case
          const re = new Uint8Array(dh.PKLEN);
          state.re = re;
          re.set(message.subarray(moffset, moffset + dh.PKLEN));
          moffset += dh.PKLEN;

          symmetricState.mixHash(ss, re);

          break;
        }

        case TOK_S: {
          assert(state.rs == null);
          const rs = new Uint8Array(dh.PKLEN);
          state.rs = rs;

          let bytes: number;
          if (symmetricState._hasKey(ss)) {
            bytes = dh.PKLEN + 16;
          } else {
            bytes = dh.PKLEN;
          }

          assert(message.byteLength - moffset >= bytes);

          symmetricState.decryptAndHash(
            ss,
            rs,
            message.subarray(moffset, moffset + bytes), // <- called temp in noise spec
          );

          moffset += symmetricState.decryptAndHash.bytesRead;

          break;
        }
        case TOK_EE:
          dh.dh(DhResult, required(state.esk), required(state.re));
          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_ES:
          if (state.role === INITIATOR) dh.dh(DhResult, required(state.esk), required(state.rs));
          else dh.dh(DhResult, required(state.ssk), required(state.re));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_SE:
          if (state.role === INITIATOR) dh.dh(DhResult, required(state.ssk), required(state.re));
          else dh.dh(DhResult, required(state.esk), required(state.rs));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;
        case TOK_SS:
          dh.dh(DhResult, required(state.ssk), required(state.rs));

          symmetricState.mixKey(ss, DhResult);
          lib().memzero(DhResult);
          break;

        default:
          throw new Error('Invalid message pattern');
      }
    }

    symmetricState.decryptAndHash(ss, payloadBuffer, message.subarray(moffset));

    // How many bytes were written to payload (minus the TAG/MAC)
    readMessage.bytes = symmetricState.decryptAndHash.bytesWritten;

    if (state.messagePatterns?.length === 0) {
      const tx = new Uint8Array(cipherState.STATELEN);
      const rx = new Uint8Array(cipherState.STATELEN);
      // BlindVault fix (D200): c1 is the initiator's sending key whoever processes the last
      // message (Noise spec §5.2). The original split by writer and reader, which swaps the keys
      // in patterns of an even number of messages (KK); the official KK vectors catch it.
      if (state.role === INITIATOR) symmetricState.split(ss, tx, rx);
      else symmetricState.split(ss, rx, tx);

      return { tx, rx };
    }
    return undefined;
  }
  readMessage.bytes = 0;

  return Object.freeze({
    initialize,
    writeMessage,
    readMessage,
    destroy,
    SKLEN: dh.SKLEN,
    PKLEN: dh.PKLEN,
  });
}

export type Handshake = ReturnType<typeof createHandshake>;

// initiator, ->
// responder, <-
const PATTERNS = Object.freeze({
  N: {
    premessages: [[RESPONDER, TOK_S]],
    messagePatterns: [[INITIATOR, TOK_E, TOK_ES]],
  },
  K: {
    premessages: [
      [INITIATOR, TOK_S],
      [RESPONDER, TOK_S],
    ],
    messagePatterns: [[INITIATOR, TOK_E, TOK_ES, TOK_SS]],
  },
  X: {
    premessages: [[RESPONDER, TOK_S]],
    messagePatterns: [[INITIATOR, TOK_E, TOK_ES, TOK_S, TOK_SS]],
  },
  NN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE],
    ],
  },
  KN: {
    premessages: [[INITIATOR, TOK_S]],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE],
    ],
  },
  NK: {
    premessages: [[RESPONDER, TOK_S]],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES],
      [RESPONDER, TOK_E, TOK_EE],
    ],
  },
  KK: {
    premessages: [
      [INITIATOR, TOK_S],
      [RESPONDER, TOK_S],
    ],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_SS],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE],
    ],
  },
  NX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_S, TOK_ES],
    ],
  },
  KX: {
    premessages: [[INITIATOR, TOK_S]],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE, TOK_S, TOK_ES],
    ],
  },
  XN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE],
      [INITIATOR, TOK_S, TOK_SE],
    ],
  },
  IN: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_S],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE],
    ],
  },
  XK: {
    premessages: [[RESPONDER, TOK_S]],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES],
      [RESPONDER, TOK_E, TOK_EE],
      [INITIATOR, TOK_S, TOK_SE],
    ],
  },
  IK: {
    premessages: [[RESPONDER, TOK_S]],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_ES, TOK_S, TOK_SS],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE],
    ],
  },
  XX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E],
      [RESPONDER, TOK_E, TOK_EE, TOK_S, TOK_ES],
      [INITIATOR, TOK_S, TOK_SE],
    ],
  },
  IX: {
    premessages: [],
    messagePatterns: [
      [INITIATOR, TOK_E, TOK_S],
      [RESPONDER, TOK_E, TOK_EE, TOK_SE, TOK_S, TOK_ES],
    ],
  },
} satisfies Record<string, { premessages: symbol[][]; messagePatterns: symbol[][] }>);

function sodiumBufferCopy(src: Uint8Array): Uint8Array {
  const buf = new Uint8Array(src.byteLength);
  buf.set(src);
  return buf;
}

function destroy(state: HandshakeState): void {
  if (state.symmetricState != null) {
    lib().memzero(state.symmetricState);
    state.symmetricState = null;
  }

  state.role = null;

  if (state.spk != null) {
    lib().memzero(state.spk);
    state.spk = null;
  }

  if (state.ssk != null) {
    lib().memzero(state.ssk);
    state.ssk = null;
  }

  if (state.epk != null) {
    lib().memzero(state.epk);
    state.epk = null;
  }

  if (state.esk != null) {
    lib().memzero(state.esk);
    state.esk = null;
  }

  if (state.rs != null) {
    lib().memzero(state.rs);
    state.rs = null;
  }

  if (state.re != null) {
    lib().memzero(state.re);
    state.re = null;
  }

  state.messagePatterns = null;
}

function toCharCode(s: string): number {
  return s.charCodeAt(0);
}
