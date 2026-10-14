# BlindVault — Self-hosting

BlindVault is a static web application: any static host can serve it, and no server ever sees a
vault (overview §11, §12). This document says how to serve a release yourself, for anyone who does
not want to trust the official host at `https://blindvault.allisson.dev` (D90, D194, D195).

## Requirements

- **An origin that serves nothing else** (D90), such as `https://vault.example.com`. Content of the
  same origin can read and delete the vault's IndexedDB, take its Web Lock and script an unlocked
  app window it opens. Other subdomains of the same site do not share the origin, but they share
  its storage partition when they frame it, which the app refuses (D193).
- **The root of that origin.** The app loads `/sw.js`, `/manifest.webmanifest` and its assets by
  absolute path, and its service worker controls `/`. A sub-path such as
  `https://example.com/blindvault/` does not work.
- **HTTPS.** IndexedDB, Web Locks, service workers and WebAuthn need a secure context. Only
  `localhost` is one without TLS, for testing.
- **No fallback to `index.html`.** The app has no routes (D167): a missing file is a 404.

## Get the files

Use the files of a release, or rebuild them from its tag.

**From a release.** Download `blindvault-<tag>.tar.gz` and `asset-manifest.txt` from
[the releases](https://github.com/allisson/blindvault/releases), then check them:

```sh
gh attestation verify blindvault-<tag>.tar.gz -R allisson/blindvault
gh attestation verify asset-manifest.txt -R allisson/blindvault
mkdir blindvault && tar -xzf blindvault-<tag>.tar.gz -C blindvault
cmp asset-manifest.txt blindvault/asset-manifest.txt
(cd blindvault && shasum -a 256 -c asset-manifest.txt)
shasum -a 256 asset-manifest.txt
```

The last hash must be the one in the release notes, and the one the About screen shows once
served.

**From source.** Rebuild the tag as in [build.md](build.md) and compare the manifest hash with the
release's. The files are in `apps/web/dist`.

## Serve them

Ready configurations, tested in CI on every change (below):

- [`deploy/Caddyfile`](../deploy/Caddyfile): set `BLINDVAULT_SITE` to the domain, and Caddy gets
  and renews the certificate itself.
- [`deploy/nginx/blindvault.conf`](../deploy/nginx/blindvault.conf): include it in the server
  block of the origin, after its TLS lines:

  ```nginx
  server {
      listen 443 ssl;
      http2 on;
      server_name vault.example.com;
      ssl_certificate     /etc/ssl/vault.example.com/fullchain.pem;
      ssl_certificate_key /etc/ssl/vault.example.com/privkey.pem;
      include /etc/nginx/blindvault.conf;
  }
  ```

Both serve the files from `/srv/blindvault`. On another host, send the same headers:

| Header | Value | Why |
| --- | --- | --- |
| `Content-Security-Policy` | The policy of the app's `<meta>` tag, with `; frame-ancestors 'none'` (see either configuration) | `frame-ancestors` cannot be set by `<meta>` (D83, D193) |
| `Referrer-Policy` | `no-referrer` | Opened sites do not learn the app's origin (D147) |
| `X-Content-Type-Options` | `nosniff` | A file is never run as another type |
| `Cross-Origin-Opener-Policy` | `same-origin` | A page that opens the app keeps no handle on its window, so it cannot navigate it to a fake unlock page (D195) |
| `Strict-Transport-Security` | `max-age=31536000` | HTTPS only, once visited |
| `Cache-Control` | `no-cache` for every file outside `assets/`; long-lived for `assets/` | `index.html`, `sw.js` and `asset-manifest.txt` must be checked at every load, or updates are not seen (D63, D191); files under `assets/` change name with their content |

Scripts must be served as JavaScript (the Argon2id worker is a module) and
`manifest.webmanifest` as `application/manifest+json`.

## Update

Replace the files with those of a new release, checked as above. Open app windows offer the update
with its version and manifest hash, and switch only once the user confirms (D191). When a release
changes `sw.js`, its notes say why: every installation then warns that the service worker changed
and locks the vault until the user has verified the release.

## Moving between origins

A vault belongs to the origin it was created on: IndexedDB, Web Locks and WebAuthn credentials are
bound to it (D90). Moving from the official host to yours, or between two of yours, means a backup
at the old origin and a restore at the new one, then setting up WebAuthn unlock again.

## Testing a configuration

CI serves the build with both configurations in Docker and runs the self-hosting browser tests
against each. To run them locally, with Docker:

```sh
pnpm --filter @blindvault/web build
cd apps/web
BLINDVAULT_URL=$(e2e/self-hosting/serve.sh nginx) pnpm test:self-hosting
BLINDVAULT_URL=$(e2e/self-hosting/serve.sh caddy) pnpm test:self-hosting
e2e/self-hosting/serve.sh stop
```

They check the headers and caching of each file, that another origin can neither frame the app nor
keep a handle on a window it opened, and that the app installs, works offline and shows the hash
of the served manifest.
