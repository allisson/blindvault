# BlindVault — Reproducible build and asset manifest

This document specifies the asset manifest and how to rebuild BlindVault and compare it with a
deployment (overview §11, D5, D63, D189).

## Pinned inputs

- **Node:** the exact version in `.nvmrc`. `vite build` refuses any other version, since it is the
  build that publishes a hash. `engines` in `package.json` accepts any 24.x for development and
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
  asset bundle (D63).
- A path that holds a newline or a backslash fails the build, since `shasum` would escape it.

The **manifest hash** is the SHA-256 of the manifest's bytes. The build prints it:

```
asset manifest sha256 <hex>
```

The version gets no line of its own: the code that shows it is in a listed file.

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
summary. The reference build is CI's (Ubuntu); a build on another OS is not yet known to match.
