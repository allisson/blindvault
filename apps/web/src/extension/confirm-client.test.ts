import { describe, expect, it, vi } from 'vitest';

import { confirmChoice, confirmDetails } from './confirm-client';
import { type PopupRuntime } from './popup-client';

function runtime(reply: (request: Record<string, unknown>) => unknown) {
  const sent = vi.fn((m: Record<string, unknown>) => Promise.resolve(reply(m)));
  const r: PopupRuntime = {
    id: 'abc',
    getURL: (path) => `chrome-extension://abc/${path}`,
    sendMessage: sent,
    onMessage: { addListener: () => undefined },
  };
  return { r, sent };
}

const ok = (m: Record<string, unknown>, rest: object) => ({ v: 1, id: m.id, ok: true, ...rest });
const TOKEN = 'c'.repeat(32);

const GET = {
  kind: 'get',
  origin: 'https://example.com',
  rpId: 'example.com',
  passkeys: [{ credentialId: '01', title: 'Mail', userName: 'ana' }],
};
const CREATE = {
  kind: 'create',
  origin: 'https://example.com',
  topOrigin: 'https://shop.example',
  rpId: 'example.com',
  rpName: 'Example',
  userName: 'ana',
  displayName: 'Ana',
  items: [{ itemId: '0'.repeat(32), title: 'Mail' }],
  replaces: false,
};

describe('the confirmation window’s messages (extension.md §7.7)', () => {
  it('reads each state, sending the token', async () => {
    for (const state of [GET, CREATE, { ...CREATE, holder: '0'.repeat(32) }, { kind: 'locked' }]) {
      const { r, sent } = runtime((m) => ok(m, { state }));
      await expect(confirmDetails(r, TOKEN)).resolves.toEqual(state);
      expect(sent).toHaveBeenCalledWith({
        v: 1,
        id: expect.any(Number) as unknown,
        type: 'confirm-details',
        token: TOKEN,
      });
    }
  });

  it('treats a malformed state as a refusal, and the request ended as not-found', async () => {
    for (const state of [
      { ...GET, passkeys: [{ title: 'Mail' }] },
      { ...GET, origin: 1 },
      { ...CREATE, replaces: 'no' },
      { ...CREATE, holder: 1 },
      { ...CREATE, items: [{ itemId: 1, title: 'x' }] },
      { kind: 'other' },
    ]) {
      await expect(
        confirmDetails(runtime((m) => ok(m, { state })).r, TOKEN),
      ).resolves.toBeUndefined();
    }
    const ended = runtime((m) => ({ v: 1, id: m.id, ok: false, error: 'not-found' }));
    await expect(confirmDetails(ended.r, TOKEN)).resolves.toBe('not-found');
  });

  it('sends a choice flat beside the token', async () => {
    const { r, sent } = runtime((m) => ok(m, {}));
    await expect(confirmChoice(r, TOKEN, { choice: 'use', credentialId: '01' })).resolves.toBe(
      true,
    );
    expect(sent).toHaveBeenCalledWith({
      v: 1,
      id: expect.any(Number) as unknown,
      type: 'confirm-choice',
      token: TOKEN,
      choice: 'use',
      credentialId: '01',
    });
    const locked = runtime((m) => ({ v: 1, id: m.id, ok: false, error: 'locked' }));
    await expect(confirmChoice(locked.r, TOKEN, { choice: 'save-new' })).resolves.toBe('locked');
  });
});
