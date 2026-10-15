import {
  type DeviceIdentity,
  Keyring,
  deviceId,
  generateDeviceIdentity,
  initCrypto,
  pairingPrologue,
  startNoiseXX,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  HandshakeError,
  type HandshakeFailure,
  type PairingHandshake,
  pairingHandshake,
} from './handshake';
import { noiseChannel } from './channel';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type Payload, encodePayload } from './payload';
import { PairingSession } from './session';
import { TransportClosedError } from './transport';

beforeAll(initCrypto);

const sessionId = new Uint8Array(16).fill(0x5a);

function payload(role: 'initiator' | 'responder', change: Partial<Payload> = {}): Uint8Array {
  return encodePayload({
    role,
    setup: role === 'initiator' ? 'actpass' : 'active',
    holdsVault: role === 'initiator',
    sessionId,
    fingerprint: new Uint8Array(32).fill(role === 'initiator' ? 0x10 : 0x30),
    ufrag: 'abcd',
    pwd: 'a'.repeat(22),
    candidates: [{ kind: 'host-ipv4', address: Uint8Array.of(192, 168, 1, 2), port: 5000 }],
    formatVersions: [1],
    recordTypes: [1, 2, 3, 4, 5, 6],
    commitment: role === 'initiator' ? new Uint8Array(32).fill(3) : null,
    ...change,
  });
}

const payloadInitiator = payload('initiator');
const payloadResponder = payload('responder');

interface Run {
  initiator: PromiseSettledResult<PairingHandshake>;
  responder: PromiseSettledResult<PairingHandshake>;
}

async function run(
  options: MemoryPairOptions & {
    identities?: [DeviceIdentity, DeviceIdentity];
    responderSees?: [Uint8Array, Uint8Array];
    initiatorSees?: [Uint8Array, Uint8Array];
    beforeStart?: (link: ReturnType<typeof memoryPair>) => void;
  } = {},
): Promise<Run & { a: DeviceIdentity; b: DeviceIdentity }> {
  const keyring = new Keyring();
  const [a, b] = options.identities ?? [
    generateDeviceIdentity(keyring),
    generateDeviceIdentity(keyring),
  ];
  const link = memoryPair(options);
  options.beforeStart?.(link);
  const [pi, pr] = options.initiatorSees ?? [payloadInitiator, payloadResponder];
  const [ri, rr] = options.responderSees ?? [payloadInitiator, payloadResponder];
  const [initiator, responder] = await Promise.allSettled([
    pairingHandshake(link.a, {
      role: 'initiator',
      identity: a,
      payloadInitiator: pi,
      payloadResponder: pr,
    }),
    pairingHandshake(link.b, {
      role: 'responder',
      identity: b,
      payloadInitiator: ri,
      payloadResponder: rr,
    }),
  ]);
  return { initiator, responder, a, b };
}

function value(result: PromiseSettledResult<PairingHandshake>): PairingHandshake {
  if (result.status === 'rejected') throw result.reason;
  return result.value;
}

function failure(result: PromiseSettledResult<PairingHandshake>): HandshakeFailure | 'ok' {
  if (result.status === 'fulfilled') return 'ok';
  if (result.reason instanceof HandshakeError) return result.reason.reason;
  throw result.reason;
}

/** Changes one byte of the `index`th handshake message (0, 1, 2 in the XX order). */
function tamperMessage(index: number): NonNullable<MemoryPairOptions['intercept']> {
  let seen = 0;
  return (_direction, message) => {
    if (seen++ !== index) return [message];
    const t = message.slice();
    t[t.length - 1] = (t[t.length - 1] ?? 0) ^ 1;
    return [t];
  };
}

