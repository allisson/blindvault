import { type SyncPurpose, type VaultSession } from '@blindvault/vault';
import { useEffect, useState, useSyncExternalStore } from 'react';

import { type SyncPeer, type SyncStart, type VaultController } from '../app/controller';
import { recordIdPrefix } from '../app/backup-file';
import { type SyncCheck, type SyncStage } from '../app/sync';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Notice } from './components';
import { MergeNotices } from './MergeBackup';
import { NetworkOptions, PasteText, PayloadText, Rejected } from './Pairing';
import { recordTypeName } from './Settings';
import { Wizard, WizardActions, type WizardStep, useStep } from './Wizard';

// The sync screens (§9.1, D216): the user picks the peer in Settings › Devices on both devices, then
// chooses on each whether it shows its code first or reads the other's. Each code is shown as a QR
// code and as text, and the other device scans or pastes it (D208); a code that does not open says
// why and the wait goes on (D215). The flow lives in the controller, so a lock ends it whatever is
// on screen. Once `Noise_KK` has verified the peer (D217), both exchange their records, and each shows
// what its merge did, its notices and the records it rejected (D222); either side's end shows on the
// other with its reason (D218). A retired device is told it is retired through the same screens,
// which then send it only its retired record (D219).

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

/** The steps of a sync, with what to do on `name` (D253). */
function syncSteps(m: Messages, name: string, how: string): readonly WizardStep[] {
  const s = m.sync;
  return [
    { name: s.steps.role, other: how },
    { name: s.steps.codes, other: m.wizard.codes },
    { name: s.steps.syncing, other: format(s.other.syncing, { name }) },
    { name: s.steps.done, other: format(s.other.done, { name }) },
  ];
}

/** The step `stage` belongs to; `undefined` for a failure (D253). */
function stageStep(stage: SyncStage): number | undefined {
  switch (stage.kind) {
    case 'preparing':
    case 'offer':
    case 'scan':
    case 'answer':
    case 'connecting':
      return 2;
    case 'connected':
      return 3;
    case 'synced':
      return 4;
    case 'failed':
      return undefined;
  }
}

function Stage({
  controller,
  session,
  stage,
  name,
  title,
  steps,
  leaving,
  onClose,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly stage: SyncStage;
  readonly name: string;
  readonly title: string;
  readonly steps: readonly WizardStep[];
  readonly leaving: string;
  readonly onClose: () => void;
}) {
  const step = useStep(stageStep(stage));
  const close = () => {
    controller.cancelSync();
    onClose();
  };
  const final = stage.kind === 'synced' || stage.kind === 'failed';
  return (
    <Wizard
      steps={steps}
      step={step}
      title={title}
      screen={!(stage.kind === 'synced' && stage.live)}
      onCancel={final ? undefined : close}
      cancelTestId="sync-cancel"
    >
      <StageBody
        controller={controller}
        session={session}
        stage={stage}
        name={name}
        leaving={leaving}
        onClose={onClose}
        close={close}
      />
    </Wizard>
  );
}

