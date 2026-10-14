import { Keyring, generateKey, initCrypto, sameKey } from '@blindvault/crypto';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import { FrameReader } from './frames';
import { type MemoryPairOptions, memoryPair } from './memory';
import { type Message, decodeMessage } from './messages';
import { PairingError, PairingSession } from './session';
import {
  type ReceivedVault,
  type SendVaultOptions,
  TransferRefusal,
  receiveVault,
  sendVault,
} from './transfer';

beforeAll(initCrypto);

const vaultId = new Uint8Array(16).fill(0x22);
const records = [Uint8Array.of(1, 2, 3), new Uint8Array(200_000).fill(4), Uint8Array.of(5)];
const toHex = (bytes: Uint8Array) => Buffer.from(bytes).toString('hex');

async function failure(promise: Promise<unknown>): Promise<[string, string]> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof PairingError) return [error.reason, error.by];
    throw error;
  }
  throw new Error('expected the session to end');
}

/** Decodes the plaintext messages crossing the link, for the order checks. */
function recorder() {
  const log: { direction: string; t: string }[] = [];
  const readers = { 'a-to-b': new FrameReader(), 'b-to-a': new FrameReader() };
  const intercept: MemoryPairOptions['intercept'] = (direction, frame) => {
    const bytes = readers[direction].push(frame.slice());
    if (bytes) log.push({ direction, t: decodeMessage(bytes).t });
    return [frame];
  };
  return { log, intercept };
}

/** A (side a) holds the vault, B (side b) joins, both past their confirmations. */
function pair(options: MemoryPairOptions = {}) {
  const link = memoryPair(options);
  const a = new PairingSession(link.a);
  const b = new PairingSession(link.b);
  const keyringA = new Keyring();
  const masterKey = generateKey(keyringA);
  const keyringB = new Keyring();
  const admitted: string[] = [];
  const completed = vi.fn(() => Promise.resolve());
  const sender = (overrides: Partial<SendVaultOptions> = {}) =>
    sendVault(a, {
      vaultId,
      masterKey,
      admit: (name) => {
        admitted.push(name);
        return Promise.resolve(records);
      },
      completed,
      ...overrides,
    });
  const receiver = () => receiveVault(b, { keyring: keyringB, name: 'Firefox on Linux' });
  return { link, a, b, masterKey, keyringB, admitted, completed, sender, receiver };
}

/** Sends raw messages from side a, as a peer that does not follow §8 would. */
async function sendAll(session: PairingSession, messages: readonly Message[]) {
  for (const message of messages) await session.send(message);
}

