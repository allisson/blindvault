import { useEffect, useState } from 'react';

import { manifestHash } from '../app/build-info';
import { useMessages } from '../i18n/context';
import type { Messages } from '../i18n/messages';
import { platform } from '../platform';
import type { Platform } from '../platform/platform';

export const RELEASES_URL = 'https://github.com/allisson/blindvault/releases';

/** A value read once, `null` while it is read. */
function useRead(read: (() => Promise<string | undefined>) | undefined): string | undefined | null {
  const [value, setValue] = useState<string | undefined | null>(read ? null : undefined);
  useEffect(() => {
    if (!read) return;
    let live = true;
    void read().then((v) => {
      if (live) setValue(v);
    });
    return () => {
      live = false;
    };
  }, [read]);
  return value;
}

/**
 * How to check a release outside the app: the served files on the web, the unzipped APK's
 * `assets/web` in the Android app (android.md §10, D300), the unpacked store package in the
 * extension (extension.md §8.2). The command is the same.
 */
export function aboutVerify(m: Messages, kind: Platform['kind']): string {
  if (kind === 'android') return m.about.verifyApk;
  if (kind === 'extension') return m.about.verifyPackage;
  return m.about.verify;
}

/**
 * The running build's version and manifest hash, and on Android the signing certificate's SHA-256,
 * informational only (§11, D192, android.md §10).
 */
export function AboutBuild() {
  const m = useMessages();
  const hash = useRead(manifestHash);
  const certificate = useRead(platform.signingCertificate);
  return (
    <div data-testid="about" className="@container flex flex-col gap-3 text-sm">
      {/* Two columns when there is room for them (D315). */}
      <dl className="grid grid-cols-1 gap-x-4 gap-y-1 @md:grid-cols-[10rem_1fr] @md:gap-y-2">
        <dt className="text-muted not-first:mt-2 @md:not-first:mt-0">{m.about.version}</dt>
        <dd data-testid="about-version" className="font-mono">
          {__APP_VERSION__}
        </dd>
        <dt className="text-muted not-first:mt-2 @md:not-first:mt-0">{m.about.hash}</dt>
        <dd>
          {hash === null ? (
            m.start.starting
          ) : hash === undefined ? (
            m.about.unavailable
          ) : (
            <code data-testid="about-hash" className="text-xs break-all select-all">
              {hash}
            </code>
          )}
        </dd>
        {platform.signingCertificate && (
          <>
            <dt className="text-muted not-first:mt-2 @md:not-first:mt-0">{m.about.certificate}</dt>
            <dd>
              {certificate === null ? (
                m.start.starting
              ) : certificate === undefined ? (
                m.about.unavailable
              ) : (
                <code data-testid="about-certificate" className="text-xs break-all select-all">
                  {certificate}
                </code>
              )}
            </dd>
          </>
        )}
      </dl>
      <p>{m.about.informational}</p>
      <p>
        {aboutVerify(m, platform.kind)}{' '}
        <code className="whitespace-nowrap">shasum -a 256 -c asset-manifest.txt</code>
      </p>
      <a
        href={RELEASES_URL}
        target="_blank"
        rel="noopener noreferrer"
        className="self-start underline"
      >
        {m.about.releases}
      </a>
    </div>
  );
}
