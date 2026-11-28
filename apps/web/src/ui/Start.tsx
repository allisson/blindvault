import { Fragment, type ReactNode, useEffect, useId, useState } from 'react';

import {
  type KeystoreOutcome,
  type PasskeyOutcome,
  type Status,
  type VaultController,
} from '../app/controller';
import { useMessages } from '../i18n/context';
import { safariTab } from '../app/storage-state';
import { platform } from '../platform';
import { Alert, Brand, Button, Card, Field, Notice, TARGET, VaultHeld } from './components';
import { CreateVault } from './CreateVault';
import { EraseVault, eraseAdviceText, eraseFailureText } from './EraseVault';
import { JoinVault } from './Pairing';
import { ResetPassword } from './ResetPassword';
import { Icon, type IconName } from './icons';
import { RestoreVault } from './RestoreVault';

/** "Continue in this tab" chosen on a Safari tab, held above Start (D198, D263). */
type InTab = readonly [boolean, (value: boolean) => void];

/** Every screen before unlock, by controller status. */
export function Start({
  controller,
  status,
  inTab,
}: {
  readonly controller: VaultController;
  readonly status: Status;
  readonly inTab: InTab;
}) {
  const m = useMessages();
  switch (status.kind) {
    case 'starting':
      return (
        // Whether a vault exists is not known yet: the Safari warning waits (D198).
        <VaultHeld.Provider value="unknown">
          <Card title={m.app.name}>{m.start.starting}</Card>
        </VaultHeld.Provider>
      );
    case 'unsupported':
      return <Card title={m.app.name}>{m.start.unsupported}</Card>;
    case 'busy':
      return (
        <Card title={m.app.name}>
          <p>{m.start.busy}</p>
          <Button onClick={() => void controller.start()}>{m.app.retry}</Button>
        </Card>
      );
    case 'elsewhere':
      return (
        <Card title={m.start.elsewhere} icon={{ name: 'app-window', tone: 'accent' }}>
          <p className="text-muted">{m.start.takeOverNote}</p>
          <Button className="self-start" onClick={() => void controller.takeOver()}>
            {m.start.takeOver}
          </Button>
        </Card>
      );
    case 'incomplete':
      return (
        <Card title={m.app.name}>
          <p role="alert">{m.start.incomplete}</p>
          <Button
            onClick={() => {
              location.reload();
            }}
          >
            {m.app.reload}
          </Button>
        </Card>
      );
    case 'erasing':
      return (
        <Card title={m.erase.title}>
          <p role="status">{m.erase.erasing}</p>
        </Card>
      );
    case 'update-required':
      return <Card title={m.app.name}>{m.start.updateRequired}</Card>;
    case 'corrupt':
      return <Card title={m.app.name}>{m.start.corrupt}</Card>;
    case 'no-vault':
    case 'creating':
    case 'restoring':
    case 'joining':
      if (status.kind === 'joining' && status.replacing) {
        return <Locked controller={controller} status="joining" />;
      }
      return (
        <VaultHeld.Provider value="none">
          <NoVault controller={controller} status={status.kind} inTab={inTab} />
        </VaultHeld.Provider>
      );
    case 'locked':
    case 'unlocking':
    case 'replacing':
    case 'resetting':
      return <Locked controller={controller} status={status.kind} />;
    case 'unlocked':
      return null;
  }
}

/**
 * The locked vault: unlock it, replace it without unlocking, by a backup or by pairing (§8.4,
 * §10, D150, D153, D183, D204), or erase it (§7, D205).
 */