describe('pairing handshake (pairing-protocol.md §5)', () => {
  it('authenticates both devices, agrees on h and opens the Noise channel', async () => {
    const { initiator, responder, a, b } = await run();
    const i = value(initiator);
    const r = value(responder);
    expect(i.handshakeHash).toHaveLength(64);
    expect(i.handshakeHash).toEqual(r.handshakeHash);
    expect(i.peerPublicKey).toEqual(b.publicKey);
    expect(r.peerPublicKey).toEqual(a.publicKey);
    expect(i.peerDeviceId).toEqual(deviceId(b.publicKey));
    expect(r.peerDeviceId).toEqual(a.deviceId);

    await r.channel.send(Uint8Array.of(1));
    expect(await i.channel.receive()).toEqual(Uint8Array.of(1));
    await i.channel.send(Uint8Array.of(2));
    expect(await r.channel.receive()).toEqual(Uint8Array.of(2));
    i.channel.close();
    expect(await r.channel.closed).toBe('remote');
  });

  it('sends three messages of 32, 96 and 64 bytes, then only channel messages', async () => {
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
      ['a-to-b', 32],
      ['b-to-a', 96],
      ['a-to-b', 64],
      ['a-to-b', 20],
    ]);
  });

  describe('fails, closing the transport', () => {
    // Message 1 is only an ephemeral key in the clear: a changed one is caught when the
    // initiator reads message 2, encrypted under the key it gave.
    it('on a byte changed in message 1 or 2: the initiator refuses message 2, the responder sees the close', async () => {
      for (const index of [0, 1]) {
        const { initiator, responder } = await run({ intercept: tamperMessage(index) });
        expect(failure(initiator)).toBe('invalid');
        expect(failure(responder)).toBe('closed');
      }
    });

    it('on a byte changed in message 3: the responder refuses it and the initiator channel closes', async () => {
      const { initiator, responder } = await run({ intercept: tamperMessage(2) });
      expect(failure(responder)).toBe('invalid');
      expect(await value(initiator).channel.closed).toBe('remote');
    });

    it('on a handshake message with a payload', async () => {
      let seen = 0;
      const { initiator, responder } = await run({
        intercept: (_d, m) => (seen++ === 0 ? [Uint8Array.from([...m, 0])] : [m]),
      });
      expect(failure(responder)).toBe('invalid');
      expect(failure(initiator)).toBe('closed');
    });

    it('on a low-order ephemeral key', async () => {
      let seen = 0;
      const { responder } = await run({
        intercept: (_d, m) => (seen++ === 0 ? [new Uint8Array(32)] : [m]),
      });
      expect(failure(responder)).toBe('invalid');
    });

    it('on a duplicated first message', async () => {
      let seen = 0;
      const { responder } = await run({
        intercept: (_d, m) => (seen++ === 0 ? [m, m] : [m]),
      });
      expect(failure(responder)).toBe('invalid');
    });

    it.each([
      [
        'the responder payload',
        'initiatorSees',
        [payloadInitiator, payload('responder', { holdsVault: true })],
      ],
      [
        'the responder fingerprint',
        'initiatorSees',
        [payloadInitiator, payload('responder', { fingerprint: new Uint8Array(32).fill(0x31) })],
      ],
      [
        'the initiator payload',
        'responderSees',
        [payload('initiator', { commitment: new Uint8Array(32).fill(4) }), payloadResponder],
      ],
      [
        'the initiator fingerprint',
        'responderSees',
        [payload('initiator', { fingerprint: new Uint8Array(32).fill(0x11) }), payloadResponder],
      ],
    ] as const)('when the two sides see different bytes of %s', async (_name, side, seen) => {
      const { initiator, responder } = await run({ [side]: seen });
      expect(failure(initiator)).toBe('invalid');
      expect(failure(responder)).toBe('closed');
    });

    it('when the peer has the same static key', async () => {
      const keyring = new Keyring();
      const same = generateDeviceIdentity(keyring);
      const { initiator, responder } = await run({ identities: [same, same] });
      expect(failure(initiator)).toBe('same-identity');
      expect(failure(responder)).toBe('same-identity');
    });

    it('tells the peer with abort (protocol-error) when it has the same static key', async () => {
      const keyring = new Keyring();
      const same = generateDeviceIdentity(keyring);
      const link = memoryPair();
      // The peer runs the bare Noise_XX, which has no check of its own on the static key.
      const peer = startNoiseXX({
        initiator: false,
        prologue: pairingPrologue(
          payloadInitiator,
          payloadResponder,
          new Uint8Array(32).fill(0x10),
          new Uint8Array(32).fill(0x30),
        ),
        identity: same,
      });
      const refused = pairingHandshake(link.a, {
        role: 'initiator',
        identity: same,
        payloadInitiator,
        payloadResponder,
      }).catch((error: unknown) => error);
      peer.readMessage(await link.b.receive());
      await link.b.send(peer.writeMessage());
      peer.readMessage(await link.b.receive());
      const result = peer.result;
      if (!result) throw new Error('the peer did not finish');
      const session = new PairingSession(noiseChannel(link.b, result.transport));
      expect(await session.ended).toMatchObject({ reason: 'protocol-error', by: 'remote' });
      expect(await refused).toMatchObject({ reason: 'same-identity' });
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

    // §11, D211: the ephemeral keys of the live session change every key of the handshake, so a
    // recorded handshake of the same two devices opens nothing, with the old payloads or new ones.
    describe('on a replay of a recorded session (§11, D211)', () => {
      const newSession = {
        initiator: payload('initiator', { sessionId: new Uint8Array(16).fill(0x6b) }),
        responder: payload('responder', { sessionId: new Uint8Array(16).fill(0x6b) }),
      };

      /** A finished handshake of `a` and `b`, recorded: messages 1 and 3 of I, message 2 of R. */
      async function recorded() {
        const keyring = new Keyring();
        const identities = [generateDeviceIdentity(keyring), generateDeviceIdentity(keyring)] as [
          DeviceIdentity,
          DeviceIdentity,
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
        return { identities, messages: messages.slice(0, 3) };
      }

      it.each([
        ['the old payloads', payloadInitiator, payloadResponder],
        ['new payloads', newSession.initiator, newSession.responder],
      ])('the responder refuses messages 1 and 3 of I, with %s', async (_name, pi, pr) => {
        const { identities, messages } = await recorded();
        const [m1, , m3] = messages;
        const link = memoryPair();
        const responder = pairingHandshake(link.b, {
          role: 'responder',
          identity: identities[1],
          payloadInitiator: pi,
          payloadResponder: pr,
        }).catch((e: unknown) => e);
        await link.a.send(m1 ?? new Uint8Array());
        expect(await link.a.receive()).toHaveLength(96);
        await link.a.send(m3 ?? new Uint8Array());
        expect(await responder).toMatchObject({ reason: 'invalid' });
      });

      it.each([
        ['the old payloads', payloadInitiator, payloadResponder],
        ['new payloads', newSession.initiator, newSession.responder],
      ])('the initiator refuses message 2 of R, with %s', async (_name, pi, pr) => {
        const { identities, messages } = await recorded();
        const [, m2] = messages;
        const link = memoryPair();
        const initiator = pairingHandshake(link.a, {
          role: 'initiator',
          identity: identities[0],
          payloadInitiator: pi,
          payloadResponder: pr,
        }).catch((e: unknown) => e);
        expect(await link.b.receive()).toHaveLength(32);
        await link.b.send(m2 ?? new Uint8Array());
        expect(await initiator).toMatchObject({ reason: 'invalid' });
      });
    });

    it('on payloads of the wrong role or session, before sending anything', async () => {
      const sent: number[] = [];
      const { initiator, responder } = await run({
        initiatorSees: [payloadResponder, payloadResponder],
        responderSees: [payloadInitiator, payload('responder', { sessionId: new Uint8Array(16) })],
        intercept: (_d, m) => {
          sent.push(m.length);
          return [m];
        },
      });
      expect(failure(initiator)).toBe('invalid');
      expect(failure(responder)).toBe('invalid');
      expect(sent).toEqual([]);
    });
  });

  it('reports the closing cause', async () => {
    const link = memoryPair();
    link.a.close();
    const keyring = new Keyring();
    const error = await pairingHandshake(link.b, {
      role: 'responder',
      identity: generateDeviceIdentity(keyring),
      payloadInitiator,
      payloadResponder,
    }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(HandshakeError);
    expect((error as HandshakeError).cause).toBeInstanceOf(TransportClosedError);
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
    await expect(
      pairingHandshake(transport, {
        role: 'initiator',
        identity: generateDeviceIdentity(new Keyring()),
        payloadInitiator,
        payloadResponder,
      }),
    ).rejects.toBeInstanceOf(RangeError);
    expect(closed).toBe(true);
  });
});
