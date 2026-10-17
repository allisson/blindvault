import { beforeAll, describe, expect, it } from 'vitest';

import noiseVectors from '../test-vectors/noise-v1.json' with { type: 'json' };
import { DecryptionError, EncodingError, KeyWipedError } from './errors';
import { type DeviceIdentity, generateDeviceIdentity, loadDeviceIdentity } from './identity';
import { Keyring, privateKeyBytes } from './keys';
import {
  HANDSHAKE_HASH_LENGTH,
  NOISE_MAX_HANDSHAKE_PAYLOAD_LENGTH,
  NOISE_MAX_PLAINTEXT_LENGTH,
  NoiseError,
  type NoiseHandshake,
  type NoisePattern,
  type NoiseResult,
  openNoiseK,
  sealNoiseK,
  startNoise,
  startNoiseXX,
} from './noise';
import { type Dh, createDh } from './noise/dh';
import type { HandshakeState, Split } from './noise/handshake-state';
import { type Noise, bindNoise } from './noise/index';
import { initCrypto, lib } from './sodium';
import { fromHex, toHex, vectors as cryptoVectors } from './test-helpers';

beforeAll(initCrypto);

interface NoiseVector {
  source: string;
  protocol_name: string;
  init_prologue: string;
  init_static: string;
  init_ephemeral: string;
  init_remote_static?: string;
  resp_prologue: string;
  resp_static: string;
  resp_ephemeral?: string;
  resp_remote_static?: string;
  handshake_hash?: string;
  messages: { payload: string; ciphertext: string }[];
}

const vectors: NoiseVector[] = noiseVectors.vectors;

/** A DH whose key pairs are the vector's ephemeral keys, in order. */
function fixedDh(secrets: Uint8Array[]): Dh {
  const real = createDh();
  return {
    ...real,
    generateKeypair(pk, sk) {
      const secret = secrets.shift();
      if (!secret) throw new Error('no ephemeral key left');
      sk.set(secret);
      pk.set(lib().crypto_scalarmult_base(secret));
    },
  };
}

function keyPair(secretHex: string) {
  const secretKey = fromHex(secretHex);
  return { publicKey: lib().crypto_scalarmult_base(secretKey), secretKey };
}

const HANDSHAKE_LENGTH: Record<NoisePattern, number> = { XX: 3, KK: 2, K: 1 };

function patternOf(name: string): NoisePattern {
  const pattern = /^Noise_(XX|KK|K)_25519_ChaChaPoly_BLAKE2b$/.exec(name)?.[1];
  if (!pattern) throw new Error(`unexpected protocol ${name}`);
  return pattern as NoisePattern;
}

describe('official Noise vectors (D157, D200)', () => {
  it('covers XX, KK and K from both cacophony and snow', () => {
    const covered = vectors.map((v) => `${v.source} ${v.protocol_name}`).sort();
    expect(covered).toEqual(
      ['cacophony', 'snow']
        .flatMap((source) =>
          ['K', 'KK', 'XX'].map((p) => `${source} Noise_${p}_25519_ChaChaPoly_BLAKE2b`),
        )
        .sort(),
    );
  });

  it.each(vectors.map((v) => [`${v.source} ${v.protocol_name}`, v] as const))(
    'reproduces %s',
    (_name, v) => {
      const pattern = patternOf(v.protocol_name);
      const initiator = startNoise(
        {
          pattern,
          initiator: true,
          prologue: fromHex(v.init_prologue),
          staticKey: keyPair(v.init_static),
          ...(v.init_remote_static ? { remoteStaticKey: fromHex(v.init_remote_static) } : {}),
        },
        bindNoise(fixedDh([fromHex(v.init_ephemeral)])),
      );
      const responder = startNoise(
        {
          pattern,
          initiator: false,
          prologue: fromHex(v.resp_prologue),
          staticKey: keyPair(v.resp_static),
          ...(v.resp_remote_static ? { remoteStaticKey: fromHex(v.resp_remote_static) } : {}),
        },
        bindNoise(fixedDh(v.resp_ephemeral ? [fromHex(v.resp_ephemeral)] : [])),
      );

      const handshakeLength = HANDSHAKE_LENGTH[pattern];
      const oneWay = pattern === 'K';
      v.messages.forEach((m, i) => {
        const fromInitiator = oneWay || i % 2 === 0;
        const [sender, receiver] = fromInitiator ? [initiator, responder] : [responder, initiator];
        const payload = fromHex(m.payload);
        if (i < handshakeLength) {
          expect(toHex(sender.writeMessage(payload))).toBe(m.ciphertext);
          expect(toHex(receiver.readMessage(fromHex(m.ciphertext)))).toBe(m.payload);
        } else {
          expect(toHex(done(sender).transport.encrypt(payload))).toBe(m.ciphertext);
          expect(toHex(done(receiver).transport.decrypt(fromHex(m.ciphertext)))).toBe(m.payload);
        }
      });

      const i = done(initiator);
      const r = done(responder);
      expect(toHex(i.handshakeHash)).toBe(toHex(r.handshakeHash));
      if (v.handshake_hash) expect(toHex(i.handshakeHash)).toBe(v.handshake_hash);
      expect(toHex(i.remoteStaticKey)).toBe(toHex(keyPair(v.resp_static).publicKey));
      expect(toHex(r.remoteStaticKey)).toBe(toHex(keyPair(v.init_static).publicKey));
    },
  );
});

