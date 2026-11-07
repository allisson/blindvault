import {
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  useSyncExternalStore,
} from 'react';

import { sharedOrigin } from '../app/origin';
import { type StorageWarning, safariTab } from '../app/storage-state';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { AboutBuild } from './About';
import { useAbout } from './about-context';
import { Icon } from './icons';
import { useUpdates } from './update-context';

// Touch targets of at least 44 px on coarse pointers (overview §13.1).
export const TARGET = 'min-h-10 pointer-coarse:min-h-11';
// Text field, text area and select (D233): the border darkens on hover, turns danger when invalid;
// the focus ring is global (index.css).
export const INPUT = `${TARGET} rounded-control border border-control bg-raised px-3 text-base text-fg enabled:hover:border-fg aria-[invalid=true]:border-danger disabled:cursor-not-allowed disabled:opacity-60`;

/** A row of the folder tree or the item list: the current one takes the accent's soft fill. */
export const ROW = `${TARGET} w-full truncate rounded-control px-2 text-left text-sm hover:bg-subtle aria-[current]:bg-accent-soft aria-[current]:font-medium`;

const LOOK = {
  primary: 'bg-accent text-accent-ink enabled:hover:bg-accent-hover',
  secondary: 'border border-control bg-raised text-fg enabled:hover:bg-subtle',
  quiet: 'text-fg enabled:hover:bg-subtle',
  danger: 'bg-danger text-danger-ink enabled:hover:bg-danger-hover',
} as const;

// A press scales the button down for 150 ms, only for users who have not asked for reduced motion.
const PRESS =
  'motion-safe:transition-transform motion-safe:duration-150 motion-safe:ease-out motion-safe:enabled:active:scale-[0.97]';

/**
 * A button (D233). `busy` disables it and shows a spinner beside its label; under reduced motion the
 * spinner is hidden and the label, which names the work in progress, stays.
 */
export function Button({
  variant = 'primary',
  busy = false,
  className = '',
  disabled,
  children,
  ...props
}: ComponentProps<'button'> & {
  readonly variant?: keyof typeof LOOK;
  readonly busy?: boolean;
}) {
  return (
    <button
      type="button"
      className={`${TARGET} rounded-control px-4 text-sm font-medium disabled:cursor-not-allowed disabled:opacity-60 ${PRESS} ${LOOK[variant]} ${className}`}
      disabled={disabled === true || busy}
      aria-busy={busy || undefined}
      {...props}
    >
      {busy ? <Spinner /> : null}
      {children}
    </button>
  );
}

/** Work in progress, beside the text that names it. Nothing turns under reduced motion. */
export function Spinner() {
  return (
    <Icon name="loader-circle" className="me-1.5 motion-safe:animate-spin motion-reduce:hidden" />
  );
}

/** How long a copy shows its check (D231). */
export const CHECK_MS = 1500;

/** A check shown for `CHECK_MS` after each `show()`; a new `show()` restarts it. */
export function useCheck(): readonly [boolean, () => void] {
  const [shown, setShown] = useState(0);
  useEffect(() => {
    if (shown === 0) return;
    const timer = setTimeout(() => {
      setShown(0);
    }, CHECK_MS);
    return () => {
      clearTimeout(timer);
    };
  }, [shown]);
  return [
    shown !== 0,
    () => {
      setShown((n) => n + 1);
    },
  ];
}

/** The check beside a copy button's label: decorative, the copy's status note says what happened. */
export function CopyCheck({ shown }: { readonly shown: boolean }) {
  return shown ? (
    <span data-testid="copy-check">
      <Icon name="check" className="me-1.5 text-success motion-safe:animate-pop" />
    </span>
  ) : null;
}

/**
 * A destructive or security confirmation in the native modal dialog (D231, D233): the focus stays
 * inside, Escape cancels and the rest of the page is inert. Shown while mounted; its text is the
 * caller's, unchanged from the inline confirmation it replaces.
 */
