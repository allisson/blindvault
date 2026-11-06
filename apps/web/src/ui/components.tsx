import {
  type ComponentProps,
  type InputHTMLAttributes,
  type ReactNode,
  type TextareaHTMLAttributes,
  createContext,
  useContext,
  useId,
  useSyncExternalStore,
} from 'react';

import { sharedOrigin } from '../app/origin';
import { type StorageWarning, safariTab } from '../app/storage-state';
import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { AboutBuild } from './About';
import { useAbout } from './about-context';
import { useUpdates } from './update-context';

// Touch targets of at least 44 px on coarse pointers (overview §13.1).
export const TARGET = 'min-h-10 pointer-coarse:min-h-11';
export const INPUT = `${TARGET} rounded-control border border-control bg-raised px-3 text-base`;

export function Button({
  variant = 'primary',
  className = '',
  ...props
}: ComponentProps<'button'> & { readonly variant?: 'primary' | 'quiet' }) {
  const look =
    variant === 'primary'
      ? 'bg-accent text-accent-ink hover:bg-accent-hover'
      : 'text-fg hover:bg-subtle';
  return (
    <button
      type="button"
      className={`${TARGET} rounded-control px-4 text-sm font-medium disabled:opacity-50 ${look} ${className}`}
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
    <span
      data-testid="lock-state"
      className={`rounded-full px-2 py-0.5 text-xs font-medium ${
        unlocked ? 'bg-warning-soft text-warning-text' : 'bg-subtle text-fg'
      }`}
    >
      {unlocked ? m.app.unlocked : m.app.locked}
    </span>
  );
}

/** Vaults and backups of the preview build are throwaway, with no migration owed (D177). */
export function PreviewBanner() {
  const m = useMessages();
  return (
    <p
      role="note"
      data-testid="preview-banner"
      className="bg-warning-soft px-4 py-2 text-sm text-warning-text"
    >
      {m.preview.banner}
    </p>
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
    <section
      role="status"
      data-testid="update-banner"
      className="flex flex-col gap-2 bg-info-soft px-4 py-3 text-sm text-info-text"
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
    </section>
  );
}

/** Shown on every screen when the app runs on an origin other sites share (D90). */
export function SharedOriginWarning() {
  const m = useMessages();
  if (!sharedOrigin(location)) return null;
  return (
    <p
      role="alert"
      data-testid="shared-origin"
      className="bg-danger-soft px-4 py-2 text-sm text-danger-text"
    >
      {m.origin.shared}
    </p>
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
    <p
      role="alert"
      data-testid="storage-warning"
      data-warning={warning}
      className="bg-danger-soft px-4 py-2 text-sm text-danger-text"
    >
      {text}
    </p>
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