function done(handshake: NoiseHandshake): NoiseResult {
  const result = handshake.result;
  if (!result) throw new Error('handshake not finished');
  return result;
}

function identities() {
  const keyring = new Keyring();
  return { keyring, a: generateDeviceIdentity(keyring), b: generateDeviceIdentity(keyring) };
}

const prologue = new Uint8Array(32).fill(7);

/** Runs XX between two fresh handshakes, passing each message through `alter`. */
function runXX(
  alter: (index: number, message: Uint8Array) => Uint8Array = (_i, m) => m,
  prologues: [Uint8Array, Uint8Array] = [prologue, prologue],
) {
  const { a, b } = identities();
  const initiator = startNoiseXX({ initiator: true, prologue: prologues[0], identity: a });
  const responder = startNoiseXX({ initiator: false, prologue: prologues[1], identity: b });
  responder.readMessage(alter(0, initiator.writeMessage()));
  initiator.readMessage(alter(1, responder.writeMessage()));
  responder.readMessage(alter(2, initiator.writeMessage()));
  return { a, b, initiator: done(initiator), responder: done(responder) };
}

function failsAt(alter: (index: number, message: Uint8Array) => Uint8Array): void {
  expect(() => runXX(alter)).toThrow(NoiseError);
}

describe('Noise_XX with device identities', () => {
  it('agrees on the handshake hash and authenticates both static keys', () => {
    const { a, b, initiator, responder } = runXX();
    expect(initiator.handshakeHash).toHaveLength(HANDSHAKE_HASH_LENGTH);
    expect(toHex(initiator.handshakeHash)).toBe(toHex(responder.handshakeHash));
    expect(toHex(initiator.remoteStaticKey)).toBe(toHex(b.publicKey));
    expect(toHex(responder.remoteStaticKey)).toBe(toHex(a.publicKey));
  });

  it('gives a new handshake hash to every session between the same devices', () => {
    const { a, b } = identities();
    const hashes = [0, 1].map(() => {
      const i = startNoiseXX({ initiator: true, prologue, identity: a });
      const r = startNoiseXX({ initiator: false, prologue, identity: b });
      r.readMessage(i.writeMessage());
      i.readMessage(r.writeMessage());
      r.readMessage(i.writeMessage());
      return toHex(done(i).handshakeHash);
    });
    expect(hashes[0]).not.toBe(hashes[1]);
  });

  it('sends empty payloads of 32, 96 and 64 bytes', () => {
    const lengths: number[] = [];
    runXX((_i, m) => {
      lengths.push(m.length);
      return m;
    });
    expect(lengths).toEqual([32, 96, 64]);
  });

  it('carries transport messages both ways, in order', () => {
    const { initiator, responder } = runXX();
    const one = initiator.transport.encrypt(Uint8Array.of(1));
    const two = initiator.transport.encrypt(Uint8Array.of(2));
    expect(responder.transport.decrypt(one)).toEqual(Uint8Array.of(1));
    expect(responder.transport.decrypt(two)).toEqual(Uint8Array.of(2));
    const max = new Uint8Array(NOISE_MAX_PLAINTEXT_LENGTH).fill(9);
    expect(initiator.transport.decrypt(responder.transport.encrypt(max))).toEqual(max);
  });

  it('leaves the identity private key usable: the handshake wipes only its own copy', () => {
    const { a, initiator } = runXX();
    expect(initiator.transport.wiped).toBe(false);
    expect(lib().is_zero(privateKeyBytes(a.privateKey))).toBe(false);
  });

  describe('fails, and stays failed', () => {
    it.each([0, 1, 2])('on a byte flipped in message %i', (index) => {
      failsAt((i, m) => {
        if (i !== index) return m;
        const t = m.slice();
        t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1;
        return t;
      });
    });

    it.each([0, 1, 2])('on message %i truncated', (index) => {
      failsAt((i, m) => (i === index ? m.subarray(0, m.length - 1) : m));
    });

    it.each([1, 2])('on message %i one byte longer', (index) => {
      failsAt((i, m) => (i === index ? Uint8Array.from([...m, 0]) : m));
    });

    it('on different prologues, before either side sends its static key in the clear', () => {
      const other = prologue.slice();
      other[0] = 8;
      expect(() => runXX(undefined, [prologue, other])).toThrow(NoiseError);
    });

    it('on a low-order ephemeral key', () => {
      failsAt((i, m) => (i === 0 ? new Uint8Array(32) : m));
    });

    it('on a message from another session', () => {
      const { a, b } = identities();
      const recorded = startNoiseXX({ initiator: true, prologue, identity: a });
      const old = startNoiseXX({ initiator: false, prologue, identity: b });
      old.readMessage(recorded.writeMessage());
      const replayed = old.writeMessage();
      failsAt((i, m) => (i === 1 ? replayed : m));
    });

    it('on messages out of order, and every call after a failure', () => {
      const { a } = identities();
      const initiator = startNoiseXX({ initiator: true, prologue, identity: a });
      initiator.writeMessage();
      expect(() => initiator.writeMessage()).toThrow(NoiseError);
      expect(() => initiator.readMessage(new Uint8Array(96))).toThrow(NoiseError);
      expect(initiator.result).toBeNull();
    });

    it('on a call after the handshake finished', () => {
      const { a, b } = identities();
      const i = startNoiseXX({ initiator: true, prologue, identity: a });
      const r = startNoiseXX({ initiator: false, prologue, identity: b });
      r.readMessage(i.writeMessage());
      i.readMessage(r.writeMessage());
      r.readMessage(i.writeMessage());
      expect(() => i.writeMessage()).toThrow(NoiseError);
      expect(() => r.readMessage(new Uint8Array(64))).toThrow(NoiseError);
    });

    it('on a payload or a message too long', () => {
      const { a, b } = identities();
      const i = startNoiseXX({ initiator: true, prologue, identity: a });
      expect(() => i.writeMessage(new Uint8Array(NOISE_MAX_HANDSHAKE_PAYLOAD_LENGTH + 1))).toThrow(
        NoiseError,
      );
      const r = startNoiseXX({ initiator: false, prologue, identity: b });
      expect(() => r.readMessage(new Uint8Array(65_536))).toThrow(NoiseError);
    });

    it('on a malformed static key or an unknown pattern', () => {
      expect(() =>
        startNoise({
          pattern: 'XX',
          initiator: true,
          prologue,
          staticKey: { publicKey: new Uint8Array(31), secretKey: new Uint8Array(32) },
        }),
      ).toThrow(EncodingError);
      expect(() =>
        startNoise({
          pattern: 'ZZ' as NoisePattern,
          initiator: true,
          prologue,
          staticKey: keyPair('11'.repeat(32)),
        }),
      ).toThrow(NoiseError);
    });

    it('when a pattern needs the remote static key and has none', () => {
      expect(() =>
        startNoise({
          pattern: 'KK',
          initiator: true,
          prologue,
          staticKey: keyPair('11'.repeat(32)),
        }),
      ).toThrow(NoiseError);
    });
  });

  describe('transport', () => {
    it('refuses a tampered, replayed, dropped or truncated message, and then wipes its keys', () => {
      for (const attack of ['tamper', 'replay', 'drop', 'short'] as const) {
        const { initiator, responder } = runXX();
        const first = initiator.transport.encrypt(Uint8Array.of(1));
        const second = initiator.transport.encrypt(Uint8Array.of(2));
        let input = second;
        if (attack === 'tamper') {
          input = first.slice();
          input[0] = (input[0] ?? 0) ^ 1;
        } else if (attack === 'replay') {
          responder.transport.decrypt(first);
          input = first;
        } else if (attack === 'short') {
          input = first.subarray(0, 15);
        }
        expect(() => responder.transport.decrypt(input)).toThrow(DecryptionError);
        expect(responder.transport.wiped).toBe(true);
        expect(() => responder.transport.decrypt(second)).toThrow(KeyWipedError);
        expect(() => responder.transport.encrypt(Uint8Array.of(3))).toThrow(KeyWipedError);
      }
    });

    it('refuses a plaintext above 65,519 bytes and a ciphertext above 65,535', () => {
      const { initiator, responder } = runXX();
      expect(() =>
        initiator.transport.encrypt(new Uint8Array(NOISE_MAX_PLAINTEXT_LENGTH + 1)),
      ).toThrow(EncodingError);
      expect(initiator.transport.wiped).toBe(false);
      expect(() => responder.transport.decrypt(new Uint8Array(65_536))).toThrow(DecryptionError);
    });
  });
});

