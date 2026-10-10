// Shared helpers for the Phase 0 spikes: environment report, visibility log, result panel.

declare const __SW_VERSION__: string;
declare const __BUILT_AT__: string;

export interface Environment {
  userAgent: string;
  platform: string;
  standalone: boolean;
  secureContext: boolean;
  url: string;
  build: { swVersion: string; builtAt: string };
  at: string;
}

export function environment(): Environment {
  const nav = navigator as Navigator & { standalone?: boolean; userAgentData?: { platform?: string } };
  return {
    userAgent: navigator.userAgent,
    platform: nav.userAgentData?.platform ?? navigator.platform,
    standalone: matchMedia('(display-mode: standalone)').matches || nav.standalone === true,
    secureContext: isSecureContext,
    url: location.origin + location.pathname,
    build: { swVersion: __SW_VERSION__, builtAt: __BUILT_AT__ },
    at: new Date().toISOString(),
  };
}

export interface VisibilityEvent {
  state: DocumentVisibilityState;
  at: number;
  during: string | null;
}

const visibilityLog: VisibilityEvent[] = [];
let currentAction: string | null = null;

document.addEventListener('visibilitychange', () => {
  visibilityLog.push({ state: document.visibilityState, at: Date.now(), during: currentAction });
  render();
});

/** Runs an action while recording whether the page reported itself hidden (D105). */
export async function tracked<T>(action: string, fn: () => Promise<T>): Promise<{ result: T; hidden: boolean }> {
  currentAction = action;
  const before = visibilityLog.length;
  try {
    const result = await fn();
    return { result, hidden: visibilityLog.slice(before).some((e) => e.state === 'hidden') };
  } finally {
    currentAction = null;
  }
}

export function visibilityEvents(): VisibilityEvent[] {
  return [...visibilityLog];
}

const results: Record<string, unknown> = {};
let resultsEl: HTMLPreElement | null = null;

export function record(key: string, value: unknown): void {
  results[key] = value;
  render();
}

function render(): void {
  if (!resultsEl) return;
  resultsEl.textContent = JSON.stringify(
    { environment: environment(), results, visibility: visibilityLog },
    null,
    2,
  );
}

/** Adds the result panel with a copy button to the page. */
export function mountResults(spike: string): void {
  const section = document.createElement('section');
  section.innerHTML = `<h2>Result</h2>
    <p>Copy this and paste it in the conversation.</p>
    <button type="button" id="copy">Copy result</button> <span id="copied"></span>
    <pre id="results"></pre>`;
  document.body.append(section);
  resultsEl = section.querySelector('#results');
  record('spike', spike);
  section.querySelector('#copy')?.addEventListener('click', () => {
    const text = resultsEl?.textContent ?? '';
    const done = (msg: string) => {
      const el = section.querySelector('#copied');
      if (el) el.textContent = msg;
    };
    navigator.clipboard.writeText(text).then(
      () => done('copied'),
      () => {
        const range = document.createRange();
        if (resultsEl) range.selectNodeContents(resultsEl);
        getSelection()?.removeAllRanges();
        getSelection()?.addRange(range);
        done('clipboard blocked: text selected, copy it by hand');
      },
    );
  });
}

export function $(selector: string): HTMLElement {
  const el = document.querySelector<HTMLElement>(selector);
  if (!el) throw new Error(`missing ${selector}`);
  return el;
}

export function log(message: string): void {
  const el = document.querySelector('#log');
  if (el) el.textContent += `${new Date().toISOString().slice(11, 23)} ${message}\n`;
}

export function errorText(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}
