# BlindVault — Reproducible build and asset manifest

This document specifies the asset manifest and how to rebuild BlindVault and compare it with a
deployment (overview §11, D5, D63, D189).

## Pinned inputs

- **Node:** the exact version in `.nvmrc`. `vite build` refuses any other version, since it is the
  build that publishes a hash. `engines` in `package.json` accepts any 26.x for development and
  tests.
- **pnpm:** the version in `packageManager`, through corepack (`corepack enable pnpm`).
- **Dependencies:** `pnpm-lock.yaml`, installed with `pnpm install --frozen-lockfile`.
- **Time:** the build embeds no date. CI sets `SOURCE_DATE_EPOCH` to the commit time
  (`git log -1 --format=%ct`) for tools that read it.

## Asset manifest

The build writes `asset-manifest.txt` at the root of its output (`apps/web/dist`).

- One line per file of the build: the SHA-256 of its bytes in lowercase hex, two spaces, and its
  path relative to the output root with `/` separators, ending in `\n`:

  ```
  3f2a…9c01  assets/index-CXVRsHyR.js
  ```

- Lines are in byte order of the UTF-8 paths.
- It lists every file except itself and `sw.js`, which the browser updates on its own outside the
  asset bundle (D63), and `_headers`, which Cloudflare Pages reads and does not serve (D229).
- A path that holds a newline or a backslash fails the build, since `shasum` would escape it.

The **manifest hash** is the SHA-256 of the manifest's bytes. The build prints it:

```
asset manifest sha256 <hex>
```

The version gets no line of its own: `version.txt`, a listed file holding the version of
`apps/web/package.json` on one line, gives it to the update prompt (D191).

## Rebuild and compare

```sh
git checkout <commit>
corepack enable pnpm
pnpm install --frozen-lockfile
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) pnpm --filter @blindvault/web build
shasum -a 256 apps/web/dist/asset-manifest.txt
```

To check a deployment against the manifest, download every file it lists, keeping the paths, and
run `shasum -a 256 -c asset-manifest.txt` in that folder. The hash the app shows about itself is
informational only (overview §11): this check, done outside the app, is the one that counts.

## CI

The `reproducible` job in `.github/workflows/ci.yml` builds the same commit twice, from checkouts at
two different paths, the second under another time zone, locale, umask and `SOURCE_DATE_EPOCH`. It
fails unless both `asset-manifest.txt` files are identical, and writes the manifest hash to the job
summary. The reference build is CI's (Ubuntu). A build on macOS 26.6.2 (arm64, Node 26.13.0,
pnpm 10.33.0) matched it on `4448675` (D258): both manifest hashes were
`ae883efe15b86bbc15c8fc72dc8d4274add345656bccae2803a85546f43484b7`. Other systems are not yet known
to match.

## Releases

A tag `v<version>` runs `.github/workflows/release.yml` (D194). It builds the tag once, with
`SOURCE_DATE_EPOCH` set to the commit time, and that build is both the GitHub Release and, from the
release's attested archive, the Cloudflare Pages deployment at `https://blindvault.allisson.dev`
(D230, `deployment.md`).

- The tag must be `v` followed by the version in `version.txt`, from `apps/web/package.json`.
- The release notes are `docs/releases/<tag>.md`. When `apps/web/public/sw.js` differs from the
  previous tag's, they need a `## Service worker` section saying why (D191).
- The release attaches `asset-manifest.txt`, `sw.js` and `blindvault-<tag>.tar.gz`, the build
  archived with sorted names, the commit time and no owner, each with a build provenance
  attestation. Its body ends with the version, both hashes and whether `sw.js` changed.
- After the deployment, the workflow requires the served `asset-manifest.txt` and `sw.js` to equal
  the release's, and checks every listed file with `sha256sum -c`, at the origin in the `ORIGIN`
  variable of the `cloudflare-pages` environment, following redirects.

To check a release's files:

```sh
gh release download <tag> -R allisson/blindvault -p asset-manifest.txt -p sw.js
gh attestation verify asset-manifest.txt -R allisson/blindvault
gh attestation verify sw.js -R allisson/blindvault
shasum -a 256 asset-manifest.txt sw.js
```

Then compare the manifest hash with the one the About screen shows and with your own rebuild.

To publish a release: set the version in `apps/web/package.json` and the root `package.json`,
write `docs/releases/v<version>.md`, merge, then tag the merge commit and push the tag.