export function ConfirmDialog({
  confirm,
  cancel,
  onConfirm,
  onCancel,
  busy = false,
  tone = 'danger',
  children,
  ...props
}: Omit<ComponentProps<'dialog'>, 'onCancel'> & {
  readonly confirm: string;
  readonly cancel: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
  readonly busy?: boolean;
  readonly tone?: 'danger' | 'primary';
}) {
  const ref = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const dialog = ref.current;
    if (dialog && !dialog.open) dialog.showModal();
    return () => {
      dialog?.close();
    };
  }, []);
  return (
    <dialog
      ref={ref}
      aria-label={confirm}
      className="m-auto w-[calc(100%-2rem)] max-w-md rounded-card bg-raised p-6 text-fg shadow-raised backdrop:bg-scrim motion-safe:animate-enter"
      onCancel={(e) => {
        // Escape: the caller unmounts the dialog, unless the work already started.
        e.preventDefault();
        if (!busy) onCancel();
      }}
      {...props}
    >
      <div className="flex flex-col gap-4">
        {children}
        <div className="flex flex-wrap justify-end gap-2">
          <Button variant="secondary" disabled={busy} onClick={onCancel}>
            {cancel}
          </Button>
          <Button variant={tone} busy={busy} onClick={onConfirm}>
            {confirm}
          </Button>
        </div>
      </div>
    </dialog>
  );
}

const TONES = {
  danger: 'bg-danger-soft text-danger-text',
  warning: 'bg-warning-soft text-warning-text',
  info: 'bg-info-soft text-info-text',
} as const;

/** A full-width banner above the screen; the caller sets its role: alert, status or note (D233). */
export function Banner({
  tone,
  className = '',
  ...props
}: ComponentProps<'div'> & { readonly tone: keyof typeof TONES }) {
  return <div className={`px-4 py-2 text-sm ${TONES[tone]} ${className}`} {...props} />;
}

