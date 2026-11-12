import { type ReactNode, createContext, useContext, useEffect, useState } from 'react';

import { useLayout } from './hooks';
import { Icon } from './icons';

/** How long a toast stays (D250). */
export const TOAST_MS = 5000;

/** Shows a toast: `done` marks a completed action with a check. */
type Show = (text: string, done?: boolean) => void;

const ToastContext = createContext<Show>(() => undefined);

export function useToast(): Show {
  return useContext(ToastContext);
}

/**
 * The vault's one toast region (D250): a `role=status` mounted with the vault, so each new toast
 * is announced; a new one replaces the last. It never takes the pointer and holds no secret: it
 * goes with the vault shell on lock.
 */
export function ToastRegion({ children }: { readonly children: ReactNode }) {
  const layout = useLayout();
  const [toast, setToast] = useState<{ text: string; done: boolean; n: number }>();
  const [show] = useState<Show>(() => (text: string, done?: boolean) => {
    setToast((last) => ({ text, done: done ?? true, n: (last?.n ?? 0) + 1 }));
  });
  useEffect(() => {
    if (!toast) return;
    const timer = setTimeout(() => {
      setToast(undefined);
    }, TOAST_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [toast]);
  return (
    <ToastContext.Provider value={show}>
      {children}
      {/* Above the phone's bottom navigation. */}
      <div
        role="status"
        data-testid="toast-region"
        className={`pointer-events-none fixed inset-x-0 z-40 flex justify-center px-4 ${layout === 'mobile' ? 'bottom-20' : 'bottom-4'}`}
      >
        {toast ? (
          <p
            key={toast.n}
            data-testid="toast"
            className="flex max-w-md items-center gap-2 rounded-card bg-fg px-4 py-2.5 text-sm text-surface shadow-raised motion-safe:animate-enter"
          >
            {toast.done ? <Icon name="check" className="shrink-0" /> : null}
            {toast.text}
          </p>
        ) : null}
      </div>
    </ToastContext.Provider>
  );
}