function StageBody({
  controller,
  session,
  stage,
  name,
  leaving,
  onClose,
  close,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly stage: SyncStage;
  readonly name: string;
  readonly leaving: string;
  readonly onClose: () => void;
  readonly close: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const s = m.sync;
  const channel = format(s.channel, { name });
  switch (stage.kind) {
    case 'preparing':
      return <p role="status">{s.preparing}</p>;
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
        </>
      );
    case 'answer':
      return (
        <>
          <p className="text-sm">{format(s.answerIntro, { name })}</p>
          <PayloadText text={stage.text} label={s.answerLabel} channel={channel} />
          <Notice>{leaving}</Notice>
          <p role="status">{s.waiting}</p>
        </>
      );
    case 'connecting':
      return <p role="status">{s.connecting}</p>;
    case 'connected':
      return (
        <p role="status" data-testid="sync-connected">
          {format(s.connected, { name })}
        </p>
      );
    case 'synced':
      return (
        <>
          <p role="status" data-testid="sync-done">
            {format(s.synced, { name })}
          </p>
          <MergeNotices
            result={stage.result}
            recovery={session.recovery}
            date={(at) => new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(at)}
          />
          <Rejected rejected={stage.result.rejected} testId="sync-rejected" />
          {stage.live ? (
            // Closing the panel keeps a live session open; ending it is its own action (D225, D234).
            <WizardActions>
              <Button onClick={onClose} data-testid="sync-close">
                {s.keepLive}
              </Button>
              <Button variant="quiet" onClick={close} data-testid="sync-end">
                {s.endLive}
              </Button>
            </WizardActions>
          ) : (
            <WizardActions>
              <Button onClick={close} data-testid="sync-close">
                {s.close}
              </Button>
            </WizardActions>
          )}
        </>
      );
    case 'failed':
      return (
        <>
          <p
            role="alert"
            className="text-sm text-danger"
            data-testid="sync-failed"
            data-reason={stage.reason}
          >
            {format(s.failed[stage.reason], {
              name,
              record: stage.record
                ? `${recordTypeName(m, stage.record.recordType)} ${recordIdPrefix(stage.record.recordId)}`
                : '',
            })}
          </p>
          <WizardActions>
            <Button
              onClick={() => {
                controller.cancelSync();
              }}
              data-testid="sync-again"
            >
              {s.again}
            </Button>
          </WizardActions>
        </>
      );
  }
}

/**
 * A sync with the device picked in Settings › Devices (§9.1, D216): no password; the user chooses
 * on each device whether it shows its code first or reads the other's. With `retirement`, the
 * session only tells a retired device that it is retired (§6, D219).
 */
export function SyncDevice({
  controller,
  session,
  peer,
  purpose = 'sync',
  onClose,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  readonly peer: SyncPeer;
  readonly purpose?: SyncPurpose;
  readonly onClose: () => void;
}) {
  const m = useMessages();
  const s = m.sync;
  const stage = useSyncExternalStore(controller.subscribe, () => controller.sync);
  const current = useSyncExternalStore(controller.subscribe, () => controller.syncPeer);
  const [sameNetwork, setSameNetwork] = useState(false);
  const [outcome, setOutcome] = useState<SyncStart>();
  // Picking another device, closing this one or leaving Settings ends the sync in progress, unless
  // it is live (D225).
  useEffect(
    () => () => {
      controller.leaveSync();
    },
    [controller],
  );
  const name = peer.name;
  const mine = current && sameId(current.deviceId, peer.deviceId) ? stage : undefined;
  const unseen = mine?.kind === 'synced' && mine.unseen;
  useEffect(() => {
    if (unseen) controller.seenSync();
  }, [controller, unseen]);
  const start = (role: 'initiator' | 'responder') => {
    setOutcome(controller.startSync(peer.deviceId, role, { sameNetwork }, purpose));
  };
  const error = startError(m, outcome, name);
  const steps = syncSteps(
    m,
    name,
    format(purpose === 'retirement' ? s.notifyHow : s.how, { name }),
  );
  const title = format(purpose === 'retirement' ? s.notifyTitle : s.title, { name });
  return (
    <div className="flex flex-col gap-3" data-testid="sync">
      {mine ? (
        <Stage
          controller={controller}
          session={session}
          stage={mine}
          name={name}
          title={title}
          steps={steps}
          leaving={leavingText(m, session)}
          onClose={onClose}
        />
      ) : (
        <Wizard steps={steps} step={1} title={title} onCancel={onClose}>
          <p className="text-sm">{format(s.chooseRole, { name })}</p>
          <NetworkOptions checked={sameNetwork} onChange={setSameNetwork} />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <WizardActions>
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
          </WizardActions>
        </Wizard>
      )}
    </div>
  );
}
