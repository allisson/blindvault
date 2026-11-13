import { type VaultSession } from '@blindvault/vault';
import { useEffect, useState } from 'react';

import { type VaultController } from '../app/controller';
import { devicesOf } from '../app/devices';
import { type Navigation, type SettingsFocus } from '../app/nav';
import { type Ready as ReadyState, type ReadyAdvice, readyAdvice } from '../app/ready';
import { useMessages } from '../i18n/context';
import { Badge, Button } from './components';

// "Vault ready" after a creation, a restore or a pairing (overview §13.3, D198, D203): the
// recommendations in order, each opening Settings at its section, the pairing and the re-admission
// already open. Back from Settings returns here, with the passkey and the backup marked once done
// (D234); "Open the vault" closes it.

export function Ready({
  controller,
  session,
  nav,
  ready,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly nav: Navigation;
  readonly ready: ReadyState;
}) {
  const m = useMessages();
  const [passkeys, setPasskeys] = useState(false);
  useEffect(() => {
    let live = true;
    void controller.passkeysSupported().then((s) => {
      if (live) setPasskeys(s);
    });
    return () => {
      live = false;
    };
  }, [controller]);
  const advice = readyAdvice({
    ready,
    devices: devicesOf(session).advice,
    passkeys,
    exportable: session.recovery !== undefined,
  });
  const text: Record<ReadyAdvice, string> = {
    passkey: m.ready.passkey,
    'check-phrase': m.ready.checkPhrase,
    readmit: m.restore.readmit,
    pair: m.ready.pair,
    backup: m.ready.backup,
  };
  const action: Record<ReadyAdvice, { label: string; focus: SettingsFocus } | undefined> = {
    passkey: { label: m.ready.passkeyAction, focus: 'passkey' },
    'check-phrase': { label: m.ready.checkPhraseAction, focus: 'recovery' },
    readmit: { label: m.ready.readmitAction, focus: 'readmit' },
    pair: { label: m.ready.pairAction, focus: 'pair' },
    backup: { label: m.ready.backupAction, focus: 'backup' },
  };
  const done: Partial<Record<ReadyAdvice, boolean>> = {
    passkey: session.passkeyCredentialId !== undefined,
    backup: session.lastBackupAt !== undefined,
  };
  return (
    <section
      aria-labelledby="ready-title"
      className="flex max-w-md flex-col gap-4 p-4"
      data-testid="ready"
    >
      <h1 id="ready-title" className="text-title">
        {m.ready.title}
      </h1>
      <p className="text-sm">{m.ready.intro}</p>
      <ol className="flex flex-col gap-4">
        {advice.map((a) => {
          const act = action[a];
          return (
            <li
              key={a}
              className="flex flex-col items-start gap-2"
              data-testid={`ready-${a}`}
              data-done={done[a] === true ? 'true' : undefined}
            >
              <p className="text-sm">
                {text[a]}
                {done[a] === true ? <Badge className="ms-2">{m.ready.done}</Badge> : null}
              </p>
              {act ? (
                <Button
                  variant="quiet"
                  onClick={() => {
                    nav.openSettings(act.focus);
                  }}
                >
                  {act.label}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ol>
      <Button
        className="self-start"
        onClick={() => {
          controller.dismissReady();
        }}
      >
        {m.ready.open}
      </Button>
    </section>
  );
}
