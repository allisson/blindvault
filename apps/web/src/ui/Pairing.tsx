import { DEFAULT_PREFERENCES, type RejectedRecord, type VaultSession } from '@blindvault/vault';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { recordIdPrefix } from '../app/backup-file';
import {
  type ExportAuth,
  type PairingFlow,
  type PairingStart,
  type ReadmissionStart,
  type VaultController,
} from '../app/controller';
import { deviceName } from '../app/device-name';
import { type PairingStage, type PayloadCheck } from '../app/pairing';
import {
  DEFAULT_STUN_URLS,
  type StunList,
  type StunSettings,
  loadStunSettings,
  parseStunList,
  resetStunList,
  saveStunList,
  stunHosts,
} from '../app/stun-settings';
import { useLanguage, useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, CopyCheck, Field, Notice, TARGET, TextArea, useCheck } from './components';
import { MergeNotices } from './MergeBackup';
import { NewPassword } from './NewPassword';
import { Icon } from './icons';
import { QrCode, QrScanner } from './Qr';
import { recordTypeName } from './Settings';
import { AdvancedOptions, Wizard, type WizardStep, useStep } from './Wizard';

// The pairing screens (§8.4, D202, D203): A invites from Settings › Devices, B joins from the pair
// start. Each payload is shown as a QR code and as text; the other device scans it or pastes it
// (D208). Both devices show the SAS, and the user says on each
// whether it matches. A re-admission (§9, D207) runs from Settings › Devices on both devices, either
// one showing its text first. The flow lives in the controller, so a lock ends it whatever is on
// screen.

/** The stage of the pairing in progress, when it is `flow`. */
function usePairing(controller: VaultController, flow: PairingFlow): PairingStage | undefined {
  const stage = useSyncExternalStore(controller.subscribe, () => controller.pairing);
  const current = useSyncExternalStore(controller.subscribe, () => controller.pairingFlow);
  return current === flow ? stage : undefined;
}

