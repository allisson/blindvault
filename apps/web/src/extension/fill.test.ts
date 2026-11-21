import { describe, expect, it, vi } from 'vitest';

import { type FrameResult, type TabsPort, chooseFrame, fillTab } from './fill';
import { type InPageOrder } from './inject';

const SITE = 'https://site.example';
const OTHER = 'https://ads.example';

function frame(
  frameId: number,
  origin: string,
  fields: { password?: boolean; focusedPassword?: boolean; focusedText?: boolean } = {},
): FrameResult<unknown> {
  return {
    frameId,
    result: {
      origin,
      password: fields.password ?? false,
      focusedPassword: fields.focusedPassword ?? false,
      focusedText: fields.focusedText ?? false,
    },
  };
}

describe('chooseFrame (extension.md §6.1 step 6, D287)', () => {
  it('takes the frame whose password field has the focus', () => {
    const frames = [
      frame(0, SITE, { password: true }),
      frame(4, SITE, { password: true, focusedPassword: true }),
    ];
    expect(chooseFrame(frames, SITE)).toBe(4);
  });

  it('never takes a frame of another origin, even with the focus', () => {
    const frames = [
      frame(0, SITE),
      frame(4, OTHER, { password: true, focusedPassword: true }),
      frame(5, OTHER, { focusedText: true }),
    ];
    expect(chooseFrame(frames, SITE)).toBeUndefined();
  });

  it('takes the top frame with a password field, before another frame with one', () => {
    const frames = [frame(3, SITE, { password: true }), frame(0, SITE, { password: true })];
    expect(chooseFrame(frames, SITE)).toBe(0);
  });

  it('takes the first frame with a password field when the top frame has none', () => {
    const frames = [
      frame(0, SITE),
      frame(3, SITE, { password: true }),
      frame(4, SITE, { password: true }),
    ];
    expect(chooseFrame(frames, SITE)).toBe(3);
  });

  it('takes a focused text field for a user name alone, only with no password field', () => {
    expect(chooseFrame([frame(0, SITE, { focusedText: true })], SITE)).toBe(0);
    const frames = [frame(0, SITE, { focusedText: true }), frame(2, SITE, { password: true })];
    expect(chooseFrame(frames, SITE)).toBe(2);
  });

  it('ignores a result that is not a probe’s', () => {
    expect(chooseFrame([{ frameId: 0, result: 'filled' }], SITE)).toBeUndefined();
    expect(chooseFrame([{ frameId: 0, result: null }], SITE)).toBeUndefined();
  });
});

function tabs(probed: FrameResult<unknown>[], filled: unknown) {
  const orders: { frames: 'all' | readonly number[]; order: InPageOrder }[] = [];
  const port: TabsPort = {
    url: () => Promise.resolve(`${SITE}/login`),
    run: vi.fn((_tabId: number, frames: 'all' | readonly number[], order: InPageOrder) => {
      orders.push({ frames, order });
      return Promise.resolve(order.kind === 'probe' ? probed : [{ frameId: 0, result: filled }]);
    }),
  };
  return { port, orders };
}

describe('fillTab (extension.md §6.1)', () => {
  it('probes every frame, then fills the chosen one with the top frame’s origin', async () => {
    const { port, orders } = tabs([frame(0, SITE, { password: true })], 'filled');
    await expect(fillTab(port, 9, SITE, { username: 'ana', password: 'hunter2' })).resolves.toBe(
      'filled',
    );
    expect(orders).toEqual([
      { frames: 'all', order: { kind: 'probe' } },
      {
        frames: [0],
        order: { kind: 'fill', origin: SITE, username: 'ana', password: 'hunter2' },
      },
    ]);
  });

  it('fills nothing on a page with no sign-in field', async () => {
    const { port, orders } = tabs([frame(0, SITE)], 'filled');
    await expect(fillTab(port, 9, SITE, { password: 'x' })).resolves.toBe('no-target');
    expect(orders).toHaveLength(1);
  });

  it('reports a page that navigated between the probe and the fill', async () => {
    const { port } = tabs([frame(0, SITE, { password: true })], 'moved');
    await expect(fillTab(port, 9, SITE, { password: 'x' })).resolves.toBe('moved');
  });

  it('reads an unexpected result, or a script the browser refused, as no target', async () => {
    const { port } = tabs([frame(0, SITE, { password: true })], { done: true });
    await expect(fillTab(port, 9, SITE, { password: 'x' })).resolves.toBe('no-target');
    const refused: TabsPort = {
      url: () => Promise.resolve(undefined),
      run: () => Promise.reject(new Error('Cannot access contents of the page')),
    };
    await expect(fillTab(refused, 9, SITE, { password: 'x' })).resolves.toBe('no-target');
  });
});
