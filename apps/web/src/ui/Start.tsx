import { useEffect, useState } from 'react';

import { type PasskeyOutcome, type Status, type VaultController } from '../app/controller';
import { useMessages } from '../i18n/context';
import { Button, Card, Field } from './components';
import { CreateVault } from './CreateVault';
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
      return <Card title={m.app.name}>{m.start.starting}</Card>;
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
    case 'update-required':
      return <Card title={m.app.name}>{m.start.updateRequired}</Card>;
    case 'corrupt':
      return <Card title={m.app.name}>{m.start.corrupt}</Card>;
    case 'no-vault':
    case 'creating':
    case 'restoring':
      return <NoVault controller={controller} status={status.kind} />;
    case 'locked':
    case 'unlocking':
      return <Unlock controller={controller} working={status.kind === 'unlocking'} />;
    case 'unlocked':
      return null;
  }
}

function Unlock({
  controller,
  working,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
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
    </Card>
  );
}

/** No vault yet: create one, or restore one from a backup (overview §10, §13.3). */
function NoVault({
  controller,
  status,
}: {
  readonly controller: VaultController;
  readonly status: 'no-vault' | 'creating' | 'restoring';
}) {
  const m = useMessages();
  const [choice, setChoice] = useState<'create' | 'restore' | undefined>();
  const shown = status === 'creating' ? 'create' : status === 'restoring' ? 'restore' : choice;
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
  return (
    <Card title={m.app.name}>
      <p className="text-sm">{m.start.chooseIntro}</p>
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
            setChoice('restore');
          }}
        >
          {m.start.restore}
        </Button>
      </div>
    </Card>
  );
}