/** Six digits in two groups of three (pairing-protocol.md §6.2). */
function grouped(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

function payloadError(
  m: Messages,
  check: PayloadCheck | undefined,
  flow: PairingFlow,
): string | undefined {
  const p = m.pairing;
  switch (check) {
    case undefined:
    case 'ok':
    case 'unavailable':
      return undefined;
    case 'invalid':
      return p.pasteInvalid;
    case 'version':
      return p.pasteVersion;
    case 'wrong-session':
      return p.pasteWrongSession;
    case 'outdated-peer':
      return p.pasteOutdated;
    case 'peer-holds-vault':
      return p.pastePeerHoldsVault;
    case 'peer-no-vault':
      return flow === 'readmit' ? m.readmission.pastePeerNoVault : p.pastePeerNoVault;
  }
}

function failure(
  m: Messages,
  stage: Extract<PairingStage, { kind: 'failed' }>,
  flow: PairingFlow,
): string {
  if (flow === 'readmit') {
    // `unsupported-format` names the device to update: the one that refused (D206, D207).
    const r = m.readmission.failed;
    if (stage.reason === 'unsupported-format') {
      return stage.by === 'local' ? r.unsupportedFormat : r.unsupportedFormatRemote;
    }
    return reasonText(r, stage);
  }
  return reasonText(m.pairing.failed, stage);
}

function reasonText(
  f: Omit<Messages['pairing']['failed'], 'unsupportedFormat'> & {
    readonly unsupportedFormat: string;
  },
  stage: Extract<PairingStage, { kind: 'failed' }>,
): string {
  switch (stage.reason) {
    case 'cancelled':
      return stage.by === 'local' ? f.cancelled : f.cancelledRemote;
    case 'sas-mismatch':
      return f.sasMismatch;
    case 'locked':
      return f.locked;
    case 'expired':
      return f.expired;
    case 'retired-peer':
      return f.retiredPeer;
    case 'different-vaults':
      return f.differentVaults;
    case 'unsupported-format':
      return f.unsupportedFormat;
    case 'verification-failed':
      return f.verificationFailed;
    case 'version':
      return f.version;
    case 'protocol-error':
      return f.protocolError;
    case 'closed':
      return f.closed;
  }
}

/**
 * "Same network only", and the STUN list used otherwise (D203, D209). A stored list that cannot be
 * read uses no STUN server, so the option is then on and cannot be turned off until the list is
 * fixed or the defaults restored; the controller reads the list again when the pairing starts.
 */
export function SameNetwork({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const m = useMessages();
  const [settings, setSettings] = useState(loadStunSettings);
  const forced = settings.kind === 'unreadable';
  const urls = settings.kind === 'custom' ? settings.urls : DEFAULT_STUN_URLS;
  return (
    <div className="flex flex-col gap-1">
      <label className={`${TARGET} flex items-center gap-2 text-sm`}>
        <input
          type="checkbox"
          checked={checked || forced}
          disabled={forced}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
          data-testid="pairing-same-network"
        />
        {m.pairing.sameNetwork}
      </label>
      {forced ? (
        <p role="alert" className="text-sm text-danger" data-testid="stun-unreadable">
          {m.stun.unreadable}
        </p>
      ) : (
        <p className="text-sm text-muted" data-testid="same-network-hint">
          {format(m.pairing.sameNetworkHint, { hosts: stunHosts(urls).join(', ') })}
        </p>
      )}
      {checked && !forced ? null : (
        <StunServers
          settings={settings}
          onSaved={() => {
            setSettings(loadStunSettings());
          }}
        />
      )}
    </div>
  );
}

/**
 * "Same network only" in the advanced options of a wizard's first step, open at once when the stored
 * STUN list cannot be read, which forces it (D209, D253).
 */
export function NetworkOptions({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const [unreadable] = useState(() => loadStunSettings().kind === 'unreadable');
  return (
    <AdvancedOptions open={unreadable}>
      <SameNetwork checked={checked} onChange={onChange} />
    </AdvancedOptions>
  );
}

function stunProblem(m: Messages, list: Extract<StunList, { kind: 'invalid' }>): string {
  const p = m.stun.problems;
  const url = list.url ?? '';
  switch (list.problem) {
    case 'scheme':
      return format(p.scheme, { url });
    case 'query':
      return format(p.query, { url });
    case 'host':
      return format(p.host, { url });
    case 'port':
      return format(p.port, { url });
    case 'too-long':
      return format(p.tooLong, { url });
    case 'empty':
      return p.empty;
    case 'too-many':
      return p.tooMany;
  }
}

/** The STUN list in use, with Edit and Restore the defaults (D209). */
function StunServers({
  settings,
  onSaved,
}: {
  readonly settings: StunSettings;
  readonly onSaved: () => void;
}) {
  const m = useMessages();
  const s = m.stun;
  const [open, setOpen] = useState(settings.kind === 'unreadable');
  const [editing, setEditing] = useState(false);
  const [text, setText] = useState('');
  const [error, setError] = useState<string>();
  const urls = settings.kind === 'custom' ? settings.urls : DEFAULT_STUN_URLS;
  if (!open) {
    return (
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          setOpen(true);
        }}
        data-testid="stun-open"
      >
        {s.open}
      </Button>
    );
  }
  const save = () => {
    const list = parseStunList(text);
    if (list.kind === 'invalid') {
      setError(stunProblem(m, list));
      return;
    }
    if (!saveStunList(list.urls)) {
      setError(s.notSaved);
      return;
    }
    setEditing(false);
    onSaved();
  };
  return (
    <div className="flex flex-col gap-2" data-testid="stun">
      <p className="text-sm">{s.intro}</p>
      {settings.kind === 'unreadable' ? null : (
        <ul className="font-mono text-sm break-all" data-testid="stun-list">
          {urls.map((url) => (
            <li key={url}>{url}</li>
          ))}
        </ul>
      )}
      {settings.kind === 'default' ? <p className="text-sm text-muted">{s.defaults}</p> : null}
      {editing ? (
        <>
          <TextArea
            label={s.label}
            value={text}
            error={error}
            onChange={(e) => {
              setText(e.target.value);
              setError(undefined);
            }}
            data-testid="stun-text"
          />
          <div className="flex flex-wrap gap-2">
            <Button onClick={save} data-testid="stun-save">
              {s.save}
            </Button>
            <Button
              variant="quiet"
              onClick={() => {
                setEditing(false);
                setError(undefined);
              }}
            >
              {s.cancel}
            </Button>
          </div>
        </>
      ) : (
        <div className="flex flex-wrap gap-2">
          <Button
            variant="quiet"
            onClick={() => {
              setText(urls.join('\n'));
              setEditing(true);
            }}
            data-testid="stun-edit"
          >
            {s.edit}
          </Button>
          {settings.kind === 'default' ? null : (
            <Button
              variant="quiet"
              onClick={() => {
                resetStunList();
                onSaved();
              }}
              data-testid="stun-reset"
            >
              {s.reset}
            </Button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * A payload for the other device, as a QR code to scan and a text to copy, with what whoever sees
 * the code or carries the text learns: a pairing's addresses by default (D117, D208).
 */
export function PayloadText({
  text,
  label,
  channel,
}: {
  readonly text: string;
  readonly label: string;
  readonly channel?: string;
}) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);
  const [checked, check] = useCheck();
  return (
    <div className="flex flex-col gap-2">
      <QrCode text={text} label={m.pairing.qrLabel} />
      <TextArea label={label} value={text} readOnly data-testid="pairing-text" />
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          // Not a secret: no clearing, unlike a copied field (D54).
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
              check();
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        <CopyCheck shown={checked} />
        {copied ? m.pairing.copied : m.pairing.copy}
      </Button>
      <p className="text-sm text-muted">{channel ?? m.pairing.channel}</p>
    </div>
  );
}

/** A text scanned from the other device's QR code, or pasted (D208): `errorOf` says why not taken. */
export function PasteText<C extends string>({
  label,
  submit,
  onPaste,
  errorOf,
}: {
  readonly label: string;
  readonly submit: string;
  readonly onPaste: (text: string) => Promise<C>;
  readonly errorOf: (check: C) => string | undefined;
}) {
  const [text, setText] = useState('');
  const [check, setCheck] = useState<C>();
  const [working, setWorking] = useState(false);
  const take = async (value: string): Promise<boolean> => {
    setWorking(true);
    const outcome = await onPaste(value);
    setWorking(false);
    setCheck(outcome);
    return outcome === 'ok';
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        void take(text);
      }}
    >
      <QrScanner
        onRead={(value) => {
          // A text read goes through the same checks as a pasted one.
          setText(value);
          return take(value);
        }}
      />
      <TextArea
        label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCheck(undefined);
        }}
        error={check === undefined ? undefined : errorOf(check)}
        data-testid="pairing-paste"
      />
      <Button type="submit" className="self-start" disabled={text.trim() === '' || working}>
        {submit}
      </Button>
    </form>
  );
}

/** Records the other device sent that a re-admission or a sync rejected, with why (D206, D207, D222). */
export function Rejected({
  rejected,
  testId = 'readmission-rejected',
}: {
  readonly rejected: readonly RejectedRecord[];
  readonly testId?: string;
}) {
  const m = useMessages();
  if (rejected.length === 0) return null;
  return (
    <Notice>
      <span data-testid={testId}>{rejectedText(m, rejected)}</span>
    </Notice>
  );
}

/** Each rejected record by its type and ID prefix, or as one that does not decode, with why. */
export function rejectedText(m: Messages, rejected: readonly RejectedRecord[]): string {
  const r = m.readmission;
  const records = rejected
    .map(({ reason, record }) =>
      record
        ? `${recordTypeName(m, record.recordType)} ${recordIdPrefix(record.recordId)} (${r.rejectedReasons[reason]})`
        : `${r.rejectedNoKey} (${r.rejectedReasons[reason]})`,
    )
    .join(', ');
  return format(r.rejected, { n: String(rejected.length), records });
}

/** The steps of each flow, with what to do on the other device (D253). */
function flowSteps(m: Messages, flow: PairingFlow): readonly WizardStep[] {
  const w = m.wizard;
  switch (flow) {
    case 'invite': {
      const p = m.pairing;
      return [
        { name: p.steps.auth, other: p.other.auth },
        { name: p.steps.codes, other: p.other.codes },
        { name: p.steps.sas, other: w.sas },
        { name: p.steps.done, other: p.other.done },
      ];
    }
    case 'join': {
      const j = m.join;
      return [
        { name: j.steps.password, other: j.other.password },
        { name: j.steps.scan, other: j.other.scan },
        { name: j.steps.answer, other: j.other.answer },
        { name: j.steps.sas, other: w.sas },
        { name: j.steps.done, other: j.other.done },
      ];
    }
    case 'readmit': {
      const r = m.readmission;
      return [
        { name: r.steps.role, other: r.how },
        { name: r.steps.codes, other: w.codes },
        { name: r.steps.sas, other: w.sas },
        { name: r.steps.done, other: r.otherDone },
      ];
    }
  }
}

/**
 * The step `stage` belongs to: preparing and connecting wait within the exchange of codes, and the
 * transfer within the numbers' step (D253). `undefined` for a failure.
 */
function stageStep(flow: PairingFlow, stage: PairingStage): number | undefined {
  const join = flow === 'join';
  switch (stage.kind) {
    case 'preparing':
    case 'offer':
    case 'scan':
      return 2;
    case 'answer':
    case 'connecting':
      return join ? 3 : 2;
    case 'sas':
    case 'transfer':
      return join ? 4 : 3;
    case 'done':
    case 'readmitted':
      return join ? 5 : 4;
    case 'failed':
      return undefined;
  }
}

/** Every stage after the start, on either device, as a step of the wizard (D253). */
function Stage({
  controller,
  session,
  stage,
  flow,
  leaving,
  onAgain,
}: {
  readonly controller: VaultController;
  /** The vault this device holds, when it holds one unlocked. */
  readonly session?: VaultSession;
  readonly stage: PairingStage;
  readonly flow: PairingFlow;
  /** What hiding the app does to the pairing (D93, D105). */
  readonly leaving: string;
  readonly onAgain: () => void;
}) {
  const m = useMessages();
  const step = useStep(stageStep(flow, stage));
  // Nothing to cancel once the vault is on its way, done or failed.
  const final =
    stage.kind === 'transfer' ||
    stage.kind === 'done' ||
    stage.kind === 'readmitted' ||
    stage.kind === 'failed';
  return (
    <Wizard
      steps={flowSteps(m, flow)}
      step={step}
      onCancel={
        final
          ? undefined
          : () => {
              controller.cancelPairing();
            }
      }
      cancelTestId="pairing-cancel"
    >
      <StageBody
        controller={controller}
        session={session}
        stage={stage}
        flow={flow}
        leaving={leaving}
        onAgain={onAgain}
      />
    </Wizard>
  );
}

function StageBody({
  controller,
  session,
  stage,
  flow,
  leaving,
  onAgain,
}: {
  readonly controller: VaultController;
  readonly session?: VaultSession | undefined;
  readonly stage: PairingStage;
  readonly flow: PairingFlow;
  readonly leaving: string;
  readonly onAgain: () => void;
}) {
  const { messages: m, language } = useLanguage();
  const p = m.pairing;
  const r = m.readmission;
  const readmit = flow === 'readmit';
  switch (stage.kind) {
    case 'preparing':
      return <p role="status">{p.preparing}</p>;
    case 'offer':
      return (
        <>
          <p className="text-sm">{readmit ? r.offerIntro : p.offerIntro}</p>
          <PayloadText text={stage.text} label={p.offerLabel} />
          <Notice>{leaving}</Notice>
          <PasteText
            label={readmit ? r.answerPaste : p.answerPaste}
            submit={p.connect}
            onPaste={(text) => Promise.resolve(controller.pairingAnswer(text))}
            errorOf={(check) => payloadError(m, check, flow)}
          />
        </>
      );
    case 'scan':
      return (
        <>
          <p className="text-sm">{readmit ? r.scanIntro : m.join.scanIntro}</p>
          <Notice>{leaving}</Notice>
          <PasteText
            label={readmit ? r.offerPaste : m.join.offerPaste}
            submit={m.join.next}
            onPaste={(text) => controller.joinOffer(text)}
            errorOf={(check) => payloadError(m, check, flow)}
          />
        </>
      );
    case 'answer':
      return (
        <>
          <p className="text-sm">{readmit ? r.answerIntro : m.join.answerIntro}</p>
          <PayloadText text={stage.text} label={m.join.answerLabel} />
          <Notice>{leaving}</Notice>
          <p role="status">{m.join.waitingConnection}</p>
        </>
      );
    case 'connecting':
      return <p role="status">{p.connecting}</p>;
    case 'sas':
      return (
        <>
          <h3 className="font-semibold">{p.sasTitle}</h3>
          <p
            className="font-mono text-4xl tracking-widest"
            data-testid="pairing-sas"
            aria-label={stage.sas.split('').join(' ')}
          >
            {grouped(stage.sas)}
          </p>
          <p className="text-sm">{p.sasQuestion}</p>
          {stage.confirmed ? (
            <p role="status">{p.waiting}</p>
          ) : (
            <div className="flex flex-wrap gap-2">
              <Button
                onClick={() => {
                  controller.confirmSas();
                }}
                data-testid="pairing-match"
              >
                {p.match}
              </Button>
              <Button
                variant="quiet"
                onClick={() => {
                  controller.rejectSas();
                }}
                data-testid="pairing-differ"
              >
                {p.differ}
              </Button>
            </div>
          )}
        </>
      );
    case 'transfer':
      return (
        <p role="status">
          {readmit ? r.merging : flow === 'invite' ? p.sending : m.join.receiving}
        </p>
      );
    case 'done':
      return (
        <>
          <p role="status" data-testid="pairing-done">
            {format(p.done, { name: stage.name })}
          </p>
          {stage.readmit ? <Notice>{format(p.readmit, { name: stage.name })}</Notice> : null}
          <Button
            className="self-start"
            onClick={() => {
              controller.cancelPairing();
            }}
          >
            {p.close}
          </Button>
        </>
      );
    case 'readmitted':
      return (
        <>
          <p role="status" data-testid="readmission-done">
            {format(r.done, { name: stage.name })}
          </p>
          {stage.peerCommitted ? null : (
            <Notice>
              <span data-testid="readmission-not-committed">{r.notCommitted}</span>
            </Notice>
          )}
          <MergeNotices
            result={stage.result}
            recovery={session?.recovery}
            date={(at) => new Intl.DateTimeFormat(language, { dateStyle: 'long' }).format(at)}
          />
          <Rejected rejected={stage.result.rejected} />
          <Button
            className="self-start"
            onClick={() => {
              controller.cancelPairing();
            }}
            data-testid="readmission-close"
          >
            {p.close}
          </Button>
        </>
      );
    case 'failed':
      return (
        <>
          <p
            role="alert"
            className="text-sm text-danger"
            data-testid="pairing-failed"
            data-reason={stage.reason}
          >
            {failure(m, stage, flow)}
          </p>
          <Button className="self-start" onClick={onAgain} data-testid="pairing-again">
            {p.again}
          </Button>
        </>
      );
  }
}

function startError(m: Messages, outcome: PairingStart | undefined): string | undefined {
  const p = m.pairing;
  switch (outcome) {
    case undefined:
    case 'ok':
    case 'locked':
      return undefined;
    case 'wrong-password':
      return p.wrong;
    case 'cancelled':
      return p.passkeyCancelled;
    case 'rejected':
    case 'no-user-verification':
    case 'unavailable':
      return p.passkeyFailed;
    case 'no-webrtc':
      return p.unavailable;
    case 'read-only':
      return p.readOnly;
    case 'retired':
      return p.retired;
    case 'corrupt-record':
      return p.corrupt;
  }
}

/** The warning about hiding the app while a pairing or re-admission runs (D93, D105). */
function leavingText(m: Messages, session: VaultSession): string {
  const hidden = session.preferences.hiddenLockSeconds;
  return hidden === 0
    ? m.pairing.leavingImmediate
    : format(m.pairing.leaving, { seconds: String(hidden) });
}

/** Why this vault offers no pairing now (D45, D102, D202), or `undefined`. */
function blocked(m: Messages, session: VaultSession): string | undefined {
  if (session.retired) return m.pairing.retired;
  if (!session.writable) return m.pairing.readOnly;
  if (session.corrupt().length > 0) return m.pairing.corrupt;
  return undefined;
}

/** Settings › Devices offers pairing and re-admission as two cards (D254). */
const CARD = 'flex flex-col gap-3 rounded-card border border-line bg-raised p-4';

/** A, in Settings › Devices: the password again, then the pairing (D202). */
export function InviteDevice({
  controller,
  session,
  open: startOpen = false,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  /** From "Vault ready": the password step is shown at once (D234). */
  readonly open?: boolean;
}) {
  const m = useMessages();
  const p = m.pairing;
  const stage = usePairing(controller, 'invite');
  const [open, setOpen] = useState(startOpen);
  const [password, setPassword] = useState('');
  const [sameNetwork, setSameNetwork] = useState(false);
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<PairingStart>();
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
  // Leaving Settings ends a pairing in progress, as for a re-founding.
  useEffect(
    () => () => {
      controller.cancelPairing();
    },
    [controller],
  );
  const leaving = leavingText(m, session);
  const start = (auth: ExportAuth) => {
    setWorking(true);
    setOutcome(undefined);
    // Called in the click itself: a passkey assertion needs the user activation.
    void controller
      .startPairing(auth, { sameNetwork, defaultName: deviceName(navigator.userAgent) })
      .then((result) => {
        setPassword('');
        setWorking(false);
        setOutcome(result);
      });
  };
  const reason = blocked(m, session);
  return (
    <div className={CARD} data-testid="invite">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon name="plus" />
        {p.title}
      </h3>
      {stage ? (
        <Stage
          controller={controller}
          session={session}
          stage={stage}
          flow="invite"
          leaving={leaving}
          onAgain={() => {
            controller.cancelPairing();
            setOpen(true);
          }}
        />
      ) : reason ? (
        <Notice>{reason}</Notice>
      ) : !open ? (
        <>
          <p className="text-sm">{p.intro}</p>
          <Button
            className="self-start"
            onClick={() => {
              setOpen(true);
            }}
            data-testid="invite-start"
          >
            {p.start}
          </Button>
        </>
      ) : (
        <Wizard
          steps={flowSteps(m, 'invite')}
          step={1}
          onCancel={
            working
              ? undefined
              : () => {
                  setOpen(false);
                  setPassword('');
                  setOutcome(undefined);
                }
          }
        >
          <p className="text-sm">{p.auth}</p>
          {passkeys && controller.hasPasskey ? (
            <Button
              variant="quiet"
              className="self-start"
              disabled={working}
              onClick={() => {
                start({ kind: 'passkey' });
              }}
            >
              {p.passkey}
            </Button>
          ) : null}
          <form
            className="flex flex-col gap-2"
            onSubmit={(e) => {
              e.preventDefault();
              start({ kind: 'password', password });
            }}
          >
            <Field
              label={p.password}
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => {
                setPassword(e.target.value);
                setOutcome(undefined);
              }}
              error={startError(m, outcome)}
              autoFocus
              data-testid="invite-password"
            />
            <NetworkOptions checked={sameNetwork} onChange={setSameNetwork} />
            <Button type="submit" className="self-start" disabled={password === '' || working}>
              {working ? p.preparing : p.begin}
            </Button>
          </form>
        </Wizard>
      )}
    </div>
  );
}

