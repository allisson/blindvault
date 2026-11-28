import { type VaultSession } from '@blindvault/vault';
import { useEffect, useState } from 'react';

import { type VaultController } from '../app/controller';
import { devicesOf } from '../app/devices';
import { type Navigation, type SettingsFocus } from '../app/nav';
import { type Ready as ReadyState, type ReadyAdvice, readyAdvice } from '../app/ready';
import { useMessages } from '../i18n/context';
import { Badge, Button } from './components';
import { Icon } from './icons';
import { BlobNotices } from './RestoreVault';

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
  const [keystore, setKeystore] = useState(false);
  useEffect(() => {
    let live = true;
    void controller.passkeysSupported().then((s) => {
      if (live) setPasskeys(s);
    });
    void controller.keystoreStatus().then((s) => {
      if (live) setKeystore(s?.available === true);
    });
    return () => {
      live = false;
    };
  }, [controller]);
  const advice = readyAdvice({
    ready,
    devices: devicesOf(session).advice,
    passkeys,
    keystore,
    exportable: session.recovery !== undefined,
  });
  const text: Record<ReadyAdvice, string> = {
    passkey: m.ready.passkey,
    keystore: m.keystore.ready,
    'check-phrase': m.ready.checkPhrase,
    readmit: m.restore.readmit,
    pair: m.ready.pair,
    backup: m.ready.backup,
  };
  const action: Record<ReadyAdvice, { label: string; focus: SettingsFocus } | undefined> = {
    passkey: { label: m.ready.passkeyAction, focus: 'passkey' },
    keystore: { label: m.keystore.readyAction, focus: 'passkey' },
    'check-phrase': { label: m.ready.checkPhraseAction, focus: 'recovery' },
    readmit: { label: m.ready.readmitAction, focus: 'readmit' },
    pair: { label: m.ready.pairAction, focus: 'pair' },
    backup: { label: m.ready.backupAction, focus: 'backup' },
  };
  const done: Partial<Record<ReadyAdvice, boolean>> = {
    passkey: session.passkeyCredentialId !== undefined,
    keystore: session.keystoreSetUp,
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
      {ready.start === 'restored' && ready.blobs ? (
        <BlobNotices session={session} blobs={ready.blobs} />
      ) : null}
      {/* The steps in a card, each with its state mark (D315). */}
      <ol className="flex flex-col divide-y divide-line rounded-card border border-line bg-raised">
        {advice.map((a) => {
          const act = action[a];
          const isDone = done[a] === true;
          return (
            <li
              key={a}
              className="flex items-start gap-3 p-4"
              data-testid={`ready-${a}`}
              data-done={isDone ? 'true' : undefined}
            >
              <span className="flex h-5 items-center" aria-hidden="true">
                {isDone ? (
                  <Icon name="check" className="text-success" />
                ) : (
                  <span className="size-4 rounded-full border-2 border-control" />
                )}
              </span>
              <div className="flex min-w-0 flex-1 flex-col items-start gap-2">
                <p className="text-sm">
                  {text[a]}
                  {isDone ? <Badge className="ms-2">{m.ready.done}</Badge> : null}
                </p>
                {act ? (
                  <Button
                    variant="secondary"
                    onClick={() => {
                      nav.openSettings(act.focus);
                    }}
                  >
                    {act.label}
                  </Button>
                ) : null}
              </div>
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
