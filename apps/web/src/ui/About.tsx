import { useEffect, useState } from 'react';

import { manifestHash } from '../app/build-info';
import { useMessages } from '../i18n/context';

export const RELEASES_URL = 'https://github.com/allisson/blindvault/releases';

/** The running build's version and manifest hash, informational only (§11, D192). */
export function AboutBuild() {
  const m = useMessages();
  // `null` while it is read.
  const [hash, setHash] = useState<string | undefined | null>(null);
  useEffect(() => {
    let live = true;
    void manifestHash().then((h) => {
      if (live) setHash(h);
    });
    return () => {
      live = false;
    };
  }, []);
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
      </dl>
      <p>{m.about.informational}</p>
      <p>
        {m.about.verify} <code>shasum -a 256 -c asset-manifest.txt</code>
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
