// The sync handshake of `sync-protocol.md` §5 (CRYPTO-INV-008, D217): Noise_KK between two
// registered devices over the in-memory transport, each holding the other's public key from its
// Device record, under `prologue_KK` over both reconnection payloads and both DTLS fingerprints.

import {
  type DeviceIdentity,
  Keyring,
  generateDeviceIdentity,
  initCrypto,
  startNoiseKK,
  syncPrologue,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import { HandshakeError, type HandshakeFailure } from './handshake';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type SessionPayload, type SyncHandshake, syncHandshake } from './sync-handshake';
import { TransportClosedError } from './transport';

beforeAll(initCrypto);

/** Stands for a reconnection payload: its `Noise_K` message `m` and the fingerprint it carries. */
function sent(fill: number): SessionPayload {
  return {
    message: new Uint8Array(140).fill(fill),
    fingerprint: new Uint8Array(32).fill(fill + 1),
  };
}

const payloadInitiator = sent(0x10);
const payloadResponder = sent(0x30);

type Sees = [SessionPayload, SessionPayload];

async function run(
  options: MemoryPairOptions & {
    identities?: [DeviceIdentity, DeviceIdentity];
    /** The public key each side holds for its peer, when not the peer's own. */
    initiatorHolds?: Uint8Array;
    responderHolds?: Uint8Array;
    initiatorSees?: Sees;
    responderSees?: Sees;
    beforeStart?: (link: ReturnType<typeof memoryPair>) => void;
  } = {},
) {
  const keyring = new Keyring();
  const [a, b] = options.identities ?? [
    generateDeviceIdentity(keyring),
    generateDeviceIdentity(keyring),
  ];
  const link = memoryPair(options);
  options.beforeStart?.(link);
  const [ii, ir] = options.initiatorSees ?? [payloadInitiator, payloadResponder];
  const [ri, rr] = options.responderSees ?? [payloadInitiator, payloadResponder];
  const [initiator, responder] = await Promise.allSettled([
    syncHandshake(link.a, {
      role: 'initiator',
      identity: a,
      peerPublicKey: options.initiatorHolds ?? b.publicKey,
      initiator: ii,
      responder: ir,
    }),
    syncHandshake(link.b, {
      role: 'responder',
      identity: b,
      peerPublicKey: options.responderHolds ?? a.publicKey,
      initiator: ri,
      responder: rr,
    }),
  ]);
  return { initiator, responder, a, b, keyring, link };
}