function Locked({
  controller,
  status,
}: {
  readonly controller: VaultController;
  readonly status: 'locked' | 'unlocking' | 'replacing' | 'resetting' | 'joining';
}) {
  const m = useMessages();
  const [choice, setChoice] = useState<'replace' | 'pair' | 'reset' | 'erase' | undefined>();
  const back = () => {
    setChoice(undefined);
  };
  if (choice === 'erase') {
    return (
      <Card title={m.erase.title}>
        <p className="text-sm">{m.erase.intro}</p>
        <EraseVault controller={controller} advice={{ kind: 'locked' }} onCancel={back} />
      </Card>
    );
  }
  if (choice === 'pair' || status === 'joining') {
    return (
      <Card title={m.replace.pairTitle}>
        <div className="flex flex-col gap-2" data-testid="replace-warning">
          <Notice>{m.replace.pairWarning}</Notice>
          <p className="text-sm">{m.replace.retire}</p>
        </div>
        <JoinVault controller={controller} working={status === 'joining'} replace onCancel={back} />
      </Card>
    );
  }
  if (choice === 'reset' || status === 'resetting') {
    return (
      <ResetPassword controller={controller} working={status === 'resetting'} onCancel={back} />
    );
  }
  if (choice === 'replace' || status === 'replacing') {
    return (
      <RestoreVault
        controller={controller}
        working={status === 'replacing'}
        replace
        onCancel={back}
      />
    );
  }
  return (
    <Unlock
      controller={controller}
      working={status === 'unlocking'}
      onReplace={() => {
        setChoice('replace');
      }}
      onPair={() => {
        setChoice('pair');
      }}
      onReset={() => {
        setChoice('reset');
      }}
      onErase={() => {
        controller.dismissEraseFailure();
        setChoice('erase');
      }}
    />
  );
}

/**
 * The unlock card: the Keystore KEK, the unlock passkey or the local password. The ways out of a
 * locked vault (reset, replace, pair, erase) show only when given: the Android provider window
 * offers none, and gives its Cancel as `children` (android.md §7.1).
 */
