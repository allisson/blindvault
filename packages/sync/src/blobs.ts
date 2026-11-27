// The blob phase of `sync-protocol.md` §10.1 (D278, D279), shared by the live sync session, the
// pairing and the re-admission. A device asks for the blobs its records cite and it lacks, each ID
// once per session, and answers every ID the peer asks for, in the order asked, with a unit of
// `blob-begin`, the `blob-chunk`s and `blob-end`, or with `blob-missing`. A received blob is checked
// against its `blobId` once whole: one that matches is written, one that does not is reported, and
// the session goes on. Anything out of the order of §10.1 aborts (`protocol-error`). This package
// never sees the vault: the blobs are read, written and reported through a `BlobStore` the app
// wires to the vault session.

import { BLOB_ID_LENGTH, blobMatches } from '@blindvault/crypto';

import { BLOB_CHUNK_LENGTH, type BlobMessage, MAX_BLOB_IDS, isBlobMessage } from './blob-messages';

/** What the blob phase needs of the vault. A callback that throws aborts as `protocol-error`. */
export interface BlobStore {
  /**
   * The `blobId`s this device lacks: cited by a record it holds, held as no blob (§10.1). In a
   * sync, read once the Item Versions are verified (D277).
   */
  lacking(): Promise<readonly Uint8Array[]>;
  /** The held blob of `id` as stored, or `undefined` when none is held. */
  read(id: Uint8Array): Promise<Uint8Array | undefined>;
  /** Deletes a held blob that failed its check of length or hash before it was sent. */
  discard(id: Uint8Array): Promise<void>;
  /** Writes a received blob that matches `id`, in its own transaction, unless already held. */
  write(id: Uint8Array, blob: Uint8Array): Promise<void>;
  /** A received blob that does not match `id`: reported, naming the items that cite it. */
  rejected(id: Uint8Array): Promise<void>;
}

export interface BlobOptions {
  readonly store: BlobStore;
  /** §6: run before each unit leaves; it ends the session itself when the peer is retired. */
  readonly check?: () => Promise<void>;
}

/** What the phase needs of a pairing or sync session. */
export interface BlobLink {
  send(message: BlobMessage): Promise<void>;
  receive(): Promise<{ readonly t: string }>;
  refuse(reason: 'protocol-error', cause?: unknown): Promise<never>;
  readonly error: Error | null;
}

/**
 * Runs sends one at a time, in the order queued, so the messages of two units or transfers never
 * interleave (§10, §10.1).
 */
export class Outbox {
  #tail: Promise<void> = Promise.resolve();

  /** Runs `job` once every job queued before it has ended. */
  run(job: () => Promise<void>): Promise<void> {
    const run = this.#tail.then(job);
    this.#tail = run.catch(() => undefined);
    return run;
  }

  /** Resolves once every job queued so far has ended. */
  idle(): Promise<void> {
    return this.#tail;
  }
}

export interface BlobPhaseOptions extends BlobOptions {
  /** Whether the peer may ask: in a pairing, A answers and B only asks. */
  readonly answers: boolean;
  /** Whether the peer ends its wants with `blobs-end`: in an admission, not in a sync. */
  readonly peerEnds: boolean;
}

function hex(bytes: Uint8Array): string {
  let text = '';
  for (const b of bytes) text += b.toString(16).padStart(2, '0');
  return text;
}

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** One side of §10.1 over one session. */
export class BlobPhase {
  readonly #link: BlobLink;
  readonly #options: BlobPhaseOptions;
  readonly #outbox: Outbox;
  /** Every ID asked for in this session, as hex: none is asked twice. */
  readonly #asked = new Set<string>();
  /** The IDs asked for and not yet answered, in the order asked. */
  readonly #pending: Uint8Array[] = [];
  /** Every ID the peer asked for in this session, as hex: none is answered twice (S-02). */
  readonly #wanted = new Set<string>();
  /** The unit being received: one blob in memory at a time. */
  #unit: { readonly id: Uint8Array; readonly blob: Uint8Array; at: number } | null = null;
  #peerEnded = false;

  constructor(link: BlobLink, options: BlobPhaseOptions, outbox = new Outbox()) {
    this.#link = link;
    this.#options = options;
    this.#outbox = outbox;
  }

  /** Whether every ID asked for has its answer, and no unit is open. */
  get answered(): boolean {
    return this.#pending.length === 0 && this.#unit === null;
  }

  /** Whether a unit is open: only its `blob-chunk`s and `blob-end` may come. */
  get receiving(): boolean {
    return this.#unit !== null;
  }

  /** Whether the admission's phase is over on this side (§10.1, Ending). */
  get done(): boolean {
    return this.answered && (!this.#options.peerEnds || this.#peerEnded);
  }

  /** Resolves once every send queued so far has left. */
  idle(): Promise<void> {
    return this.#outbox.idle();
  }

  /** Asks for the blobs this device lacks and has not asked for in this session. */
  async ask(): Promise<void> {
    const lacking = await this.#guard(() => this.#options.store.lacking());
    const fresh: Uint8Array[] = [];
    for (const id of lacking) {
      const key = hex(id);
      if (id.length !== BLOB_ID_LENGTH || this.#asked.has(key)) continue;
      this.#asked.add(key);
      fresh.push(id.slice());
    }
    if (fresh.length === 0) return;
    this.#pending.push(...fresh);
    // One job for every message of this ask, queued with its IDs: another ask's messages cannot
    // come between them, so the wire keeps the order of `#pending` (S-01).
    await this.#outbox.run(async () => {
      for (let i = 0; i < fresh.length; i += MAX_BLOB_IDS) {
        await this.#link.send({ t: 'blobs-want', ids: fresh.slice(i, i + MAX_BLOB_IDS) });
      }
    });
  }

