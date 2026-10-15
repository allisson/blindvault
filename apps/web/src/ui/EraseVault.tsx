import { useState } from 'react';

import { type VaultController } from '../app/controller';
import { type EraseAdvice } from '../app/devices';
import { useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Notice, TARGET } from './components';

// Erase (§7, D41, D183, D205): the warning, the Device record advice, then an explicit
// confirmation. No password: a locked vault must be erasable without one. The controller locks
// first, so whatever happens next shows on the start or the unlock screen.

/** What to say of this device's Device record, or nothing when there is none to retire. */
export function eraseAdviceText(m: Messages, advice: EraseAdvice): string | undefined {
  switch (advice.kind) {
    case 'named':
      return format(m.erase.named, { name: advice.name });
    case 'locked':
      return m.erase.locked;
    case 'unregistered':
      return m.erase.unregistered;
    case 'only-device':
      return undefined;
  }
}

export function EraseVault({
  controller,
  advice,
  onCancel,
  onBackup,
}: {
  readonly controller: VaultController;
  readonly advice: EraseAdvice;
  readonly onCancel: () => void;
  /** While unlocked: takes the user to the backup export (D188). */
  readonly onBackup?: () => void;
}) {
  const m = useMessages();
  const [understood, setUnderstood] = useState(false);
  const [working, setWorking] = useState(false);
  const text = eraseAdviceText(m, advice);
  return (
    <div className="flex flex-col gap-3" data-testid="erase-warning">
      <Notice>{m.erase.warning}</Notice>
      {advice.kind === 'only-device' ? (
        <>
          <Notice>{m.erase.onlyDevice}</Notice>
          {onBackup ? (
            <Button variant="quiet" className="self-start" onClick={onBackup}>
              {m.erase.backupNow}
            </Button>
          ) : null}
        </>
      ) : null}
      {text ? <p className="text-sm">{text}</p> : null}
      <label className={`${TARGET} flex items-center gap-2 text-sm`}>
        <input
          type="checkbox"
          checked={understood}
          onChange={(e) => {
            setUnderstood(e.target.checked);
          }}
          data-testid="erase-understood"
        />
        {m.erase.understand}
      </label>
      <div className="flex flex-wrap gap-2">
        <Button
          disabled={!understood || working}
          onClick={() => {
            setWorking(true);
            void controller.erase();
          }}
        >
          {working ? m.erase.erasing : m.erase.submit}
        </Button>
        <Button variant="quiet" disabled={working} onClick={onCancel}>
          {m.erase.cancel}
        </Button>
      </div>
    </div>
  );
}
