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
import { useLayout } from './hooks';
import { Icon, type IconName } from './icons';
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
 * The native modal dialog (D231, D233): the focus stays inside, Escape calls `onCancel` and the rest
 * of the page is inert. Shown while mounted. On a phone it is a bottom sheet (D250).
 */
export function Modal({
  onCancel,
  children,
  ...props
}: Omit<ComponentProps<'dialog'>, 'onCancel'> & { readonly onCancel: () => void }) {
  const ref = useRef<HTMLDialogElement>(null);
  const sheet = useLayout() === 'mobile';
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
      data-sheet={sheet || undefined}
      className={`bg-raised text-fg shadow-raised backdrop:bg-scrim motion-safe:animate-enter ${
        sheet
          ? 'mx-0 mt-auto mb-0 w-full max-w-none rounded-t-card p-4 pb-[max(1.5rem,env(safe-area-inset-bottom))]'
          : 'm-auto w-[calc(100%-2rem)] max-w-md rounded-card p-6'
      }`}
      onCancel={(e) => {
        // Escape: the caller unmounts the dialog.
        e.preventDefault();
        onCancel();
      }}
      {...props}
    >
      {children}
    </dialog>
  );
}

/**
 * A destructive or security confirmation in a `Modal`; its text is the caller's, unchanged from the
 * inline confirmation it replaces. On a phone its buttons are full width with the action first.
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
  const sheet = useLayout() === 'mobile';
  return (
    <Modal
      aria-label={confirm}
      onCancel={() => {
        // Not once the work started.
        if (!busy) onCancel();
      }}
      {...props}
    >
      <div className="flex flex-col gap-4">
        {children}
        {sheet ? (
          <div className="flex flex-col gap-2">
            <Button variant={tone} busy={busy} className="min-h-11" onClick={onConfirm}>
              {confirm}
            </Button>
            <Button variant="secondary" disabled={busy} className="min-h-11" onClick={onCancel}>
              {cancel}
            </Button>
          </div>
        ) : (
          <div className="flex flex-wrap justify-end gap-2">
            <Button variant="secondary" disabled={busy} onClick={onCancel}>
              {cancel}
            </Button>
            <Button variant={tone} busy={busy} onClick={onConfirm}>
              {confirm}
            </Button>
          </div>
        )}
      </div>
    </Modal>
  );
}

/**
 * A "…" button whose actions open below it in a native popover (D245): the browser closes it on
 * Escape or a click outside, and Tab moves through its buttons, a disclosure rather than an ARIA
 * menu. Choosing an action closes it.
 */
export function Overflow({
  label,
  className = '',
  children,
}: {
  readonly label: string;
  readonly className?: string;
  readonly children: ReactNode;
}) {
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = popover.current;
    if (!pop) return;
    // No anchor positioning in every browser yet: placed under its button each time it opens.
    const place = (e: Event) => {
      const at = button.current?.getBoundingClientRect();
      if (!at || (e as ToggleEvent).newState !== 'open') return;
      pop.style.top = `${String(at.bottom + 4)}px`;
      pop.style.right = `${String(document.documentElement.clientWidth - at.right)}px`;
    };
    pop.addEventListener('beforetoggle', place);
    return () => {
      pop.removeEventListener('beforetoggle', place);
    };
  }, []);
  return (
    <>
      <Button
        ref={button}
        variant="quiet"
        className={className}
        aria-label={label}
        title={label}
        popoverTarget={id}
      >
        <Icon name="ellipsis" />
      </Button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        className="fixed inset-auto m-0 min-w-48 flex-col gap-1 rounded-card border border-line bg-raised p-1 text-fg shadow-raised [&:popover-open]:flex"
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('button')) {
            e.currentTarget.hidePopover();
          }
        }}
      >
        {children}
      </div>
    </>
  );
}

/**
 * A list filter's pill (D254): its choices open below it in a native popover, or as a bottom sheet
 * on a phone. The browser closes it on Escape or a click outside; choosing an entry marked
 * `data-choice` closes it too.
 */