/** The default algorithms, recording what the handshake would leave in memory. */
function recording() {
  const noise = bindNoise();
  const destroyed: (Uint8Array | null)[][] = [];
  const splits: Split[] = [];
  const keep = (split: Split | undefined) => {
    if (split) splits.push(split);
    return split;
  };
  const writeMessage = (s: HandshakeState, p: Uint8Array, b: Uint8Array) =>
    keep(noise.handshake.writeMessage(s, p, b));
  Object.defineProperty(writeMessage, 'bytes', { get: () => noise.handshake.writeMessage.bytes });
  const readMessage = (s: HandshakeState, m: Uint8Array, b: Uint8Array) =>
    keep(noise.handshake.readMessage(s, m, b));
  Object.defineProperty(readMessage, 'bytes', { get: () => noise.handshake.readMessage.bytes });
  const recorder: Noise = {
    ...noise,
    handshake: {
      ...noise.handshake,
      writeMessage: writeMessage as typeof noise.handshake.writeMessage,
      readMessage: readMessage as typeof noise.handshake.readMessage,
      destroy(state: HandshakeState) {
        destroyed.push([state.symmetricState, state.ssk, state.esk, state.rs, state.re]);
        noise.handshake.destroy(state);
      },
    },
  };
  return { recorder, destroyed, splits };
}