export function Unlock({
  controller,
  working,
  onReplace,
  onPair,
  onReset,
  onErase,
  children,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly onReplace?: () => void;
  readonly onPair?: () => void;
  readonly onReset?: () => void;
  readonly onErase?: () => void;
  readonly children?: ReactNode;
}) {
  const m = useMessages();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [passkey, setPasskey] = useState<PasskeyOutcome>('ok');
  const [supported, setSupported] = useState(false);
  const [keystore, setKeystore] = useState<KeystoreOutcome>('ok');
  // Unknown until the shell answers: the button shows meanwhile, as the key may still open.
  const [biometric, setBiometric] = useState(true);
  useEffect(() => {
    let live = true;
    void controller.passkeysSupported().then((s) => {
      if (live) setSupported(s);
    });
    void controller.keystoreStatus().then((s) => {
      if (live && s) setBiometric(s.available);
    });
    return () => {
      live = false;
    };
  }, [controller]);
  const keystoreText = {
    ok: undefined,
    cancelled: m.keystore.cancelled,
    rejected: m.keystore.rejected,
    unavailable: m.keystore.unavailable,
    invalidated: undefined,
  }[keystore];
  const passkeyError = {
    ok: undefined,
    cancelled: m.unlock.passkeyCancelled,
    rejected: m.unlock.passkeyRejected,
    'no-user-verification': m.unlock.passkeyNoVerification,
    unavailable: m.unlock.passkeyUnavailable,
  }[passkey];
  const eraseFailure = controller.eraseFailure;
  return (
    <Card title={m.unlock.title}>
      {eraseFailure ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="erase-failure">
          <p role="alert" className="text-sm text-danger">
            {eraseFailureText(m, eraseFailure)}
          </p>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissEraseFailure();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {controller.keystoreInvalidated ? (
        <Notice>
          <span data-testid="keystore-invalidated">{m.keystore.invalidated}</span>
        </Notice>
      ) : null}
      {controller.hasKeystore && !biometric ? (
        <p className="text-sm text-muted">{m.keystore.unavailable}</p>
      ) : null}
      {controller.hasKeystore && biometric ? (
        <div className="flex flex-col gap-2">
          <Button
            disabled={working}
            onClick={() => {
              setWrong(false);
              setKeystore('ok');
              void controller.unlockWithKeystore().then((outcome) => {
                setKeystore(outcome);
                if (outcome === 'unavailable') setBiometric(false);
              });
            }}
          >
            {m.keystore.unlock}
          </Button>
          {keystoreText ? (
            <p role="alert" className="text-sm text-danger">
              {keystoreText}
            </p>
          ) : null}
        </div>
      ) : null}
      {supported && controller.hasPasskey ? (
        <div className="flex flex-col gap-2">
          <Button
            disabled={working}
            onClick={() => {
              setWrong(false);
              setPasskey('ok');
              // Called in the click itself: WebAuthn needs the user activation.
              void controller.unlockWithPasskey().then(setPasskey);
            }}
          >
            {m.unlock.passkey}
          </Button>
          {passkeyError ? (
            <p role="alert" className="text-sm text-danger">
              {passkeyError}
            </p>
          ) : null}
        </div>
      ) : null}
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          void controller.unlock(password).then((outcome) => {
            setWrong(outcome === 'wrong-password');
          });
          setPassword('');
        }}
      >
        <Field
          label={m.unlock.password}
          type="password"
          autoComplete="current-password"
          autoFocus
          value={password}
          onChange={(e) => {
            setPassword(e.target.value);
            setWrong(false);
            setPasskey('ok');
            setKeystore('ok');
          }}
          aria-invalid={wrong || undefined}
          data-testid="unlock-password"
        />
        {/* In a box of its own, not the field's error, so it is not missed (D315). */}
        {wrong ? <Alert data-testid="unlock-wrong">{m.unlock.wrong}</Alert> : null}
        <Button type="submit" disabled={password === '' || working}>
          {working ? m.unlock.working : m.unlock.submit}
        </Button>
      </form>
      {/* The ways out of a locked vault, as option cards on the unlock screen (D184, D204, D205,
          D315); erase in the danger tone. */}
      {onReset || onReplace || onPair || onErase ? (
        <div className="flex flex-col gap-2" data-testid="unlock-ways-out">
          {[
            { on: onReset, label: m.reset.forgot, danger: false },
            { on: onReplace, label: m.replace.choose, danger: false },
            { on: onPair, label: m.replace.pairChoose, danger: false },
            { on: onErase, label: m.erase.choose, danger: true },
          ].map(({ on, label, danger }) =>
            on ? (
              <button
                key={label}
                type="button"
                disabled={working}
                onClick={on}
                className={`${TARGET} flex items-center gap-2 rounded-card border bg-raised px-4 py-2 text-left text-sm font-medium enabled:hover:bg-subtle disabled:cursor-not-allowed disabled:opacity-60 ${danger ? 'border-danger text-danger-text' : 'border-line text-fg'}`}
              >
                <span className="flex-1">{label}</span>
                <Icon name="chevron-right" className="text-muted" />
              </button>
            ) : null,
          )}
        </div>
      ) : null}
      {children}
    </Card>
  );
}

/**
 * No vault yet: the three starts (overview §13.3, D198), after the advice to install first on a
 * Safari tab (D103). The pair start joins a pairing (§8.4, D203).
 */