export function Pill({
  label,
  icon,
  on,
  children,
  ...props
}: ComponentProps<'button'> & {
  readonly label: string;
  readonly icon?: IconName;
  /** A choice other than all is in force. */
  readonly on: boolean;
  readonly children: ReactNode;
}) {
  const sheet = useLayout() === 'mobile';
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = popover.current;
    if (!pop) return;
    const place = (e: Event) => {
      const at = button.current?.getBoundingClientRect();
      if (!at || (e as ToggleEvent).newState !== 'open') return;
      // A sheet sits at the bottom; a popover under its button, inside the viewport.
      const width = document.documentElement.clientWidth;
      pop.style.top = sheet ? '' : `${String(at.bottom + 4)}px`;
      pop.style.left = sheet
        ? ''
        : `${String(Math.max(16, Math.min(at.left, width - 16 - 256)))}px`;
    };
    const toggle = (e: Event) => {
      setOpen((e as ToggleEvent).newState === 'open');
    };
    pop.addEventListener('beforetoggle', place);
    pop.addEventListener('toggle', toggle);
    return () => {
      pop.removeEventListener('beforetoggle', place);
      pop.removeEventListener('toggle', toggle);
    };
  }, [sheet]);
  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        data-on={on || undefined}
        className={`${TARGET} inline-flex min-w-0 items-center gap-1.5 rounded-full border border-line bg-raised px-3 text-sm hover:bg-subtle data-on:border-accent data-on:bg-accent-soft data-on:text-accent-text`}
        {...props}
      >
        {icon ? <Icon name={icon} className="shrink-0" /> : null}
        <span className="truncate">{label}</span>
        <Icon name="chevron-down" className="shrink-0" />
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        className={`fixed m-0 overflow-y-auto bg-raised p-1 text-fg shadow-raised ${
          sheet
            ? 'inset-x-0 top-auto bottom-0 max-h-[80dvh] w-full max-w-none rounded-t-card p-2 pb-[max(1.5rem,env(safe-area-inset-bottom))] backdrop:bg-scrim'
            : 'inset-auto max-h-[60dvh] w-64 rounded-card border border-line'
        }`}
        onClick={(e) => {
          if (e.target instanceof Element && e.target.closest('[data-choice]')) {
            e.currentTarget.hidePopover();
          }
        }}
      >
        {children}
      </div>
    </>
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
  type,
  revealed = false,
  ...props
}: InputHTMLAttributes<HTMLInputElement> & {
  readonly label: string;
  readonly hint?: ReactNode;
  readonly error?: string | undefined;
  /** A password field shown when it appears, as a generated passphrase to write down (D155). */
  readonly revealed?: boolean;
}) {
  const m = useMessages();
  const id = useId();
  const ref = useRef<HTMLInputElement>(null);
  const [shown, setShown] = useState(revealed);
  const password = type === 'password';
  // Masked again on submit, a failed one included; a new screen or a lock unmounts it (D254).
  useEffect(() => {
    const form = ref.current?.form;
    if (!password || !form) return;
    const hide = () => {
      setShown(false);
    };
    form.addEventListener('submit', hide);
    return () => {
      form.removeEventListener('submit', hide);
    };
  }, [password]);
  return (
    <div className="flex flex-col gap-1">
      <label htmlFor={id} className="text-sm font-medium">
        {label}
      </label>
      <div className="relative flex">
        {/* Off by default: the form history keeps typed values on disk in cleartext (D174), and a
            spellchecker can send them to a remote service (D176). */}
        <input
          ref={ref}
          id={id}
          type={password && shown ? 'text' : type}
          className={`${INPUT} min-w-0 flex-1 ${password ? 'pe-11' : ''}`}
          aria-invalid={error ? true : undefined}
          aria-describedby={error || hint ? `${id}-message` : undefined}
          autoComplete="off"
          spellCheck={false}
          {...props}
        />
        {password ? (
          <button
            type="button"
            aria-pressed={shown}
            aria-label={shown ? m.items.hidePassword : m.items.showPassword}
            title={shown ? m.items.hidePassword : m.items.showPassword}
            disabled={props.disabled}
            className={`${TARGET} absolute inset-y-0 end-0 inline-flex min-w-10 items-center justify-center rounded-control text-muted hover:text-fg disabled:opacity-50`}
            onClick={() => {
              setShown(!shown);
            }}
          >
            <Icon name={shown ? 'eye-off' : 'eye'} />
          </button>
        ) : null}
      </div>
      <Message id={`${id}-message`} error={error} hint={hint} />
    </div>
  );
}

