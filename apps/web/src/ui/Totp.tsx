import { type TotpValue, totpCode, totpSecondsRemaining } from '@blindvault/crypto';
import { useEffect, useState } from 'react';

import { useMessages } from '../i18n/context';
import { format } from '../i18n/messages';
import { CopyButton, SecretView, useCopy } from './Secret';

/** `123456` as `123 456`, `12345678` as `1234 5678`: easier to read off and type. */
function grouped(code: string): string {
  const half = Math.ceil(code.length / 2);
  return `${code.slice(0, half)} ${code.slice(half)}`;
}

/** The ring's color: amber from 10 s left, red from 5 s (D248). */
export function ringTone(seconds: number): string {
  return seconds <= 5 ? 'text-danger' : seconds <= 10 ? 'text-warning' : 'text-accent';
}

const R = 14;
const CIRCUMFERENCE = 2 * Math.PI * R;

/**
 * The time left in the period, as a ring beside the code (D248). It steps once a second with no
 * transition, so it is not motion (D236); decorative, since the seconds are also in text.
 */
function Ring({ seconds, period }: { readonly seconds: number; readonly period: number }) {
  return (
    <svg
      viewBox="0 0 34 34"
      aria-hidden="true"
      data-testid="totp-ring"
      data-seconds={seconds}
      className={`size-8.5 shrink-0 -rotate-90 ${ringTone(seconds)}`}
    >
      <circle cx="17" cy="17" r={R} fill="none" strokeWidth="3" className="stroke-line" />
      <circle
        cx="17"
        cy="17"
        r={R}
        fill="none"
        strokeWidth="3"
        strokeLinecap="round"
        stroke="currentColor"
        strokeDasharray={CIRCUMFERENCE}
        strokeDashoffset={CIRCUMFERENCE * (1 - seconds / period)}
      />
    </svg>
  );
}

/**
 * A TOTP field (D127): the current code shown unmasked, since it expires within its period, and
 * the TOTP secret masked like a `secret` field. Both copy under the clipboard-clear rule (D54).
 */
export function TotpView({
  value,
  name,
  clearSeconds,
}: {
  readonly value: TotpValue;
  readonly name: string;
  readonly clearSeconds: number | undefined;
}) {
  const m = useMessages();
  const [now, setNow] = useState(() => Date.now());
  const [code, setCode] = useState<{ readonly step: number; readonly code: string }>();
  const { copy, checked } = useCopy(clearSeconds);
  useEffect(() => {
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, []);

  const { secret, algorithm, digits, period } = value;
  const step = Math.floor(now / 1000 / period);
  useEffect(() => {
    let live = true;
    totpCode({ secret, algorithm, digits, period }, step * period * 1000).then(
      (next) => {
        if (live) setCode({ step, code: next });
      },
      () => {
        if (live) setCode(undefined);
      },
    );
    return () => {
      live = false;
    };
  }, [secret, algorithm, digits, period, step]);

  // A code from an earlier step is never shown, even for the instant before the new one.
  const current = code?.step === step ? code.code : undefined;
  const remaining = totpSecondsRemaining(period, now);
  const account = [value.issuer, value.accountName].filter((t) => t !== undefined).join(' · ');
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-2">
        <Ring seconds={remaining} period={period} />
        <div className="flex min-w-0 flex-1 flex-col">
          {/* A name on a plain span is not read: the label is text a screen reader reaches. */}
          <span className="sr-only">{m.items.totpCode}</span>
          <span
            data-testid={`totp-${name}`}
            className="font-mono text-2xl tracking-wider tabular-nums"
          >
            {current ? grouped(current) : '\u00a0'}
          </span>
          <span className="text-xs text-muted" data-testid={`totp-expires-${name}`}>
            {format(m.items.totpExpires, { seconds: String(remaining) })}
          </span>
        </div>
        {current && clearSeconds !== undefined ? (
          <CopyButton
            label={m.items.copyCode}
            name={name}
            checked={checked}
            onCopy={() => {
              copy(current);
            }}
          />
        ) : null}
      </div>
      {account !== '' ? <p className="text-sm break-words text-muted">{account}</p> : null}
      <div className="flex flex-col gap-0.5">
        <span className="text-xs font-medium text-muted">{m.items.totpSecret}</span>
        <SecretView value={value.secret} label={name} clearSeconds={clearSeconds} />
      </div>
    </div>
  );
}
