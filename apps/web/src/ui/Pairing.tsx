import { DEFAULT_PREFERENCES, type VaultSession } from '@blindvault/vault';
import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';

import { type ExportAuth, type PairingStart, type VaultController } from '../app/controller';
import { deviceName } from '../app/device-name';
import { type PairingStage, type PayloadCheck } from '../app/pairing';
import { useMessages } from '../i18n/context';
import { type Messages, format } from '../i18n/messages';
import { Button, Field, Notice, TARGET, TextArea } from './components';
import { NewPassword } from './NewPassword';

// The pairing screens (§8.4, D202, D203): A invites from Settings › Devices, B joins from the pair
// start. The payloads are copied and pasted; both devices show the SAS, and the user says on each
// whether it matches. The flow lives in the controller, so a lock ends it whatever is on screen.

function usePairing(controller: VaultController): PairingStage | undefined {
  return useSyncExternalStore(controller.subscribe, () => controller.pairing);
}

/** Six digits in two groups of three (pairing-protocol.md §6.2). */
function grouped(sas: string): string {
  return `${sas.slice(0, 3)} ${sas.slice(3)}`;
}

function payloadError(m: Messages, check: PayloadCheck | undefined): string | undefined {
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
      return p.pastePeerNoVault;
  }
}

function failure(m: Messages, stage: Extract<PairingStage, { kind: 'failed' }>): string {
  const f = m.pairing.failed;
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

function SameNetwork({
  checked,
  onChange,
}: {
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
}) {
  const m = useMessages();
  return (
    <div className="flex flex-col gap-1">
      <label className={`${TARGET} flex items-center gap-2 text-sm`}>
        <input
          type="checkbox"
          checked={checked}
          onChange={(e) => {
            onChange(e.target.checked);
          }}
          data-testid="pairing-same-network"
        />
        {m.pairing.sameNetwork}
      </label>
      <p className="text-sm text-zinc-500">{m.pairing.sameNetworkHint}</p>
    </div>
  );
}

/** A payload to copy to the other device; the channel sees this device's addresses (D117). */
function PayloadText({ text, label }: { readonly text: string; readonly label: string }) {
  const m = useMessages();
  const [copied, setCopied] = useState(false);
  return (
    <div className="flex flex-col gap-2">
      <TextArea label={label} value={text} readOnly data-testid="pairing-text" />
      <Button
        variant="quiet"
        className="self-start"
        onClick={() => {
          // Not a secret: no clearing, unlike a copied field (D54).
          void navigator.clipboard.writeText(text).then(
            () => {
              setCopied(true);
            },
            () => {
              setCopied(false);
            },
          );
        }}
      >
        {copied ? m.pairing.copied : m.pairing.copy}
      </Button>
      <p className="text-sm text-zinc-500">{m.pairing.channel}</p>
    </div>
  );
}

/** A text pasted from the other device. */
function PasteText({
  label,
  submit,
  onPaste,
}: {
  readonly label: string;
  readonly submit: string;
  readonly onPaste: (text: string) => Promise<PayloadCheck>;
}) {
  const m = useMessages();
  const [text, setText] = useState('');
  const [check, setCheck] = useState<PayloadCheck>();
  const [working, setWorking] = useState(false);
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        setWorking(true);
        void onPaste(text).then((outcome) => {
          setWorking(false);
          setCheck(outcome);
        });
      }}
    >
      <TextArea
        label={label}
        value={text}
        onChange={(e) => {
          setText(e.target.value);
          setCheck(undefined);
        }}
        error={payloadError(m, check)}
        data-testid="pairing-paste"
      />
      <Button type="submit" className="self-start" disabled={text.trim() === '' || working}>
        {submit}
      </Button>
    </form>
  );
}

