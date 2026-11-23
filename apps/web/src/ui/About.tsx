import { useEffect, useState } from 'react';

import { manifestHash } from '../app/build-info';
import { useMessages } from '../i18n/context';
import { platform } from '../platform';

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
 * The running build's version and manifest hash, and on Android the signing certificate's SHA-256,
 * informational only (§11, D192, android.md §10).
 */
export function AboutBuild() {
  const m = useMessages();
  const hash = useRead(manifestHash);
  const certificate = useRead(platform.signingCertificate);
  return (
    <div data-testid="about" className="flex flex-col gap-3 text-sm">
      <dl className="flex flex-col gap-2">
        <dt className="font-medium">{m.about.version}</dt>
        <dd data-testid="about-version">{__APP_VERSION__}</dd>
        <dt className="font-medium">{m.about.hash}</dt>
        <dd>
          {hash === null ? (
            m.start.starting
          ) : hash === undefined ? (
            m.about.unavailable
          ) : (
            <code data-testid="about-hash" className="break-all select-all">
              {hash}
            </code>
          )}
        </dd>
        {platform.signingCertificate && (
          <>
            <dt className="font-medium">{m.about.certificate}</dt>
            <dd>
              {certificate === null ? (
                m.start.starting
              ) : certificate === undefined ? (
                m.about.unavailable
              ) : (
                <code data-testid="about-certificate" className="break-all select-all">
                  {certificate}
                </code>
              )}
            </dd>
          </>
        )}
      </dl>
      <p>{m.about.informational}</p>
      <p>
        {m.about.verify}{' '}
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