const allZero = (buffers: (Uint8Array | null)[]) =>
  buffers.every((b) => b === null || lib().is_zero(b));

describe('wiping (CRYPTO-INV-010)', () => {
  function pair(noise: Noise) {
    const a = keyPair('11'.repeat(32));
    const b = keyPair('22'.repeat(32));
    const i = startNoise({ pattern: 'XX', initiator: true, prologue, staticKey: a }, noise);
    const r = startNoise({ pattern: 'XX', initiator: false, prologue, staticKey: b }, noise);
    return { i, r };
  }

  it('wipes the handshake state, static key copy included, once the handshake finishes', () => {
    const { recorder, destroyed } = recording();
    const { i, r } = pair(recorder);
    r.readMessage(i.writeMessage());
    i.readMessage(r.writeMessage());
    r.readMessage(i.writeMessage());
    expect(destroyed).toHaveLength(2);
    for (const buffers of destroyed) {
      expect(buffers[1]).not.toBeNull();
      expect(allZero(buffers)).toBe(true);
    }
  });

  it('wipes the handshake state on a failure', () => {
    const { recorder, destroyed } = recording();
    const { i, r } = pair(recorder);
    r.readMessage(i.writeMessage());
    const tampered = r.writeMessage();
    tampered[40] = (tampered[40] ?? 0) ^ 1;
    expect(() => i.readMessage(tampered)).toThrow(NoiseError);
    expect(destroyed).toHaveLength(1);
    expect(allZero(destroyed[0] ?? [])).toBe(true);
  });

  it('wipes both transport keys on wipe()', () => {
    const { recorder, splits } = recording();
    const { i, r } = pair(recorder);
    r.readMessage(i.writeMessage());
    i.readMessage(r.writeMessage());
    r.readMessage(i.writeMessage());
    expect(splits).toHaveLength(2);
    expect(splits.every((s) => !lib().is_zero(s.tx) && !lib().is_zero(s.rx))).toBe(true);
    done(i).transport.wipe();
    done(r).transport.wipe();
    expect(splits.every((s) => lib().is_zero(s.tx) && lib().is_zero(s.rx))).toBe(true);
  });
});

