import { useSyncExternalStore } from 'react';

import { type Build, type VersionLock } from '../app/version-lock';
import { useMessages } from '../i18n/context';
import { RELEASES_URL } from './About';
import { Button, Card } from './components';

/** The extension's changed build, before any vault opens (extension.md §8.2). */
export function VersionLockScreen({ versionLock }: { readonly versionLock: VersionLock }) {
  const m = useMessages();
  const state = useSyncExternalStore(versionLock.subscribe, versionLock.getState);
  if (state.kind !== 'changed') {
    return <Card title={m.app.name}>{m.start.starting}</Card>;
  }
  return (
    <Card title={m.versionLock.title}>
      <div data-testid="version-lock" className="flex flex-col gap-3 text-sm">
        <p>{m.versionLock.intro}</p>
        <dl className="flex flex-col gap-2">
          <dt className="font-medium">{m.versionLock.previous}</dt>
          <dd data-testid="version-lock-previous">
            {state.previous ? <BuildText build={state.previous} /> : m.versionLock.unknown}
          </dd>
          <dt className="font-medium">{m.versionLock.running}</dt>
          <dd data-testid="version-lock-running">
            <BuildText build={state.running} />
          </dd>
        </dl>
        <p>{m.versionLock.verify}</p>
        <a
          href={`${RELEASES_URL}/tag/v${state.running.version}`}
          target="_blank"
          rel="noopener noreferrer"
          className="self-start underline"
        >
          {m.versionLock.release}
        </a>
      </div>
      <Button
        onClick={() => {
          versionLock.confirm();
        }}
      >
        {m.versionLock.confirm}
      </Button>
    </Card>
  );
}

function BuildText({ build }: { readonly build: Build }) {
  return (
    <span className="flex flex-col gap-1">
      <span>{build.version}</span>
      <code className="break-all select-all">{build.hash}</code>
    </span>
  );
}