/** Every stage after the start, on either device. */
function Stage({
  controller,
  stage,
  inviting,
  leaving,
  onAgain,
}: {
  readonly controller: VaultController;
  readonly stage: PairingStage;
  readonly inviting: boolean;
  /** What hiding the app does to the pairing (D93, D105). */
  readonly leaving: string;
  readonly onAgain: () => void;
}) {
  const m = useMessages();
  const p = m.pairing;
  const cancel = (
    <Button
      variant="quiet"
      className="self-start"
      onClick={() => {
        controller.cancelPairing();
      }}
      data-testid="pairing-cancel"
    >
      {p.cancel}
    </Button>
  );
  switch (stage.kind) {
    case 'preparing':
      return (
        <>
          <p role="status">{p.preparing}</p>
          {cancel}
        </>
      );
    case 'offer':
      return (
        <>
          <p className="text-sm">{p.offerIntro}</p>
          <PayloadText text={stage.text} label={p.offerLabel} />
          <Notice>{leaving}</Notice>
          <PasteText
            label={p.answerPaste}
            submit={p.connect}
            onPaste={(text) => Promise.resolve(controller.pairingAnswer(text))}
          />
          {cancel}
        </>
      );
    case 'scan':
      return (
        <>
          <p className="text-sm">{m.join.scanIntro}</p>
          <Notice>{leaving}</Notice>
          <PasteText
            label={m.join.offerPaste}
            submit={m.join.next}
            onPaste={(text) => controller.joinOffer(text)}
          />
          {cancel}
        </>
      );
    case 'answer':
      return (
        <>
          <p className="text-sm">{m.join.answerIntro}</p>
          <PayloadText text={stage.text} label={m.join.answerLabel} />
          <Notice>{leaving}</Notice>
          <p role="status">{m.join.waitingConnection}</p>
          {cancel}
        </>
      );
    case 'connecting':
      return (
        <>
          <p role="status">{p.connecting}</p>
          {cancel}
        </>
      );
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
          {cancel}
        </>
      );
    case 'transfer':
      return <p role="status">{inviting ? p.sending : m.join.receiving}</p>;
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
    case 'failed':
      return (
        <>
          <p
            role="alert"
            className="text-sm text-red-700 dark:text-red-400"
            data-testid="pairing-failed"
            data-reason={stage.reason}
          >
            {failure(m, stage)}
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

/** Why this vault offers no pairing now (D45, D102, D202), or `undefined`. */
function blocked(m: Messages, session: VaultSession): string | undefined {
  if (session.retired) return m.pairing.retired;
  if (!session.writable) return m.pairing.readOnly;
  if (session.corrupt().length > 0) return m.pairing.corrupt;
  return undefined;
}

/** A, in Settings › Devices: the password again, then the pairing (D202). */
export function InviteDevice({
  controller,
  session,
}: {
  readonly controller: VaultController;
  readonly session: VaultSession;
}) {
  const m = useMessages();
  const p = m.pairing;
  const stage = usePairing(controller);
  const [open, setOpen] = useState(false);
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
  const hidden = session.preferences.hiddenLockSeconds;
  const leaving =
    hidden === 0 ? p.leavingImmediate : format(p.leaving, { seconds: String(hidden) });
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
    <div className="flex flex-col gap-3" data-testid="invite">
      <h3 className="font-semibold">{p.title}</h3>
      {stage ? (
        <Stage
          controller={controller}
          stage={stage}
          inviting
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
            variant="quiet"
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
        <>
          <p className="text-sm">{p.auth}</p>
          <SameNetwork checked={sameNetwork} onChange={setSameNetwork} />
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
              data-testid="invite-password"
            />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" disabled={password === '' || working}>
                {working ? p.preparing : p.begin}
              </Button>
              <Button
                variant="quiet"
                disabled={working}
                onClick={() => {
                  setOpen(false);
                  setPassword('');
                  setOutcome(undefined);
                }}
              >
                {p.cancel}
              </Button>
            </div>
          </form>
        </>
      )}
    </div>
  );
}

/**
 * B, from the pair start: its local password first, then the pairing (§13.3, D33). `working` while
 * the controller is joining.
 */
export function JoinVault({
  controller,
  working,
  onCancel,
}: {
  readonly controller: VaultController;
  readonly working: boolean;
  readonly onCancel: () => void;
}) {
  const m = useMessages();
  const j = m.join;
  const stage = usePairing(controller);
  const [password, setPassword] = useState<string | null>(null);
  const [sameNetwork, setSameNetwork] = useState(false);
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
        inviting={false}
        leaving={leaving}
        onAgain={() => {
          // A new session takes a new identity and a new local password (§11).
          controller.cancelPairing();
        }}
      />
    );
  }
  if (working) return <p role="status">{m.pairing.preparing}</p>;
  return (
    <>
      <p className="text-sm">{j.intro}</p>
      <form
        className="flex flex-col gap-4"
        onSubmit={(e) => {
          e.preventDefault();
          // Another app window holding the installation guard shows on the start screen (D97).
          if (password)
            void controller.beginJoin(password, {
              sameNetwork,
              name: deviceName(navigator.userAgent),
            });
        }}
      >
        <NewPassword
          label={m.create.password}
          confirmLabel={m.create.confirm}
          onChange={onChange}
        />
        <SameNetwork checked={sameNetwork} onChange={setSameNetwork} />
        <div className="flex flex-wrap gap-2">
          <Button type="submit" disabled={!password}>
            {j.submit}
          </Button>
          <Button variant="quiet" onClick={onCancel}>
            {m.app.back}
          </Button>
        </div>
      </form>
    </>
  );
}