describe('Noise_K, the reconnection payload (sync-protocol.md §4.2, D214)', () => {
  const v = cryptoVectors.transcripts.noiseK;

  function loaded(keyring: Keyring, secretHex: string): DeviceIdentity {
    const secret = fromHex(secretHex);
    return loadDeviceIdentity(keyring, lib().crypto_scalarmult_base(secret), secret);
  }

  function vectorKeys() {
    const keyring = new Keyring();
    return { sender: loaded(keyring, v.senderStatic), receiver: loaded(keyring, v.receiverStatic) };
  }

  it('reproduces the vector with its ephemeral key, and opens it', () => {
    const { sender, receiver } = vectorKeys();
    const message = sealNoiseK(
      {
        identity: sender,
        peerPublicKey: receiver.publicKey,
        prologue: fromHex(v.prologue),
        payload: fromHex(v.payload),
      },
      bindNoise(fixedDh([fromHex(v.ephemeral)])),
    );
    expect(toHex(message)).toBe(v.message);
    const opened = openNoiseK({
      identity: receiver,
      peerPublicKey: sender.publicKey,
      prologue: fromHex(v.prologue),
      message,
    });
    expect(toHex(opened)).toBe(v.payload);
  });

  it('draws a new ephemeral key for each message', () => {
    const { a, b } = identities();
    const options = {
      identity: a,
      peerPublicKey: b.publicKey,
      prologue,
      payload: Uint8Array.of(1),
    };
    const first = sealNoiseK(options);
    const second = sealNoiseK(options);
    expect(toHex(first.subarray(0, 32))).not.toBe(toHex(second.subarray(0, 32)));
    for (const message of [first, second]) {
      expect(openNoiseK({ identity: b, peerPublicKey: a.publicKey, prologue, message })).toEqual(
        Uint8Array.of(1),
      );
    }
  });

  describe('refuses with NoiseError', () => {
    let a: DeviceIdentity, b: DeviceIdentity, c: DeviceIdentity, message: Uint8Array;
    beforeAll(() => {
      const keys = identities();
      ({ a, b } = keys);
      c = generateDeviceIdentity(keys.keyring);
      message = sealNoiseK({
        identity: a,
        peerPublicKey: b.publicKey,
        prologue,
        payload: Uint8Array.of(1),
      });
    });
    const open = (change: Partial<Parameters<typeof openNoiseK>[0]>) => () =>
      openNoiseK({ identity: b, peerPublicKey: a.publicKey, prologue, message, ...change });

    it("a message from another key than the picked peer's", () => {
      expect(open({ peerPublicKey: c.publicKey })).toThrow(NoiseError);
    });

    it('a message to another device', () => {
      expect(open({ identity: c })).toThrow(NoiseError);
    });

    it('a message under another prologue', () => {
      const other = prologue.slice();
      other[0] = 8;
      expect(open({ prologue: other })).toThrow(NoiseError);
    });

    it.each([0, 31, 32, 48])('a message with byte %i changed', (index) => {
      const t = message.slice();
      t[index] = (t[index] ?? 0) ^ 1;
      expect(open({ message: t })).toThrow(NoiseError);
    });

    it('a message truncated, one byte longer, or of a low-order ephemeral key', () => {
      expect(open({ message: message.subarray(0, message.length - 1) })).toThrow(NoiseError);
      expect(open({ message: Uint8Array.from([...message, 0]) })).toThrow(NoiseError);
      const low = message.slice();
      low.fill(0, 0, 32);
      expect(open({ message: low })).toThrow(NoiseError);
    });
  });

  it('refuses a peer key that is not 32 bytes', () => {
    const { a } = identities();
    const peerPublicKey = new Uint8Array(31);
    expect(() =>
      sealNoiseK({ identity: a, peerPublicKey, prologue, payload: Uint8Array.of(1) }),
    ).toThrow(EncodingError);
    expect(() =>
      openNoiseK({ identity: a, peerPublicKey, prologue, message: new Uint8Array(64) }),
    ).toThrow(EncodingError);
  });

  it('wipes the handshake state and both transport keys on each side', () => {
    const { recorder, destroyed, splits } = recording();
    const { a, b } = identities();
    const message = sealNoiseK(
      { identity: a, peerPublicKey: b.publicKey, prologue, payload: Uint8Array.of(1) },
      recorder,
    );
    expect(splits).toHaveLength(1);
    expect(splits.every((s) => lib().is_zero(s.tx) && lib().is_zero(s.rx))).toBe(true);
    expect(destroyed).toHaveLength(1);
    expect(allZero(destroyed[0] ?? [])).toBe(true);
    openNoiseK({ identity: b, peerPublicKey: a.publicKey, prologue, message });
    expect(lib().is_zero(privateKeyBytes(a.privateKey))).toBe(false);
    expect(lib().is_zero(privateKeyBytes(b.privateKey))).toBe(false);
  });
});
