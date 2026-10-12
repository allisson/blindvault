import {
  type ButtonHTMLAttributes,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  useId,
} from 'react';

import { useMessages } from '../i18n/context';

// Touch targets of at least 44 px on coarse pointers (overview §13.1).
export const TARGET = 'min-h-10 pointer-coarse:min-h-11';
export const INPUT = `${TARGET} rounded-md border border-zinc-300 bg-white px-3 text-base dark:border-zinc-700 dark:bg-zinc-900`;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { readonly variant?: 'primary' | 'quiet' }) {
  const look =
    variant === 'primary'
      ? 'bg-zinc-900 text-white hover:bg-zinc-700 dark:bg-zinc-100 dark:text-zinc-900 dark:hover:bg-zinc-300'
      : 'text-zinc-700 hover:bg-zinc-100 dark:text-zinc-200 dark:hover:bg-zinc-800';
  return (
    <button
      type="button"
      className={`${TARGET} rounded-md px-4 text-sm font-medium disabled:opacity-50 ${look} ${className}`}
      {...props}
    />
  );
}

export function Field({
  label,
  hint,
  error,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <input id={id} className={INPUT} aria-invalid={error ? true : undefined} {...props} />
      <Message error={error} hint={hint} />
    </div>
  );
}

function Message({
  error,
  hint,
}: {
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
}) {
  if (error) {
    return (
      <p role="alert" className="text-sm text-red-700 dark:text-red-400">
        {error}
      </p>
    );
  }
  return hint ? <p className="text-sm text-zinc-500">{hint}</p> : null;
}

export function TextArea({
  label,
  hint,
  error,
  ...props
}: TextareaHTMLAttributes<HTMLTextAreaElement> & {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
}) {
  const id = useId();
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <textarea
        id={id}
        rows={4}
        className={`${INPUT} py-2`}
        aria-invalid={error ? true : undefined}
        {...props}
      />
      <Message error={error} hint={hint} />
    </div>
  );
}

/** A notice in the item views: why something cannot be done, or a warning. */
export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <p
      role="note"
      className="rounded-md bg-zinc-100 px-3 py-2 text-sm text-zinc-700 dark:bg-zinc-800 dark:text-zinc-200"
    >
      {children}
    </p>
  );
}

/** The always-visible lock state (overview §13.2). */
export function LockState({ unlocked }: { readonly unlocked: boolean }) {
  const m = useMessages();
  return (
    <span
      data-testid="lock-state"
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        unlocked
          ? 'bg-amber-100 text-amber-900 dark:bg-amber-900 dark:text-amber-100'
          : 'bg-zinc-200 text-zinc-800 dark:bg-zinc-800 dark:text-zinc-200'
      }`}
    >
      {unlocked ? m.app.unlocked : m.app.locked}
    </span>
  );
}

/** Phase 1 has no Recovery Phrase: the vault is lost with its password or its storage. */
export function Phase1Banner() {
  const m = useMessages();
  return (
    <p
      role="note"
      data-testid="phase1-banner"
      className="bg-amber-50 px-4 py-2 text-sm text-amber-900 dark:bg-amber-950 dark:text-amber-100"
    >
      {m.phase1.banner}
    </p>
  );
}

/** A centered card for the screens shown before unlock. */
export function Card({
  title,
  children,
}: {
  readonly title: string;
  readonly children: ReactNode;
}) {
  const m = useMessages();
  return (
    <div className="flex min-h-dvh flex-col bg-zinc-50 text-zinc-900 dark:bg-zinc-950 dark:text-zinc-100">
      <Phase1Banner />
      <main className="flex flex-1 items-center justify-center p-4">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-xl bg-white p-6 shadow-sm dark:bg-zinc-900">
          <header className="flex items-center justify-between">
            <span className="text-sm font-semibold">{m.app.name}</span>
            <LockState unlocked={false} />
          </header>
          <h1 className="text-xl font-semibold">{title}</h1>
          {children}
          <p className="text-xs text-zinc-500">v{__APP_VERSION__}</p>
        </section>
      </main>
    </div>
  );
}
