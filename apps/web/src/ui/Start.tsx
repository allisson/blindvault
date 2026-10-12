import { useCallback, useState } from 'react';

import { type Status, type VaultController } from '../app/controller';
import { deviceName } from '../app/device-name';
import { useMessages } from '../i18n/context';
import { Button, Card, Field } from './components';
import { NewPassword } from './NewPassword';

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
      return <CreateVault controller={controller} working={status.kind === 'creating'} />;
    case 'locked':
    case 'unlocking':
      return <Unlock controller={controller} working={status.kind === 'unlocking'} />;
    case 'unlocked':
      return null;
  }
}

function CreateVault({
  controller,
  working,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
}) {
  const m = useMessages();
  const [password, setPassword] = useState<string | null>(null);
  const onChange = useCallback((p: string | null) => {
    setPassword(p);
  }, []);
  return (
    <Card title={m.create.title}>
      <p className="text-sm">{m.create.intro}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          if (password) void controller.create(password, deviceName(navigator.userAgent));
        }}
      >
        <NewPassword
          label={m.create.password}
          confirmLabel={m.create.confirm}
          onChange={onChange}
        />
        <Button type="submit" disabled={!password || working}>
          {working ? m.create.working : m.create.submit}
        </Button>
      </form>
    </Card>
  );
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
  return (
    <Card title={m.unlock.title}>
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