/**
 * B, from the pair start: its local password first, then the pairing (§13.3, D33). `working` while
 * the controller is joining. With `replace`, from the unlock screen: the pairing replaces the locked
 * vault, once the user confirms it at the password step (D150, D204).
 */
export function JoinVault({
  controller,
  working,
  replace = false,
  onCancel,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly replace?: boolean;
  readonly onCancel: () => void;
}) {
  const m = useMessages();
  const j = m.join;
  const stage = usePairing(controller, 'join');
  const [password, setPassword] = useState<string | null>(null);
  const [sameNetwork, setSameNetwork] = useState(false);
  const [understood, setUnderstood] = useState(false);
  const ready = password !== null && password !== '' && (!replace || understood);
  const onChange = useCallback((value: string | null) => {
    setPassword(value);
  }, []);
  // B holds no vault, so no preference of its own: the default delay applies (D203).
  const leaving = format(m.pairing.leaving, {
    seconds: String(DEFAULT_PREFERENCES.hiddenLockSeconds),
  });
  if (stage) {
    return (
      <Stage
        controller={controller}
        stage={stage}
        flow="join"
        leaving={leaving}
        onAgain={() => {
          // A new session takes a new identity and a new local password (§11).
          controller.cancelPairing();
        }}
      />
    );
  }
  const steps = flowSteps(m, 'join');
  if (working) {
    return (
      <Wizard steps={steps} step={1}>
        <p role="status">{m.pairing.preparing}</p>
      </Wizard>
    );
  }
  return (
    <Wizard steps={steps} step={1} onCancel={onCancel}>
      <p className="text-sm">{j.intro}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // Another app window holding the installation guard shows on the start screen (D97).
          if (password && ready)
            void controller.beginJoin(password, {
              sameNetwork,
              name: deviceName(navigator.userAgent),
              replace,
            });
        }}
      >
        <NewPassword
          label={m.create.password}
          confirmLabel={m.create.confirm}
          onChange={onChange}
          autoFocus={!replace}
        />
        <NetworkOptions checked={sameNetwork} onChange={setSameNetwork} />
        {replace ? (
          <label className={`${TARGET} flex items-center gap-2 text-sm`}>
            <input
              type="checkbox"
              checked={understood}
              onChange={(e) => {
                setUnderstood(e.target.checked);
              }}
              data-testid="replace-understood"
            />
            {m.replace.understand}
          </label>
        ) : null}
        <Button type="submit" className="self-start" disabled={!ready}>
          {j.submit}
        </Button>
      </form>
    </Wizard>
  );
}