/** A short label: the lock state, a tag. */
export function Badge({
  tone = 'neutral',
  className = '',
  ...props
}: ComponentProps<'span'> & { readonly tone?: 'neutral' | 'warning' }) {
  const look = tone === 'warning' ? 'bg-warning-soft text-warning-text' : 'bg-subtle text-fg';
  return (
    <span
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${look} ${className}`}
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
      {/* Off by default: the form history keeps typed values on disk in cleartext (D174), and a
          spellchecker can send them to a remote service (D176). */}
      <input
        id={id}
        className={INPUT}
        aria-invalid={error ? true : undefined}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
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
      <p role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  return hint ? <p className="text-sm text-muted">{hint}</p> : null;
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
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
      <Message error={error} hint={hint} />
    </div>
  );
}

/** A notice in the item views: why something cannot be done, or a warning. */
export function Notice({ children }: { readonly children: ReactNode }) {
  return (
    <p role="note" className="rounded-control bg-subtle px-3 py-2 text-sm text-fg">
      {children}
    </p>
  );
}

/** The always-visible lock state (overview §13.2). */
export function LockState({ unlocked }: { readonly unlocked: boolean }) {
  const m = useMessages();
  return (
    <Badge data-testid="lock-state" tone={unlocked ? 'warning' : 'neutral'}>
      {unlocked ? m.app.unlocked : m.app.locked}
    </Badge>
  );
}

/** Vaults and backups of the preview build are throwaway, with no migration owed (D177). */
export function PreviewBanner() {
  const m = useMessages();
  return (
    <Banner tone="warning" role="note" data-testid="preview-banner">
      {m.preview.banner}
    </Banner>
  );
}

const noUpdates = () => () => undefined;

/**
 * An asset update the service worker staged, with the running and new versions and the full
 * manifest hash, offered only between flows (D152, D191). Updating locks and reloads.
 */
export function UpdateBanner() {
  const m = useMessages();
  const updates = useUpdates();
  const state = useSyncExternalStore(updates?.monitor.subscribe ?? noUpdates, () =>
    updates?.monitor.getState(),
  );
  const allowed = useSyncExternalStore(
    updates?.controller.subscribe ?? noUpdates,
    () => updates?.controller.updateAllowed ?? false,
  );
  const offer = state?.offer;
  if (!updates || !offer || state.changedWorker || !allowed) return null;
  return (
    <Banner
      tone="info"
      role="status"
      data-testid="update-banner"
      className="flex flex-col gap-2 py-3"
    >
      <p>{format(m.update.available, { current: __APP_VERSION__, next: offer.version })}</p>
      <p>
        {m.update.hash}{' '}
        <code data-testid="update-hash" className="break-all">
          {offer.hash}
        </code>
      </p>
      <p>{m.update.verify}</p>
      <p>{m.update.note}</p>
      <Button
        className="self-start"
        onClick={() => {
          void updates.monitor.apply();
        }}
      >
        {m.update.apply}
      </Button>
    </Banner>
  );
}

/** Shown on every screen when the app runs on an origin other sites share (D90). */
export function SharedOriginWarning() {
  const m = useMessages();
  if (!sharedOrigin(location)) return null;
  return (
    <Banner tone="danger" role="alert" data-testid="shared-origin">
      {m.origin.shared}
    </Banner>
  );
}

/** A storage warning: none can be dismissed, each goes once its condition ends (D196). */
export function StorageAlert({
  warning,
  text,
}: {
  readonly warning: StorageWarning;
  readonly text: string;
}) {
  return (
    <Banner tone="danger" role="alert" data-testid="storage-warning" data-warning={warning}>
      {text}
    </Banner>
  );
}

/**
 * Whether the screens inside hold a vault: `none` for the first screen and the starts (D198),
 * `unknown` while starting, before the app knows.
 */
export const VaultHeld = createContext<'yes' | 'none' | 'unknown'>('yes');

/**
 * Before unlock only the Safari warning applies: it does not depend on the vault (D55, D196). With
 * no vault yet there is nothing to move, so it says to start in the installed app (D198).
 */
export function SafariTabWarning() {
  const m = useMessages();
  const held = useContext(VaultHeld);
  if (held === 'unknown' || !safariTab()) return null;
  return (
    <StorageAlert
      warning="safari-tab"
      text={held === 'none' ? m.storage.safariTabNoVault : m.storage.safariTab}
    />
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
  // Before unlock is where verifying the build matters most (D192).
  const [about, setAbout] = useAbout();
  const updates = useUpdates();
  const holdsPhrase = useSyncExternalStore(
    updates?.controller.subscribe ?? noUpdates,
    () => updates?.controller.holdsPhrase ?? false,
  );
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-fg">
      <SharedOriginWarning />
      <SafariTabWarning />
      <PreviewBanner />
      <UpdateBanner />
      <main className="flex flex-1 items-center justify-center p-4">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-card bg-raised p-6 shadow-raised">
          <header className="flex items-center justify-between">
            <span className="text-sm font-semibold">{m.app.name}</span>
            <LockState unlocked={false} />
          </header>
          <h1 className="text-xl font-semibold">{about ? m.about.title : title}</h1>
          {about ? (
            <>
              <AboutBuild />
              <Button
                variant="quiet"
                className="self-start"
                onClick={() => {
                  setAbout(false);
                }}
              >
                {m.app.back}
              </Button>
            </>
          ) : null}
          {/* Hidden, not unmounted: a flow in progress keeps what was typed (D192). */}
          <div className={about ? 'hidden' : 'contents'}>{children}</div>
          <footer className="flex items-center justify-between">
            <p className="text-xs text-muted">v{__APP_VERSION__}</p>
            {about || holdsPhrase ? null : (
              <Button
                variant="quiet"
                onClick={() => {
                  setAbout(true);
                }}
              >
                {m.about.open}
              </Button>
            )}
          </footer>
        </section>
      </main>
    </div>
  );
}
