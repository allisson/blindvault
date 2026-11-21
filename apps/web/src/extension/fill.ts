// Filling a tab from the session host (extension.md §6.1, D283, D287). The session host reads the
// tab's URL from the browser, never from a message; probes every frame the browser lets it reach;
// picks the target frame among those of the top frame's origin; and fills it, the injected function
// checking the origin again at the write.

import { type FillResult, type InPageOrder, type ProbeResult, inPage } from './inject';

/** One frame's result of a script run in a tab. */
export interface FrameResult<T> {
  readonly frameId: number;
  readonly result: T;
}

/** The browser's tabs, as the session host uses them (`tabs.get`, `scripting.executeScript`). */
export interface TabsPort {
  /** The tab's URL, `undefined` when the browser does not give it (no `activeTab` grant). */
  url(tabId: number): Promise<string | undefined>;
  /** Runs `inPage` in every frame it may reach, or in `frameIds`. */
  run(
    tabId: number,
    frames: 'all' | readonly number[],
    order: InPageOrder,
  ): Promise<readonly FrameResult<unknown>[]>;
}

const TOP_FRAME = 0;

function probeResult(value: unknown): value is ProbeResult {
  if (typeof value !== 'object' || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.origin === 'string' &&
    typeof p.password === 'boolean' &&
    typeof p.focusedPassword === 'boolean' &&
    typeof p.focusedText === 'boolean'
  );
}

/**
 * The frame to fill (§6.1 step 6, D287), among the frames of `origin`, the top frame's: the one whose
 * password field has the focus, else the top frame with a password field, else the first frame with
 * one, else the one whose text field has the focus, for a user name alone. A frame of another
 * origin is never a target.
 */
export function chooseFrame(
  frames: readonly FrameResult<unknown>[],
  origin: string,
): number | undefined {
  const same = frames.filter(
    (f): f is FrameResult<ProbeResult> => probeResult(f.result) && f.result.origin === origin,
  );
  return (
    same.find((f) => f.result.focusedPassword) ??
    same.find((f) => f.frameId === TOP_FRAME && f.result.password) ??
    same.find((f) => f.result.password) ??
    same.find((f) => f.result.focusedText)
  )?.frameId;
}

export interface Values {
  readonly username?: string;
  readonly password?: string;
}

/** Fills `values` into the tab whose top frame has `origin`. */
export async function fillTab(
  tabs: TabsPort,
  tabId: number,
  origin: string,
  values: Values,
): Promise<FillResult> {
  try {
    const probed = await tabs.run(tabId, 'all', { kind: 'probe' });
    const frameId = chooseFrame(probed, origin);
    if (frameId === undefined) return 'no-target';
    const [done] = await tabs.run(tabId, [frameId], { kind: 'fill', origin, ...values });
    const result = done?.result;
    return result === 'filled' || result === 'moved' ? result : 'no-target';
  } catch {
    // The browser refused the script: a page it does not let the extension reach.
    return 'no-target';
  }
}

interface ExtensionTabs {
  tabs: { get(tabId: number): Promise<{ url?: string }> };
  scripting: {
    executeScript(injection: {
      target: { tabId: number; allFrames?: boolean; frameIds?: number[] };
      func: typeof inPage;
      args: [InPageOrder];
    }): Promise<{ frameId: number; result?: unknown }[]>;
  };
}

/** The browser's tabs in an extension page; `undefined` elsewhere (the tests, the dev server). */
export function extensionTabs(): TabsPort | undefined {
  const api = (globalThis as { chrome?: Partial<ExtensionTabs> }).chrome;
  const tabs = api?.tabs;
  const scripting = api?.scripting;
  if (!tabs || !scripting) return undefined;
  return {
    url: async (tabId) => {
      try {
        return (await tabs.get(tabId)).url;
      } catch {
        return undefined;
      }
    },
    run: async (tabId, frames, order) => {
      const target =
        frames === 'all' ? { tabId, allFrames: true } : { tabId, frameIds: [...frames] };
      const results = await scripting.executeScript({ target, func: inPage, args: [order] });
      return results.map((r) => ({ frameId: r.frameId, result: r.result }));
    },
  };
}