  /** Sends `blobs-end`, after this device's wants: an admission's asking is over. */
  end(): Promise<void> {
    return this.#outbox.run(() => this.#link.send({ t: 'blobs-end' }));
  }

  /**
   * Takes one message of the peer. Inside a unit only its `blob-chunk`s and `blob-end` may come;
   * outside one only a blob message is taken here. Anything else of §10.1 aborts.
   */
  async receive(message: { readonly t: string }): Promise<void> {
    if (!isBlobMessage(message)) return this.#link.refuse('protocol-error');
    const unit = this.#unit;
    if (unit) {
      if (message.t === 'blob-chunk') return this.#chunk(unit, message.c);
      if (message.t === 'blob-end') return this.#end(unit);
      return this.#link.refuse('protocol-error');
    }
    switch (message.t) {
      case 'blobs-want':
        if (!this.#options.answers || this.#peerEnded) return this.#link.refuse('protocol-error');
        // An ID is asked for at most once per session: a repeat would make this side read, hash
        // and send the same blob again without bound (S-02).
        for (const id of message.ids) {
          const key = hex(id);
          if (this.#wanted.has(key)) return this.#link.refuse('protocol-error');
          this.#wanted.add(key);
        }
        for (const id of message.ids) {
          this.#outbox.run(() => this.#answer(id)).catch(() => undefined);
        }
        return;
      case 'blobs-end':
        if (!this.#options.peerEnds || this.#peerEnded) return this.#link.refuse('protocol-error');
        this.#peerEnded = true;
        return;
      case 'blob-begin': {
        const next = this.#pending[0];
        if (!next || !sameId(next, message.id)) return this.#link.refuse('protocol-error');
        this.#unit = { id: next, blob: new Uint8Array(message.size), at: 0 };
        return;
      }
      case 'blob-missing': {
        const next = this.#pending[0];
        if (!next || !sameId(next, message.id)) return this.#link.refuse('protocol-error');
        // Asked for again at the next session.
        this.#pending.shift();
        return;
      }
      default:
        // A `blob-chunk` or `blob-end` outside a unit.
        return this.#link.refuse('protocol-error');
    }
  }

  /** A chunk: full but the last, and never past the length `blob-begin` gave. */
  #chunk(unit: { blob: Uint8Array; at: number }, chunk: Uint8Array): Promise<void> {
    const at = unit.at + chunk.length;
    if (at > unit.blob.length) return this.#link.refuse('protocol-error');
    if (chunk.length < BLOB_CHUNK_LENGTH && at !== unit.blob.length) {
      return this.#link.refuse('protocol-error');
    }
    unit.blob.set(chunk, unit.at);
    unit.at = at;
    return Promise.resolve();
  }

  /** `blob-end`: the blob whole, checked against its `blobId` on the bytes received. */
  async #end(unit: { readonly id: Uint8Array; readonly blob: Uint8Array; at: number }) {
    if (unit.at !== unit.blob.length) return this.#link.refuse('protocol-error');
    this.#unit = null;
    this.#pending.shift();
    const { store } = this.#options;
    if (blobMatches(unit.blob, unit.id)) {
      await this.#guard(() => store.write(unit.id, unit.blob));
    } else {
      await this.#guard(() => store.rejected(unit.id));
    }
  }

  /** One unit: the held blob, checked first, or `blob-missing`. */
  async #answer(id: Uint8Array): Promise<void> {
    const { store, check } = this.#options;
    if (check) await this.#guard(check);
    let blob = await this.#guard(() => store.read(id));
    if (blob && !blobMatches(blob, id)) {
      await this.#guard(() => store.discard(id));
      blob = undefined;
    }
    if (!blob) return this.#link.send({ t: 'blob-missing', id });
    await this.#link.send({ t: 'blob-begin', id, size: blob.length });
    for (let at = 0; at < blob.length; at += BLOB_CHUNK_LENGTH) {
      await this.#link.send({ t: 'blob-chunk', c: blob.subarray(at, at + BLOB_CHUNK_LENGTH) });
    }
    await this.#link.send({ t: 'blob-end' });
  }

  /**
   * Runs a callback; when it fails, aborts as `protocol-error`. A session that already ended, a
   * lock included, keeps its own reason: `refuse` rejects with it.
   */
  async #guard<T>(run: () => Promise<T>): Promise<T> {
    try {
      return await run();
    } catch (error) {
      return this.#link.refuse('protocol-error', error);
    }
  }
}

/**
 * The blob phase of an admission (`pairing-protocol.md` §8 step 8, §9 step 7): when `asks`, this
 * device's wants then `blobs-end`; then the peer's messages until every ID asked for has its
 * answer and, when the peer asks, its `blobs-end` came; then every answer queued has left.
 */
export async function admissionBlobs(link: BlobLink, phase: BlobPhase, asks: boolean) {
  if (asks) {
    await phase.ask();
    await phase.end();
  }
  while (!phase.done) await phase.receive(await link.receive());
  await phase.idle();
  // An answer the session's end cut: the phase did not complete.
  if (link.error) throw link.error;
}