function value(result: PromiseSettledResult<SyncHandshake>): SyncHandshake {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

function failure(result: PromiseSettledResult<SyncHandshake>): HandshakeFailure | 'ok' {
  if (result.status === 'fulfilled') return 'ok';
  if (result.reason instanceof HandshakeError) return result.reason.reason;
  throw result.reason;
}

function tamperMessage(index: number): NonNullable<MemoryPairOptions['intercept']> {
  let seen = 0;
  return (_direction, message) => {
    if (seen++ !== index) return [message];
    const t = message.slice();
    t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1;
    return [t];
  };
}

describe('sync handshake (sync-protocol.md §5, CRYPTO-INV-008, D217)', () => {
  it('authenticates both registered devices, agrees on h and opens the Noise channel', async () => {
    const { initiator, responder } = await run();
    const i = value(initiator);
    const r = value(responder);
    expect(i.handshakeHash).toHaveLength(64);
    expect(i.handshakeHash).toEqual(r.handshakeHash);
    await r.channel.send(Uint8Array.of(1));
    expect(await i.channel.receive()).toEqual(Uint8Array.of(1));
    await i.channel.send(Uint8Array.of(2));
    expect(await r.channel.receive()).toEqual(Uint8Array.of(2));
    i.channel.close();
    expect(await r.channel.closed).toBe('remote');
  });

  it('sends two empty handshake messages of 48 bytes, then only channel messages', async () => {
    const lengths: [string, number][] = [];
    const { initiator, responder } = await run({
      intercept: (direction, message) => {
        lengths.push([direction, message.length]);
        return [message];
      },
    });
    await value(initiator).channel.send(new Uint8Array(4));
    await value(responder).channel.receive();
    expect(lengths).toEqual([
      ['a-to-b', 48],
      ['b-to-a', 48],
      ['a-to-b', 20],
    ]);
  });

  it('gives a new handshake hash to every session between the same devices', async () => {
    const keyring = new Keyring();
    const identities: [DeviceIdentity, DeviceIdentity] = [
      generateDeviceIdentity(keyring),
      generateDeviceIdentity(keyring),
    ];
    const first = await run({ identities });
    const second = await run({ identities });
    expect(value(first.initiator).handshakeHash).not.toEqual(value(second.initiator).handshakeHash);
  });

  describe('fails, closing the transport, with nothing but the handshake sent', () => {
    it('when the responder is not the device whose key the initiator holds', async () => {
      const sentLengths: number[] = [];
      const { initiator, responder, keyring } = await run({
        initiatorHolds: generateDeviceIdentity(new Keyring()).publicKey,
        intercept: (_d, m) => {
          sentLengths.push(m.length);
          return [m];
        },
      });
      keyring.wipeAll();
      expect(failure(responder)).toBe('invalid');
      expect(failure(initiator)).toBe('closed');
      expect(sentLengths).toEqual([48]);
    });

    it('when the initiator is not the device whose key the responder holds', async () => {
      const { initiator, responder } = await run({
        responderHolds: generateDeviceIdentity(new Keyring()).publicKey,
      });
      expect(failure(responder)).toBe('invalid');
      expect(failure(initiator)).toBe('closed');
    });

    it('when a third device holds both registered public keys, but neither private key', async () => {
      const keyring = new Keyring();
      const [a, b, c] = [0, 1, 2].map(() => generateDeviceIdentity(keyring)) as [
        DeviceIdentity,
        DeviceIdentity,
        DeviceIdentity,
      ];
      // C plays I to B, presenting itself with A's public key.
      const asI = await run({
        identities: [c, b],
        initiatorHolds: b.publicKey,
        responderHolds: a.publicKey,
      });
      expect(failure(asI.responder)).toBe('invalid');
      expect(failure(asI.initiator)).toBe('closed');
      // C plays R to A, presenting itself with B's public key.
      const asR = await run({
        identities: [a, c],
        initiatorHolds: b.publicKey,
        responderHolds: a.publicKey,
      });
      expect(failure(asR.responder)).toBe('invalid');
      expect(failure(asR.initiator)).toBe('closed');
    });

    it.each([
      ["the initiator's m", 'responderSees', [sent(0x11), payloadResponder]],
      ["the responder's m", 'responderSees', [payloadInitiator, sent(0x31)]],
      [
        "the initiator's fingerprint",
        'initiatorSees',
        [{ ...payloadInitiator, fingerprint: new Uint8Array(32) }, payloadResponder],
      ],
      [
        "the responder's fingerprint",
        'initiatorSees',
        [payloadInitiator, { ...payloadResponder, fingerprint: new Uint8Array(32) }],
      ],
      ['both payloads in swapped roles', 'responderSees', [payloadResponder, payloadInitiator]],
    ] as const)('when the two sides bind different bytes of %s', async (_name, side, seen) => {
      const { initiator, responder } = await run({ [side]: seen });
      expect(failure(responder)).toBe('invalid');
      expect(failure(initiator)).toBe('closed');
    });

    it('on a byte changed in message 1: the responder refuses it', async () => {
      const { initiator, responder } = await run({ intercept: tamperMessage(0) });
      expect(failure(responder)).toBe('invalid');
      expect(failure(initiator)).toBe('closed');
    });

    it('on a byte changed in message 2: the initiator refuses it, and the responder channel closes', async () => {
      const { initiator, responder } = await run({ intercept: tamperMessage(1) });
      expect(failure(initiator)).toBe('invalid');
      expect(await value(responder).channel.closed).toBe('remote');
    });

    it('on a handshake message truncated, or with a payload', async () => {
      for (const change of [
        (m: Uint8Array) => m.subarray(0, m.length - 1),
        (m: Uint8Array) => Uint8Array.from([...m, 0]),
      ]) {
        let seen = 0;
        const { responder } = await run({
          intercept: (_d, m) => (seen++ === 0 ? [change(m)] : [m]),
        });
        expect(failure(responder)).toBe('invalid');
      }
    });

    it('on a handshake message that decrypts but carries a payload', async () => {
      const keyring = new Keyring();
      const [a, b] = [generateDeviceIdentity(keyring), generateDeviceIdentity(keyring)];
      const link = memoryPair();
      const peer = startNoiseKK({
        initiator: true,
        identity: a,
        peerPublicKey: b.publicKey,
        prologue: syncPrologue(
          payloadInitiator.message,
          payloadResponder.message,
          payloadInitiator.fingerprint,
          payloadResponder.fingerprint,
        ),
      });
      const responder = syncHandshake(link.b, {
        role: 'responder',
        identity: b,
        peerPublicKey: a.publicKey,
        initiator: payloadInitiator,
        responder: payloadResponder,
      }).catch((e: unknown) => e);
      await link.a.send(peer.writeMessage(Uint8Array.of(1)));
      expect(await responder).toMatchObject({ reason: 'invalid' });
      expect(await link.a.closed).toBe('remote');
      peer.destroy();
    });

    it('on a duplicated first message', async () => {
      let seen = 0;
      const { responder } = await run({ intercept: (_d, m) => (seen++ === 0 ? [m, m] : [m]) });
      // The duplicate arrives as the first channel message, and fails decryption.
      expect(await value(responder).channel.closed).toBe('error');
    });

    it('when the link breaks or the transport closes during the handshake', async () => {
      const broken = await run({
        beforeStart: (link) => {
          link.breakLink();
        },
      });
      expect(failure(broken.initiator)).toBe('closed');
      expect(failure(broken.responder)).toBe('closed');
      const closed = await run({
        beforeStart: (link) => {
          link.b.close();
        },
      });
      expect(failure(closed.initiator)).toBe('closed');
      expect(failure(closed.responder)).toBe('closed');
    });

    // §12, D17: `prologue_KK` binds both payloads of the live session, so a recorded handshake of
    // the same two devices fails against a new session.
    describe('on a replay of a recorded session (§12)', () => {
      async function recorded() {
        const keyring = new Keyring();
        const identities: [DeviceIdentity, DeviceIdentity] = [
          generateDeviceIdentity(keyring),
          generateDeviceIdentity(keyring),
        ];
        const messages: Uint8Array[] = [];
        const old = await run({
          identities,
          intercept: (_d, m) => {
            messages.push(m.slice());
            return [m];
          },
        });
        value(old.initiator).channel.close();
        value(old.responder).channel.close();
        return { identities, messages };
      }
      const live = { initiator: sent(0x50), responder: sent(0x60) };

      it("the responder refuses I's message 1 against new payloads", async () => {
        const { identities, messages } = await recorded();
        const link = memoryPair();
        const responder = syncHandshake(link.b, {
          role: 'responder',
          identity: identities[1],
          peerPublicKey: identities[0].publicKey,
          ...live,
        }).catch((e: unknown) => e);
        await link.a.send(messages[0] ?? new Uint8Array());
        expect(await responder).toMatchObject({ reason: 'invalid' });
      });

      it("the initiator refuses R's message 2 against new payloads", async () => {
        const { identities, messages } = await recorded();
        const link = memoryPair();
        const initiator = syncHandshake(link.a, {
          role: 'initiator',
          identity: identities[0],
          peerPublicKey: identities[1].publicKey,
          ...live,
        }).catch((e: unknown) => e);
        expect(await link.b.receive()).toHaveLength(48);
        await link.b.send(messages[1] ?? new Uint8Array());
        expect(await initiator).toMatchObject({ reason: 'invalid' });
      });

      // KK's first message is replayable under the same prologue (Noise §7.7): the responder
      // answers, but whoever replays it lacks I's ephemeral key, so the channel carries nothing
      // either way. The old payloads' DTLS certificates keep such a replay off a live link (§12).
      it("the responder's channel opens nothing from a replay with the old payloads", async () => {
        const { identities, messages } = await recorded();
        const link = memoryPair();
        const responder = syncHandshake(link.b, {
          role: 'responder',
          identity: identities[1],
          peerPublicKey: identities[0].publicKey,
          initiator: payloadInitiator,
          responder: payloadResponder,
        });
        await link.a.send(messages[0] ?? new Uint8Array());
        expect(await link.a.receive()).toHaveLength(48);
        const r = await responder;
        await link.a.send(messages[2] ?? new Uint8Array(20));
        expect(await r.channel.closed).toBe('error');
      });
    });
  });

  it('reports the closing cause', async () => {
    const link = memoryPair();
    link.a.close();
    const keyring = new Keyring();
    const error = await syncHandshake(link.b, {
      role: 'responder',
      identity: generateDeviceIdentity(keyring),
      peerPublicKey: generateDeviceIdentity(keyring).publicKey,
      initiator: payloadInitiator,
      responder: payloadResponder,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandshakeError);
    expect((error as HandshakeError).cause).toBeInstanceOf(TransportClosedError);
  });

  it('refuses a malformed fingerprint or peer key before sending anything', async () => {
    const keyring = new Keyring();
    const identity = generateDeviceIdentity(keyring);
    for (const change of [
      { initiator: { ...payloadInitiator, fingerprint: new Uint8Array(31) } },
      { peerPublicKey: new Uint8Array(31) },
    ]) {
      const link = memoryPair();
      const error = await syncHandshake(link.a, {
        role: 'initiator',
        identity,
        peerPublicKey: generateDeviceIdentity(keyring).publicKey,
        initiator: payloadInitiator,
        responder: payloadResponder,
        ...change,
      }).catch((e: unknown) => e);
      expect(error).toMatchObject({ reason: 'invalid' });
      expect(await link.b.closed).toBe('remote');
    }
  });

  it('closes the transport and rethrows an unexpected error', async () => {
    const link = memoryPair();
    let closed = false;
    const transport = {
      ...link.a,
      send: () => Promise.reject(new RangeError('unexpected')),
      close: () => {
        closed = true;
      },
    };
    const keyring = new Keyring();
    await expect(
      syncHandshake(transport, {
        role: 'initiator',
        identity: generateDeviceIdentity(keyring),
        peerPublicKey: generateDeviceIdentity(keyring).publicKey,
        initiator: payloadInitiator,
        responder: payloadResponder,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(closed).toBe(true);
  });
});