/** A field's error or hint, which the field names as its description (`aria-describedby`). */
export function Message({
  id,
  error,
  hint,
}: {
  readonly id: string;
  readonly error?: string | undefined;
  readonly hint?: ReactNode;
}) {
  if (error) {
    return (
      <p id={id} role="alert" className="text-sm text-danger">
        {error}
      </p>
    );
  }
  return hint ? (
    <p id={id} className="text-sm text-muted">
      {hint}
    </p>
  ) : null;
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
        aria-describedby={error || hint ? `${id}-message` : undefined}
        autoComplete="off"
        spellCheck={false}
        {...props}
      />
      <Message id={`${id}-message`} error={error} hint={hint} />
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

/** The always-visible lock state (overview §13.2), neutral with its padlock (D254). */
export function LockState({
  unlocked,
  className = '',
}: {
  readonly unlocked: boolean;
  readonly className?: string;
}) {
  const m = useMessages();
  return (
    <Badge
      data-testid="lock-state"
      className={`inline-flex items-center gap-1 text-muted ${className}`}
    >
      <Icon name={unlocked ? 'lock-open' : 'lock'} className="size-3.5" />
      {unlocked ? m.app.unlocked : m.app.locked}
    </Badge>
  );
}

/**
 * Vaults and backups of the preview build are throwaway, with no migration owed (D177): a badge
 * beside the app's name whose popover holds the whole text (D254). The browser closes it on Escape
 * or a click outside.
 */
export function PreviewBadge() {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const id = useId();
  const button = useRef<HTMLButtonElement>(null);
  const popover = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const pop = popover.current;
    if (!pop) return;
    // Placed under its button each time it opens, kept inside the viewport.
    const place = (e: Event) => {
      const at = button.current?.getBoundingClientRect();
      if (!at || (e as ToggleEvent).newState !== 'open') return;
      const width = Math.min(320, document.documentElement.clientWidth - 32);
      const left = Math.max(
        16,
        Math.min(at.left, document.documentElement.clientWidth - 16 - width),
      );
      pop.style.top = `${String(at.bottom + 4)}px`;
      pop.style.left = `${String(left)}px`;
      pop.style.width = `${String(width)}px`;
    };
    const toggle = (e: Event) => {
      setOpen((e as ToggleEvent).newState === 'open');
    };
    pop.addEventListener('beforetoggle', place);
    pop.addEventListener('toggle', toggle);
    return () => {
      pop.removeEventListener('beforetoggle', place);
      pop.removeEventListener('toggle', toggle);
    };
  }, []);
  return (
    <>
      <button
        ref={button}
        type="button"
        popoverTarget={id}
        aria-expanded={open}
        className="shrink-0 rounded-full bg-warning-soft px-2 py-0.5 text-xs font-semibold text-warning-text hover:underline pointer-coarse:min-h-11 pointer-coarse:px-3"
        data-testid="preview-badge"
      >
        {m.preview.badge}
      </button>
      <div
        ref={popover}
        id={id}
        popover="auto"
        role="note"
        className="fixed inset-auto m-0 rounded-card border border-line bg-warning-soft px-3 py-2 text-sm text-warning-text shadow-raised"
        data-testid="preview-banner"
      >
        {m.preview.banner}
      </div>
    </>
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

/**
 * A storage warning: none can be dismissed, each goes once its condition ends (D196). One line with
 * its icon; "Details" shows the whole text (D254).
 */
export function StorageAlert({
  warning,
  text,
}: {
  readonly warning: StorageWarning;
  readonly text: string;
}) {
  const m = useMessages();
  const [open, setOpen] = useState(false);
  const id = useId();
  return (
    <Banner
      tone="danger"
      role="alert"
      data-testid="storage-warning"
      data-warning={warning}
      className="flex items-start gap-2 border-b border-line"
    >
      <Icon name="triangle-alert" className="mt-0.5" />
      <p id={id} className={`min-w-0 flex-1 ${open ? '' : 'truncate'}`}>
        {text}
      </p>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={id}
        className="font-semibold whitespace-nowrap underline pointer-coarse:-my-2 pointer-coarse:min-h-11"
        onClick={() => {
          setOpen(!open);
        }}
      >
        {open ? m.storage.less : m.storage.details}
      </button>
    </Banner>
  );
}

/**
 * Whether the screens inside hold a vault: `none` for the first screen and the starts (D198),
 * `unknown` while starting, before the app knows.
 */
export const VaultHeld = createContext<'yes' | 'none' | 'unknown'>('yes');

/** Where a wizard's Cancel goes (D254): the header on a phone and on the start screens, if set. */
export const WizardPlace = createContext<{ readonly header: HTMLElement | null }>({ header: null });

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
  const held = useContext(VaultHeld);
  // Before unlock is where verifying the build matters most (D192).
  const [about, setAbout] = useAbout();
  const updates = useUpdates();
  const holdsPhrase = useSyncExternalStore(
    updates?.controller.subscribe ?? noUpdates,
    () => updates?.controller.holdsPhrase ?? false,
  );
  const [header, setHeader] = useState<HTMLElement | null>(null);
  return (
    <div className="flex min-h-dvh flex-col bg-surface text-fg">
      <SharedOriginWarning />
      <SafariTabWarning />
      <UpdateBanner />
      <main className="flex flex-1 items-center justify-center p-4">
        <section className="flex w-full max-w-sm flex-col gap-4 rounded-card bg-raised p-6 shadow-raised">
          {/* The app's name once (D254), and no lock state before a vault exists. */}
          <header className="flex flex-wrap items-center gap-2">
            {title === m.app.name ? null : (
              <span className="text-sm font-semibold">{m.app.name}</span>
            )}
            <PreviewBadge />
            <span className="flex-1" />
            {held === 'yes' ? <LockState unlocked={false} /> : null}
            {/* A wizard's Cancel (D254). */}
            <span ref={setHeader} className={about ? 'hidden' : 'contents'} />
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
          <div className={about ? 'hidden' : 'contents'}>
            <WizardPlace.Provider value={{ header }}>{children}</WizardPlace.Provider>
          </div>
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