## Extension

The extension's packages wrap a build of `apps/web` (`extension.md` §2, D285). Each package has an
`asset-manifest.txt` in the format above, listing every file of the package, `manifest.json`
included; its hash is the one the extension's About shows.

```sh
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) pnpm --filter @blindvault/extension build
shasum -a 256 apps/extension/dist/chrome/asset-manifest.txt apps/extension/dist/firefox/asset-manifest.txt
```

The build writes `apps/extension/dist/<browser>/`, to load unpacked, and
`apps/extension/dist/blindvault-<browser>-<version>.zip`, the archive a store gets. The CI
`reproducible` job builds both archives twice, as the web build, and compares them byte for byte.

The release of a tag attaches, with the web files and the same attestation:

- `blindvault-chrome-<version>.zip` and `blindvault-firefox-<version>.zip`;
- `asset-manifest-chrome.txt` and `asset-manifest-firefox.txt`, each package's manifest. Its
  `shasum -a 256` is the package's manifest hash.

To check a release's packages:

```sh
gh release download <tag> -R allisson/blindvault -p 'blindvault-*.zip' -p 'asset-manifest-*.txt'
gh attestation verify blindvault-firefox-<version>.zip -R allisson/blindvault
gh attestation verify asset-manifest-firefox.txt -R allisson/blindvault
mkdir firefox && unzip -q blindvault-firefox-<version>.zip -d firefox
cmp asset-manifest-firefox.txt firefox/asset-manifest.txt
(cd firefox && shasum -a 256 -c asset-manifest.txt)
```

The same with `chrome` for Chrome's.

To check the package a store installed (`extension.md` §8.2), run the check in its folder, without
the store's own folder, and compare the manifest's hash with the release's:

- **Firefox:** the package is `extensions/blindvault@allisson.github.io.xpi` in the profile's folder
  (`about:support`, "Profile Folder"). Unzip it, remove `META-INF/` (AMO's signature), and run
  `shasum -a 256 -c asset-manifest.txt`.
- **Chrome:** the package is unpacked in `Extensions/<extension ID>/<manifest version>_0/` in the
  profile's folder (`chrome://version`, "Profile Path"). Copy it, remove `_metadata/` (the Web
  Store's signature), and run `shasum -a 256 -c asset-manifest.txt`. Whether the store rewrites
  `manifest.json` is still to confirm at the first upload (`extension.md` §8.2).

## Android

The APK wraps the Android build of `apps/web` (`android.md` §2, D290). Its `asset-manifest.txt`, in
the format above, lists every file of `assets/web/`, `headers.json` included; its hash is the one
the app's About shows. Besides Node and pnpm, the build needs the JDK (Temurin 21.0.13+9) and the
Android SDK (platform 36, build tools 36.0.0) of `docs/architecture.md`, with `ANDROID_HOME` set.

```sh
SOURCE_DATE_EPOCH=$(git log -1 --format=%ct) pnpm --filter @blindvault/android build
shasum -a 256 apps/android/app/src/main/assets/web/asset-manifest.txt
shasum -a 256 apps/android/app/build/outputs/apk/release/app-release-unsigned.apk
```

The build writes the unsigned APK, with no R8, no baseline profile, no VCS information and no
dependency block, so its bytes depend only on the pinned inputs; Gradle checks every artifact it
resolves against `apps/android/gradle/verification-metadata.xml`. The CI `android` job runs the
Kotlin unit tests and builds the APK twice, as the web build, and compares the two byte for byte.
Two builds on macOS 26.6.2 (arm64), the second under another time zone, locale and umask, gave the same
APK. Signing, the release's files and the check of a signed APK against a rebuild come with the
first Android release (`android.md` §10).

## Validation on the release candidate

`v1.0.0-rc.1` (`d016b23`, release workflow run 43597999522), for the Security Gate on 2026-11-14:

- Both attestations verified with `gh attestation verify`.
- The manifest hash was `5eaab9b2b5402426a77b34bcbbed35b4b9350ce9d649fe9d9d7369d5b772ea03` in the
  release, in a rebuild of the tag on macOS 26.6.2 (arm64), and at `https://blindvault.allisson.dev`.
- `sw.js` was `18cbc9bfe950c747e35e269c56770ef069db4b44bb6f7d1efaabadcf0da6fd60` in the release
  and in the rebuild.