describe('Master Key transfer and full transfer (pairing-protocol.md §8, sync-protocol.md §2)', () => {
  it('gives B the Master Key, the vaultId and every record, and A records the commit', async () => {
    const { log, intercept } = recorder();
    const { a, b, masterKey, admitted, completed, sender, receiver } = pair({ intercept });
    const sending = sender();
    const received = await receiver();
    expect(sameKey(received.masterKey, masterKey)).toBe(true);
    expect(received.vaultId).toEqual(vaultId);
    // As hex: `toEqual` walks a `Uint8Array` element by element, slow for the 200 kB record.
    expect(received.records.map(toHex)).toEqual(records.map(toHex));
    expect(admitted).toEqual(['Firefox on Linux']);
    expect(completed).not.toHaveBeenCalled();
    expect(await received.commit(() => Promise.resolve('persisted'))).toBe('persisted');
    await sending;
    expect(completed).toHaveBeenCalledOnce();
    expect(log).toEqual([
      { direction: 'a-to-b', t: 'master-key' },
      { direction: 'b-to-a', t: 'received' },
      { direction: 'a-to-b', t: 'records-begin' },
      { direction: 'a-to-b', t: 'record' },
      { direction: 'a-to-b', t: 'record' },
      { direction: 'a-to-b', t: 'record' },
      { direction: 'a-to-b', t: 'records-end' },
      { direction: 'b-to-a', t: 'committed' },
    ]);
    // The session ends with its last message, with no abort.
    expect(a.error?.reason).toBe('closed');
    expect(b.error?.reason).toBe('closed');
  });

  it('sends no record before B acknowledged the Master Key and A admitted it', async () => {
    const { log, intercept } = recorder();
    const { a, b, sender } = pair({ intercept });
    let admit!: () => void;
    const sending = sender({
      admit: () =>
        new Promise((resolve) => {
          admit = () => {
            resolve(records);
          };
        }),
    });
    expect((await b.receive()).t).toBe('master-key');
    await b.send({ t: 'received', name: 'Firefox on Linux' });
    await vi.waitFor(() => {
      expect(admit).toBeDefined();
    });
    expect(log.map((m) => m.t)).toEqual(['master-key', 'received']);
    admit();
    expect((await b.receive()).t).toBe('records-begin');
    for (let i = 0; i < 4; i++) await b.receive();
    await b.abort('cancelled');
    expect(await failure(sending)).toEqual(['cancelled', 'remote']);
    expect(a.error?.reason).toBe('cancelled');
  });

  it('aborts on B when the first message is not master-key (protocol-error)', async () => {
    const { a, keyringB, receiver } = pair();
    const receiving = receiver();
    await a.send({ t: 'records-begin', count: 0 });
    expect(await failure(receiving)).toEqual(['protocol-error', 'local']);
    expect(await failure(a.receive())).toEqual(['protocol-error', 'remote']);
    expect(keyringB.size).toBe(0);
  });

  it('aborts on A when B answers with anything but received (protocol-error)', async () => {
    const { b, admitted, sender } = pair();
    const sending = sender();
    expect((await b.receive()).t).toBe('master-key');
    await b.send({ t: 'committed' });
    expect(await failure(sending)).toEqual(['protocol-error', 'local']);
    expect(admitted).toEqual([]);
  });

  it.each<[string, Message[]]>([
    ['a record before records-begin', [{ t: 'record', r: Uint8Array.of(1) }]],
    ['records-end before records-begin', [{ t: 'records-end' }]],
    [
      'fewer records than count',
      [
        { t: 'records-begin', count: 2 },
        { t: 'record', r: Uint8Array.of(1) },
        { t: 'records-end' },
      ],
    ],
    [
      'more records than count',
      [
        { t: 'records-begin', count: 1 },
        { t: 'record', r: Uint8Array.of(1) },
        { t: 'record', r: Uint8Array.of(2) },
      ],
    ],
    ['a second master-key', [{ t: 'master-key', mk: new Uint8Array(32), vid: vaultId }]],
    ['committed instead of records-end', [{ t: 'records-begin', count: 0 }, { t: 'committed' }]],
  ])('aborts on B on %s (protocol-error), releasing the Master Key', async (_case, messages) => {
    const { a, keyringB, receiver } = pair();
    const receiving = receiver();
    await a.send({ t: 'master-key', mk: new Uint8Array(32).fill(7), vid: vaultId });
    expect(await a.receive()).toEqual({ t: 'received', name: 'Firefox on Linux' });
    await sendAll(a, messages).catch(() => undefined);
    expect(await failure(receiving)).toEqual(['protocol-error', 'local']);
    expect(keyringB.size).toBe(0);
  });

  it('takes an empty transfer: count 0', async () => {
    const { sender, receiver } = pair();
    const sending = sender({ admit: () => Promise.resolve([]) });
    const received = await receiver();
    expect(received.records).toEqual([]);
    await received.commit(() => Promise.resolve());
    await sending;
  });

  it('aborts with the reason A refused the admission for, and B ends with it', async () => {
    const { completed, keyringB, sender, receiver } = pair();
    const sending = sender({
      admit: () => Promise.reject(new TransferRefusal('verification-failed')),
    });
    const receiving = receiver();
    expect(await failure(sending)).toEqual(['verification-failed', 'local']);
    expect(await failure(receiving)).toEqual(['verification-failed', 'remote']);
    expect(completed).not.toHaveBeenCalled();
    expect(keyringB.size).toBe(0);
  });

  it('aborts with protocol-error when the admission fails for another reason', async () => {
    const { sender, receiver } = pair();
    const cause = new Error('storage failed');
    const sending = sender({ admit: () => Promise.reject(cause) });
    const receiving = receiver();
    const error = await sending.catch((e: unknown) => e);
    expect(error).toBeInstanceOf(PairingError);
    expect((error as PairingError).reason).toBe('protocol-error');
    expect((error as PairingError).cause).toBe(cause);
    expect(await failure(receiving)).toEqual(['protocol-error', 'remote']);
  });

  it('aborts with the reason B refused the transfer for, before committed', async () => {
    const { completed, sender, receiver } = pair();
    const sending = sender();
    const received = await receiver();
    const commit = received.commit(() => Promise.reject(new TransferRefusal('retired-peer')));
    expect(await failure(commit)).toEqual(['retired-peer', 'local']);
    expect(await failure(sending)).toEqual(['retired-peer', 'remote']);
    expect(completed).not.toHaveBeenCalled();
  });

  it('persists nothing on B once the session ended', async () => {
    const { a, sender, receiver } = pair();
    const sending = sender();
    const received: ReceivedVault = await receiver();
    await a.abort('locked');
    await failure(sending);
    await vi.waitFor(() => {
      expect(received.ended).toBe(true);
    });
    const persist = vi.fn(() => Promise.resolve());
    expect(await failure(received.commit(persist))).toEqual(['locked', 'remote']);
    expect(persist).not.toHaveBeenCalled();
  });

  it("ends with the session's own reason when it ended while A admitted B (D93)", async () => {
    const { a, sender, receiver } = pair();
    const sending = sender({
      admit: async () => {
        await a.abort('locked');
        throw new Error('the vault locked');
      },
    });
    const receiving = receiver();
    expect(await failure(sending)).toEqual(['locked', 'local']);
    expect(await failure(receiving)).toEqual(['locked', 'remote']);
  });

  it('passes on a session error raised inside the admission', async () => {
    const { a, link, sender, receiver } = pair();
    const sending = sender({
      admit: async () => {
        link.a.close();
        await a.send({ t: 'confirmed' });
        return records;
      },
    });
    const receiving = receiver();
    expect(await failure(sending)).toEqual(['closed', 'local']);
    expect(await failure(receiving)).toEqual(['closed', 'remote']);
  });

  it("returns B's commit even when committed can no longer be sent (D33)", async () => {
    const { a, completed, sender, receiver } = pair();
    const sending = failure(sender());
    const received = await receiver();
    const result = await received.commit(async () => {
      await a.abort('cancelled');
      await vi.waitFor(() => {
        expect(received.ended).toBe(true);
      });
      return 'persisted';
    });
    expect(result).toBe('persisted');
    expect(await sending).toEqual(['cancelled', 'local']);
    expect(completed).not.toHaveBeenCalled();
  });

  it('commits once only', async () => {
    const { sender, receiver } = pair();
    const sending = sender();
    const received = await receiver();
    await received.commit(() => Promise.resolve());
    await sending;
    await expect(received.commit(() => Promise.resolve())).rejects.toThrow('already');
  });

  it('aborts on A when anything but committed follows the transfer (protocol-error)', async () => {
    const { b, completed, sender } = pair();
    const sending = sender();
    expect((await b.receive()).t).toBe('master-key');
    await b.send({ t: 'received', name: 'Firefox on Linux' });
    for (let i = 0; i < 5; i++) await b.receive();
    await b.send({ t: 'confirmed' });
    expect(await failure(sending)).toEqual(['protocol-error', 'local']);
    expect(completed).not.toHaveBeenCalled();
  });

  it('ends on both sides when the link closes mid-transfer', async () => {
    const { link, sender, receiver, keyringB } = pair();
    const sending = sender({
      admit: () => {
        link.a.close();
        return Promise.resolve(records);
      },
    });
    expect(await failure(receiver())).toEqual(['closed', 'remote']);
    expect(await failure(sending)).toEqual(['closed', 'local']);
    expect(keyringB.size).toBe(0);
  });
});
