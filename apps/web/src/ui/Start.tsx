import { useEffect, useState } from 'react';

import { type PasskeyOutcome, type Status, type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { safariTab } from '../app/storage-state';
import { Button, Card, Field, VaultHeld } from './components';
import { CreateVault } from './CreateVault';
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
    case 'update-required':
      return <Card title={m.app.name}>{m.start.updateRequired}</Card>;
    case 'corrupt':
      return <Card title={m.app.name}>{m.start.corrupt}</Card>;
    case 'no-vault':
    case 'creating':
    case 'restoring':
    case 'joining':
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

/** The locked vault: unlock it, or replace it by a backup without unlocking (§10, D153, D183). */
function Locked({
  controller,
  status,
}: {
  readonly controller: VaultController;
  readonly status: 'locked' | 'unlocking' | 'replacing' | 'resetting';
}) {
  const [choice, setChoice] = useState<'replace' | 'reset' | undefined>();
  const back = () => {
    setChoice(undefined);
  };
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
      onReset={() => {
        setChoice('reset');
      }}
    />
  );
}

function Unlock({
  controller,
  working,
  onReplace,
  onReset,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly onReplace: () => void;
  readonly onReset: () => void;
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
  return (
    <Card title={m.unlock.title}>
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
  return (
    <Card title={m.app.name}>
      <ul className="flex list-disc flex-col gap-2 pl-5 text-sm" data-testid="no-server">
        <li>{m.start.chooseIntro}</li>
        <li>{m.start.noReset}</li>
        <li>{m.start.recoveryOnly}</li>
      </ul>
      <div className="flex flex-col gap-2">
        <Button
          onClick={() => {
            setChoice('create');
          }}
        >
          {m.start.create}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setChoice('pair');
          }}
        >
          {m.start.pair}
        </Button>
        <Button
          variant="quiet"
          onClick={() => {
            setChoice('restore');
          }}
        >
          {m.start.restore}
        </Button>
      </div>
    </Card>
  );
}
