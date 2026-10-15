import { useEffect, useState } from 'react';

import { type PasskeyOutcome, type Status, type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { safariTab } from '../app/storage-state';
import { Button, Card, Field, Notice, VaultHeld } from './components';
import { CreateVault } from './CreateVault';
import { EraseVault, eraseAdviceText } from './EraseVault';
import { JoinVault } from './Pairing';
import { ResetPassword } from './ResetPassword';
import { RestoreVault } from './RestoreVault';

/** Every screen before unlock, by controller status. */
export function Start({
  controller,
  status,
}: {
  readonly controller: VaultController;
  readonly status: Status;
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
        <Card title={m.app.name}>
          <p>{m.start.elsewhere}</p>
          <p className="text-sm text-zinc-500">{m.start.takeOverNote}</p>
          <Button onClick={() => void controller.takeOver()}>{m.start.takeOver}</Button>
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
          <NoVault controller={controller} status={status.kind} />
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

function Unlock({
  controller,
  working,
  onReplace,
  onPair,
  onReset,
  onErase,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly onReplace: () => void;
  readonly onPair: () => void;
  readonly onReset: () => void;
  readonly onErase: () => void;
}) {
  const m = useMessages();
  const [password, setPassword] = useState('');
  const [wrong, setWrong] = useState(false);
  const [passkey, setPasskey] = useState<PasskeyOutcome>('ok');
  const [supported, setSupported] = useState(false);
  useEffect(() => {
    let live = true;
    void controller.passkeysSupported().then((s) => {
      if (live) setSupported(s);
    });
    return () => {
      live = false;
    };
  }, [controller]);
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
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {eraseFailure === 'busy' ? m.erase.busy : m.erase.failed}
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
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
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
          }}
          error={wrong ? m.unlock.wrong : undefined}
          data-testid="unlock-password"
        />
        <Button type="submit" disabled={password === '' || working}>
          {working ? m.unlock.working : m.unlock.submit}
        </Button>
      </form>
      <Button variant="quiet" className="self-start" disabled={working} onClick={onReset}>
        {m.reset.forgot}
      </Button>
      <Button variant="quiet" className="self-start" disabled={working} onClick={onReplace}>
        {m.replace.choose}
      </Button>
      <Button variant="quiet" className="self-start" disabled={working} onClick={onPair}>
        {m.replace.pairChoose}
      </Button>
      <Button variant="quiet" className="self-start" disabled={working} onClick={onErase}>
        {m.erase.choose}
      </Button>
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
}: {
  readonly controller: VaultController;
  readonly status: 'no-vault' | 'creating' | 'restoring' | 'joining';
}) {
  const m = useMessages();
  const [choice, setChoice] = useState<'create' | 'pair' | 'restore' | undefined>();
  // Not stored: a reload shows the advice again (D198).
  const [inTab, setInTab] = useState(false);
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
    // No way back from here but a reload: the phrase screen has a single control (D179).
    return <CreateVault controller={controller} working={status === 'creating'} />;
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
        <p className="text-sm">{m.start.installWhy}</p>
        <p className="text-sm">{m.start.installHow}</p>
        <Button
          variant="quiet"
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
  return (
    <Card title={m.app.name}>
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
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm" data-testid="no-server">
        <li>{m.start.chooseIntro}</li>
        <li>{m.start.noReset}</li>
        <li>{m.start.recoveryOnly}</li>
      </ul>
      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            choose('create');
          }}
        >
          {m.start.create}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            choose('pair');
          }}
        >
          {m.start.pair}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            choose('restore');
          }}
        >
          {m.start.restore}
        </Button>
      </div>
    </Card>
  );
}
