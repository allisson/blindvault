import {
  type DeviceIdentity,
  Keyring,
  generateDeviceIdentity,
  initCrypto,
} from '@blindvault/crypto';
import { beforeAll, describe, expect, it } from 'vitest';

import {
  DeliveryClosedError,
  type PayloadDelivery,
  manualDelivery,
  memoryDelivery,
  receiveReconnection,
} from './delivery';
import {
  type Reconnection,
  ReconnectionError,
  type ReconnectionKeys,
  type ReconnectionRejection,
  sealReconnection,
} from './reconnect';

beforeAll(initCrypto);

const vaultId = new Uint8Array(16).fill(0xa0);
const sessionId = new Uint8Array(16).fill(0x40);
let initiator: DeviceIdentity, responder: DeviceIdentity, stranger: DeviceIdentity;
beforeAll(() => {
  const keyring = new Keyring();
  [initiator, responder, stranger] = [1, 2, 3].map(() => generateDeviceIdentity(keyring)) as [
    DeviceIdentity,
    DeviceIdentity,
    DeviceIdentity,
  ];
});

const candidate = {
  kind: 'host-ipv4',
  address: Uint8Array.of(192, 168, 1, 20),
  port: 54321,
} as const;
const offer: Reconnection = {
  role: 'initiator',
  setup: 'actpass',
  sessionId,
  fingerprint: new Uint8Array(32).fill(0x80),
  ufrag: 'Lh7R',
  pwd: 'aB3+/cD4eF5gH6iJ7kL8mN9o',
  candidates: [candidate],
};
const answer: Reconnection = {
  ...offer,
  role: 'responder',
  setup: 'passive',
  fingerprint: new Uint8Array(32).fill(0xa0),
  ufrag: '1a2b3c4d',
};

/** `from` seals to `to`. */
const keys = (from: DeviceIdentity, to: DeviceIdentity): ReconnectionKeys => ({
  identity: from,
  peerPublicKey: to.publicKey,
  vaultId,
});

/** Waits on `delivery` as R for I's offer, collecting the refusals. */
async function waitForOffer(delivery: PayloadDelivery) {
  const refused: ReconnectionRejection[] = [];
  const opened = await receiveReconnection(
    delivery,
    keys(responder, initiator),
    { role: 'initiator' },
    (error) => refused.push(error.reason),
  );
  return { opened, refused };
}

describe('payload delivery (sync-protocol.md §4.4, D215)', () => {
  describe('manual: base45 text by QR code or copy/paste', () => {
    it('shows the text of the payload sent, and opens the text submitted on the other side', async () => {
      const i = manualDelivery();
      const r = manualDelivery();
      expect(i.text).toBeNull();
      await i.send(sealReconnection(offer, keys(initiator, responder)).bytes);
      r.submit(`${(i.text ?? '').slice(0, 30)}\n${(i.text ?? '').slice(30)}`);
      const { opened, refused } = await waitForOffer(r);
      expect(opened?.reconnection).toEqual(offer);
      expect(refused).toEqual([]);
    });

    it('refuses a text that is not base45, or empty, at once, delivering nothing', async () => {
      const r = manualDelivery();
      for (const text of ['bb8', '', '\n']) {
        expect(() => {
          r.submit(text);
        }).toThrow(ReconnectionError);
      }
      r.close();
      expect(await waitForOffer(r)).toEqual({ opened: null, refused: [] });
    });

    it('reports a code that does not open, and keeps waiting for the next one', async () => {
      const i = manualDelivery();
      const r = manualDelivery();
      const other = manualDelivery();
      await other.send(sealReconnection(offer, keys(stranger, responder)).bytes);
      await i.send(sealReconnection(offer, keys(initiator, responder)).bytes);
      r.submit(other.text ?? '');
      r.submit(i.text ?? '');
      const { opened, refused } = await waitForOffer(r);
      expect(refused).toEqual(['not-from-peer']);
      expect(opened?.reconnection).toEqual(offer);
    });

    it('ignores a text once closed, and refuses to send', async () => {
      const r = manualDelivery();
      r.close();
      r.close();
      r.submit('bb8');
      await expect(r.send(Uint8Array.of(1))).rejects.toThrow(DeliveryClosedError);
      expect(r.text).toBeNull();
    });
  });

  describe("a delivery that loses, duplicates, reorders, replays and carries anyone's bytes", () => {
    it('takes the first payload that opens, reporting every other one', async () => {
      const junk = [
        new Uint8Array(0),
        Uint8Array.of(2, 0xff),
        Uint8Array.of(1, 0),
        sealReconnection(offer, keys(stranger, responder)).bytes,
        sealReconnection(offer, {
          ...keys(initiator, responder),
          vaultId: vaultId.map((b) => b ^ 1),
        }).bytes,
        sealReconnection(answer, keys(initiator, responder)).bytes,
      ];
      const pair = memoryDelivery({ intercept: (_d, payload) => [...junk, payload, payload] });
      await pair.a.send(sealReconnection(offer, keys(initiator, responder)).bytes);
      const { opened, refused } = await waitForOffer(pair.b);
      expect(opened?.reconnection).toEqual(offer);
      expect(refused).toEqual([
        'malformed',
        'version',
        'malformed',
        'not-from-peer',
        'not-from-peer',
        'not-from-peer',
      ]);
    });

    it("refuses an answer of an earlier session, replayed, then takes this session's", async () => {
      const old = sealReconnection(
        { ...answer, sessionId: new Uint8Array(16).fill(0x41) },
        keys(responder, initiator),
      );
      let replay = true;
      const pair = memoryDelivery({
        intercept: (_d, payload) => {
          const out = replay ? [old.bytes, payload] : [payload];
          replay = false;
          return out;
        },
      });
      await pair.b.send(sealReconnection(answer, keys(responder, initiator)).bytes);
      const refused: ReconnectionRejection[] = [];
      const opened = await receiveReconnection(
        pair.a,
        keys(initiator, responder),
        { role: 'responder', sessionId },
        (error) => refused.push(error.reason),
      );
      expect(refused).toEqual(['malformed']);
      expect(opened?.reconnection).toEqual(answer);
      expect(opened?.message).not.toEqual(old.message);
    });

    it('returns null when the delivery closes before a payload opens: a lost payload', async () => {
      const pair = memoryDelivery({ intercept: () => [] });
      await pair.a.send(sealReconnection(offer, keys(initiator, responder)).bytes);
      pair.inject('a-to-b', Uint8Array.of(1, 2, 3));
      const waiting = waitForOffer(pair.b);
      setTimeout(() => {
        pair.b.close();
      }, 0);
      expect(await waiting).toEqual({ opened: null, refused: ['malformed'] });
      await expect(pair.b.send(Uint8Array.of(1))).rejects.toThrow(DeliveryClosedError);
      pair.inject('a-to-b', Uint8Array.of(1, 2, 3));
      expect(await waitForOffer(pair.b)).toEqual({ opened: null, refused: [] });
    });

    it('lets an error that is not a payload refusal through', async () => {
      const pair = memoryDelivery();
      await pair.a.send(sealReconnection(offer, keys(initiator, responder)).bytes);
      const bad = { ...keys(responder, initiator), peerPublicKey: new Uint8Array(31) };
      await expect(
        receiveReconnection(pair.b, bad, { role: 'initiator' }, () => undefined),
      ).rejects.not.toThrow(ReconnectionError);
    });
  });
});
