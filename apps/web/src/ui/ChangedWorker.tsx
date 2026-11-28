import { type UpdateMonitor } from '../app/updates';
import { useMessages } from '../i18n/context';
import { Button, Card } from './components';

/** In place of every screen once a changed `sw.js` was found, until dismissed (D63, D191). */
export function ChangedWorker({ monitor }: { readonly monitor: UpdateMonitor }) {
  const m = useMessages();
  return (
    <Card title={m.changedWorker.title} icon={{ name: 'triangle-alert', tone: 'warning' }}>
      <div role="alert" data-testid="changed-worker" className="flex flex-col gap-3">
        <p>{m.changedWorker.found}</p>
        <p className="text-sm text-muted">{m.changedWorker.notes}</p>
      </div>
      <Button
        variant="secondary"
        className="self-start"
        onClick={() => {
          monitor.acknowledge();
        }}
      >
        {m.changedWorker.continue}
      </Button>
    </Card>
  );
}