function NoVault({
  controller,
  status,
  inTab: [inTab, setInTab],
}: {
  readonly controller: VaultController;
  readonly status: 'no-vault' | 'creating' | 'restoring' | 'joining';
  readonly inTab: InTab;
}) {
  const m = useMessages();
  const [choice, setChoice] = useState<'create' | 'pair' | 'restore' | undefined>();
  // Not stored: a reload shows the advice again (D198).
  const shown =
    status === 'creating'
      ? 'create'
      : status === 'restoring'
        ? 'restore'
        : status === 'joining'
          ? 'pair'
          : choice;
  const back = () => {
    setChoice(undefined);
  };
  // A start chosen: the erase notices have done their job (D205).
  const choose = (next: 'create' | 'pair' | 'restore') => {
    if (controller.erased) controller.dismissErased();
    if (controller.leftoverPasskey) controller.dismissLeftoverPasskey();
    setChoice(next);
  };
  if (shown === 'create') {
    return <CreateVault controller={controller} working={status === 'creating'} onCancel={back} />;
  }
  if (shown === 'restore') {
    return (
      <RestoreVault controller={controller} working={status === 'restoring'} onCancel={back} />
    );
  }
  if (shown === 'pair') {
    return (
      <Card title={m.join.title}>
        <JoinVault controller={controller} working={status === 'joining'} onCancel={back} />
      </Card>
    );
  }
  if (!inTab && safariTab()) {
    return (
      <Card title={m.start.installTitle}>
        <p className="text-muted">{m.start.installWhy}</p>
        <p className="flex items-center gap-4 rounded-card border border-line bg-raised p-4 text-sm">
          <span
            aria-hidden="true"
            className="flex size-8 shrink-0 items-center justify-center rounded-control bg-accent-soft text-accent-text"
          >
            <Icon name="share" />
          </span>
          {m.start.installHow}
        </p>
        <Button
          variant="secondary"
          onClick={() => {
            setInTab(true);
          }}
        >
          {m.start.continueTab}
        </Button>
      </Card>
    );
  }
  const erased = controller.erased;
  const erasedAdvice = erased ? eraseAdviceText(m, erased) : undefined;
  const hero = (
    <div className="flex w-full max-w-[35rem] flex-col gap-6 px-6 pt-6 sm:px-0 sm:pt-0">
      <Brand />
      <h1 className="text-[2rem] leading-[1.08] font-semibold tracking-[-0.03em] sm:text-[2.875rem]">
        {m.start.headline}
      </h1>
      <div className="flex flex-col gap-6" data-testid="no-server">
        <p className="text-lg text-muted">{m.start.chooseIntro}</p>
        <Devices />
        <ul className="flex flex-col gap-3 text-sm text-muted">
          <Point icon="check">{m.start.noReset}</Point>
          <Point icon="check">{m.start.recoveryOnly}</Point>
          {platform.kind === 'extension' ? (
            // The extension is a device of its own (extension.md §9, D267).
            <>
              <Point icon="info">{m.start.extensionDevice}</Point>
              <Point icon="info">{m.start.extensionPair}</Point>
              <Point icon="info">{m.start.extensionSync}</Point>
              <Point icon="info">{m.start.extensionVersionLock}</Point>
            </>
          ) : null}
          {platform.kind === 'android' ? (
            // The Android app is a device of its own (android.md §11, D269).
            <>
              <Point icon="info">{m.start.androidDevice}</Point>
              <Point icon="info">{m.start.androidPair}</Point>
              <Point icon="info">{m.start.androidSync}</Point>
            </>
          ) : null}
        </ul>
      </div>
    </div>
  );
  return (
    <Card title={m.start.chooseTitle} hero={hero}>
      {erased ? (
        <div className="flex flex-col gap-2" data-testid="erased">
          <Notice>{m.erase.done}</Notice>
          {erased.kind === 'named' || erased.kind === 'locked' ? (
            <p className="text-sm">{erasedAdvice}</p>
          ) : null}
          <Button
            variant="quiet"
            className="self-start"
            onClick={() => {
              controller.dismissErased();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {controller.leftoverPasskey ? (
        <div className="flex flex-wrap items-center gap-2" data-testid="leftover-passkey">
          <Notice>{m.erase.leftoverPasskey}</Notice>
          <Button
            variant="quiet"
            onClick={() => {
              controller.dismissLeftoverPasskey();
            }}
          >
            {m.restore.dismiss}
          </Button>
        </div>
      ) : null}
      {/* The three starts as option cards, create first in the accent (D316). */}
      <div className="flex flex-col gap-3">
        <StartOption
          icon="plus"
          title={m.start.create}
          note={m.start.createNote}
          primary
          onClick={() => {
            choose('create');
          }}
        />
        <StartOption
          icon="monitor-smartphone"
          title={m.start.pair}
          note={m.start.pairNote}
          onClick={() => {
            choose('pair');
          }}
        />
        <StartOption
          icon="download"
          title={m.start.restore}
          note={m.start.restoreNote}
          neutral
          onClick={() => {
            choose('restore');
          }}
        />
      </div>
    </Card>
  );
}

/** A start as an option card: its icon, its name and what it does (D316). */
function StartOption({
  icon,
  title,
  note,
  primary = false,
  neutral = false,
  onClick,
}: {
  readonly icon: IconName;
  readonly title: string;
  readonly note: string;
  readonly primary?: boolean;
  /** A mark in the neutral tone, not the accent's. */
  readonly neutral?: boolean;
  readonly onClick: () => void;
}) {
  const id = useId();
  // The button covers the card and names it by the title, described by the note: its own text
  // would make the note part of its name (D316).
  return (
    <div className={`relative rounded-card ${primary ? 'text-accent-ink' : 'text-fg'}`}>
      <button
        type="button"
        aria-labelledby={`${id}-title`}
        aria-describedby={`${id}-note`}
        onClick={onClick}
        className={`absolute inset-0 rounded-card ${primary ? 'bg-accent hover:bg-accent-hover' : 'border border-line bg-raised hover:bg-subtle'}`}
      />
      <div
        aria-hidden="true"
        className="pointer-events-none relative flex items-center gap-4 p-4 text-start"
      >
        <span
          className={`flex size-10 shrink-0 items-center justify-center rounded-control ${primary ? 'bg-accent-ink/15' : neutral ? 'bg-subtle text-muted' : 'bg-accent-soft text-accent-text'}`}
        >
          <Icon name={icon} />
        </span>
        <span className="flex min-w-0 flex-1 flex-col gap-1">
          <span id={`${id}-title`} className="font-semibold">
            {title}
          </span>
          <span id={`${id}-note`} className={`text-sm ${primary ? '' : 'text-muted'}`}>
            {note}
          </span>
        </span>
        <Icon name="chevron-right" className="shrink-0" />
      </div>
    </div>
  );
}

/** This device, another and a backup: where a vault lives (D316). Seen only. */
function Devices() {
  const m = useMessages();
  const places: readonly { readonly icon: IconName; readonly label: string }[] = [
    { icon: 'laptop', label: m.start.computer },
    { icon: 'smartphone', label: m.start.phone },
    { icon: 'upload', label: m.start.backup },
  ];
  return (
    <div aria-hidden="true" className="hidden items-start sm:flex">
      {places.map(({ icon, label }, i) => (
        <Fragment key={label}>
          {i > 0 ? (
            <span
              className={`mt-8 w-16 border-t-2 border-dashed ${i === 1 ? 'border-accent/35' : 'border-line'}`}
            />
          ) : null}
          <span className="flex w-28 flex-col items-center gap-2 text-sm text-muted">
            <span
              className={`flex size-16 items-center justify-center rounded-[1.125rem] ${i === 2 ? 'border-[1.5px] border-dashed border-line text-muted' : 'border border-line bg-raised text-fg'}`}
            >
              <Icon name={icon} className="size-8!" />
            </span>
            {label}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/** A point of the start screen, after its mark in the accent (D316). */
function Point({ icon, children }: { readonly icon: IconName; readonly children: ReactNode }) {
  return (
    <li className="flex items-start gap-3">
      <span className="flex h-5 shrink-0 items-center text-accent-text">
        <Icon name={icon} className="size-4" />
      </span>
      <span>{children}</span>
    </li>
  );
}
