import { type VaultSession } from '@blindvault/vault';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { type SyncPeer, type SyncStart, type VaultController } from '../app/controller';
import { type SyncCheck, type SyncStage } from '../app/sync';
import { useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Notice } from './components';
import { PasteText, PayloadText, SameNetwork } from './Pairing';

// The sync screens (§9.1, D216): the user picks the peer in Settings › Devices on both devices, then
// chooses on each whether it shows its code first or reads the other's. Each code is shown as a QR
// code and as text, and the other device scans or pastes it (D208); a code that does not open says
// why and the wait goes on (D215). The flow lives in the controller, so a lock ends it whatever is
// on screen. It ends once the devices are connected: the exchange of records comes with its tasks.

function sameId(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

function startError(m: Messages, outcome: SyncStart | undefined, name: string): string | undefined {
  switch (outcome) {
    case undefined:
    case 'ok':
    case 'locked':
      return undefined;
    case 'no-webrtc':
      return m.sync.unavailable;
    default:
      return format(m.sync.refused[outcome], { name });
  }
}

function pasteError(m: Messages, check: SyncCheck, name: string): string | undefined {
  return check === 'ok' || check === 'unavailable'
    ? undefined
    : format(m.sync.paste[check], { name });
}

/** The warning about hiding the app while a sync runs (D93, D105). */
function leavingText(m: Messages, session: VaultSession): string {
  const hidden = session.preferences.hiddenLockSeconds;
  return hidden === 0
    ? m.sync.leavingImmediate
    : format(m.sync.leaving, { seconds: String(hidden) });
}

function Stage({
  controller,
  stage,
  name,
  leaving,
  onClose,
}: {
  readonly controller: VaultController;
  readonly stage: SyncStage;
  readonly name: string;
  readonly leaving: string;
  readonly onClose: () => void;
}) {
  const m = useMessages();
  const s = m.sync;
  const close = () => {
    controller.cancelSync();
    onClose();
  };
  const cancel = (
    <Button variant="quiet" className="self-start" onClick={close} data-testid="sync-cancel">
      {s.cancel}
    </Button>
  );
  const channel = format(s.channel, { name });
  switch (stage.kind) {
    case 'preparing':
      return (
        <>
          <p role="status">{s.preparing}</p>
          {cancel}
        </>
      );
    case 'offer':
      return (
        <>
          <p className="text-sm">{format(s.offerIntro, { name })}</p>
          <PayloadText text={stage.text} label={s.offerLabel} channel={channel} />
          <Notice>{leaving}</Notice>
          <PasteText
            label={format(s.answerPaste, { name })}
            submit={s.connect}
            onPaste={(text) => controller.syncPayload(text)}
            errorOf={(check) => pasteError(m, check, name)}
          />
          {cancel}
        </>
      );
    case 'scan':
      return (
        <>
          <p className="text-sm">{format(s.scanIntro, { name })}</p>
          <Notice>{leaving}</Notice>
          <PasteText
            label={format(s.offerPaste, { name })}
            submit={s.next}
            onPaste={(text) => controller.syncPayload(text)}
            errorOf={(check) => pasteError(m, check, name)}
          />
          {cancel}
        </>
      );
    case 'answer':
      return (
        <>
          <p className="text-sm">{format(s.answerIntro, { name })}</p>
          <PayloadText text={stage.text} label={s.answerLabel} channel={channel} />
          <Notice>{leaving}</Notice>
          <p role="status">{s.waiting}</p>
          {cancel}
        </>
      );
    case 'connecting':
      return (
        <>
          <p role="status">{s.connecting}</p>
          {cancel}
        </>
      );
    case 'connected':
      return (
        <>
          <p role="status" data-testid="sync-connected">
            {format(s.connected, { name })}
          </p>
          <Button className="self-start" onClick={close} data-testid="sync-close">
            {s.close}
          </Button>
        </>
      );
    case 'failed':
      return (
        <>
          <p
            role="alert"
            className="text-sm text-red-700 dark:text-red-400"
            data-testid="sync-failed"
            data-reason={stage.reason}
          >
            {s.failed[stage.reason]}
          </p>
          <Button
            className="self-start"
            onClick={() => {
              controller.cancelSync();
            }}
            data-testid="sync-again"
          >
            {s.again}
          </Button>
        </>
      );
  }
}

/**
 * A sync with the device picked in Settings › Devices (§9.1, D216): no password; the user chooses
 * on each device whether it shows its code first or reads the other's.
 */
export function SyncDevice({
  controller,
  session,
  peer,
  onClose,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly peer: SyncPeer;
  readonly onClose: () => void;
}) {
  const m = useMessages();
  const s = m.sync;
  const stage = useSyncExternalStore(controller.subscribe, () => controller.sync);
  const current = useSyncExternalStore(controller.subscribe, () => controller.syncPeer);
  const [sameNetwork, setSameNetwork] = useState(false);
  const [outcome, setOutcome] = useState<SyncStart>();
  // Picking another device, closing this one or leaving Settings ends the sync in progress.
  useEffect(
    () => () => {
      controller.cancelSync();
    },
    [controller],
  );
  const name = peer.name;
  const mine = current && sameId(current.deviceId, peer.deviceId) ? stage : undefined;
  const start = (role: 'initiator' | 'responder') => {
    setOutcome(controller.startSync(peer.deviceId, role, { sameNetwork }));
  };
  const error = startError(m, outcome, name);
  return (
    <div className="flex flex-col gap-3" data-testid="sync">
      <h3 className="font-semibold">{format(s.title, { name })}</h3>
      {mine ? (
        <Stage
          controller={controller}
          stage={mine}
          name={name}
          leaving={leavingText(m, session)}
          onClose={onClose}
        />
      ) : (
        <>
          <p className="text-sm">{format(s.how, { name })}</p>
          <SameNetwork checked={sameNetwork} onChange={setSameNetwork} />
          {error ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              onClick={() => {
                start('initiator');
              }}
              data-testid="sync-first"
            >
              {s.first}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                start('responder');
              }}
              data-testid="sync-read"
            >
              {format(s.read, { name })}
            </Button>
            <Button variant="quiet" onClick={onClose}>
              {s.cancel}
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