function readmissionStartError(
  m: Messages,
  outcome: ReadmissionStart | undefined,
): string | undefined {
  const r = m.readmission;
  switch (outcome) {
    case undefined:
    case 'ok':
    case 'locked':
      return undefined;
    case 'no-webrtc':
      return m.pairing.unavailable;
    case 'read-only':
      return r.readOnly;
    case 'retired':
      return r.retired;
    case 'corrupt-record':
      return r.corrupt;
  }
}

/** Why this vault offers no re-admission now (D45, D102, D207), or `undefined`. */
function readmissionBlocked(m: Messages, session: VaultSession): string | undefined {
  if (session.retired) return m.readmission.retired;
  if (!session.writable) return m.readmission.readOnly;
  if (session.corrupt().length > 0) return m.readmission.corrupt;
  return undefined;
}

/**
 * Re-admission, in Settings › Devices (§9, D206, D207): no password; the user chooses on each device
 * whether it shows its text first or pastes the other's.
 */
export function ReadmitDevice({
  controller,
  session,
  open: startOpen = false,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
  /** From "Vault ready": the choice of who shows first is shown at once (D234). */
  readonly open?: boolean;
}) {
  const m = useMessages();
  const r = m.readmission;
  const stage = usePairing(controller, 'readmit');
  const [open, setOpen] = useState(startOpen);
  const [sameNetwork, setSameNetwork] = useState(false);
  const [working, setWorking] = useState(false);
  const [outcome, setOutcome] = useState<ReadmissionStart>();
  // Leaving Settings ends a re-admission in progress, as a pairing.
  useEffect(
    () => () => {
      if (controller.pairingFlow === 'readmit') controller.cancelPairing();
    },
    [controller],
  );
  const start = (role: 'initiator' | 'responder') => {
    setWorking(true);
    setOutcome(undefined);
    void controller
      .startReadmission(role, { sameNetwork, defaultName: deviceName(navigator.userAgent) })
      .then((result) => {
        setWorking(false);
        setOutcome(result);
      });
  };
  const reason = readmissionBlocked(m, session);
  const error = readmissionStartError(m, outcome);
  return (
    <div className={CARD} data-testid="readmit-device">
      <h3 className="flex items-center gap-2 font-semibold">
        <Icon name="monitor-smartphone" />
        {r.title}
      </h3>
      {stage ? (
        <Stage
          controller={controller}
          session={session}
          stage={stage}
          flow="readmit"
          leaving={leavingText(m, session)}
          onAgain={() => {
            controller.cancelPairing();
            setOpen(true);
          }}
        />
      ) : reason ? (
        <Notice>{reason}</Notice>
      ) : !open ? (
        <>
          <p className="text-sm">{r.intro}</p>
          <Button
            variant="secondary"
            className="self-start"
            onClick={() => {
              setOpen(true);
            }}
            data-testid="readmission-start"
          >
            {r.start}
          </Button>
        </>
      ) : (
        <Wizard
          steps={flowSteps(m, 'readmit')}
          step={1}
          onCancel={
            working
              ? undefined
              : () => {
                  setOpen(false);
                  setOutcome(undefined);
                }
          }
        >
          <p className="text-sm">{r.chooseRole}</p>
          <NetworkOptions checked={sameNetwork} onChange={setSameNetwork} />
          {error ? (
            <p role="alert" className="text-sm text-danger">
              {error}
            </p>
          ) : null}
          <div className="flex flex-wrap gap-2">
            <Button
              disabled={working}
              onClick={() => {
                start('initiator');
              }}
              data-testid="readmission-first"
            >
              {r.first}
            </Button>
            <Button
              variant="quiet"
              disabled={working}
              onClick={() => {
                start('responder');
              }}
              data-testid="readmission-paste"
            >
              {r.paste}
            </Button>
          </div>
        </Wizard>
      )}
    </div>
  );
}
