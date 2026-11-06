# Deployment

The official build is served by Cloudflare Pages at `https://blindvault.allisson.dev` (D228). A
tag `v<version>` runs `.github/workflows/release.yml`, which uploads the release's attested archive
(D230). Nothing else deploys: no Git integration is connected, and Cloudflare never builds the app.
Self-hosting is described in `self-hosting.md`.

## Cloudflare

| Resource | Setting |
| --- | --- |
| Pages project | `blindvault`, created by `wrangler pages project create blindvault --production-branch main`, with no Git integration, so its creation deployed nothing. wrangler hands the creation of a new project to Workers when it detects an AI agent; the project was created with `--force`, the documented opt-out, and wrangler never delegates for a project that exists (D230). |
| Production branch | `main`. The release deploys with `--branch=main`; any other branch would be a preview. |
| Custom domain | `blindvault.allisson.dev`, the only origin that serves the app (D90). Adding it replaced the zone's CNAME to `allisson.github.io` with a proxied CNAME to `blindvault.pages.dev`. |
| Preview access | Restricted: a Cloudflare Access application on `*.blindvault.pages.dev` admits only the account owner. It does not cover `blindvault.pages.dev`. |
| `pages.dev` redirect | The account Bulk Redirect list `blindvault_pages_dev`, enabled by the rule `blindvault pages.dev redirect`: `blindvault.pages.dev/` to `https://blindvault.allisson.dev/`, 301, with subpath matching and the path suffix and query string kept. Include subdomains is off, so previews and deployment URLs stay behind Access instead of reaching production (D230). |
| 404 caching | On a 404, Pages serves `Cache-Control: no-store` instead of the `no-cache` of `_headers`; the other headers are the rule's. The 404 page is not in the asset manifest. |
| API token | `blindvault release (GitHub Actions)`: the account permission Cloudflare Pages Edit, on this account only, no IP filter, no expiry. Cloudflare offers no narrower scope (D228). |

### Zone `allisson.dev`

Settings that rewrite responses must stay off: the service worker and the post-deployment check
compare every served file with the asset manifest, and a rewritten file fails both (D228).

| Setting | State |
| --- | --- |
| Rocket Loader | off |
| Email Address Obfuscation | off |
| Automatic HTTPS Rewrites | off |
| Auto Minify (HTML, CSS, JS) | off |
| Web Analytics (automatic setup) | no site |
| Speed Brain, Cloudflare Fonts | off |
| Server-Side Excludes | on: the dashboard does not offer it and the session cannot change it. It acts only on HTML marked with `<!--sse-->`, which the build never emits (D230). |

There are no Configuration Rules, Page Rules, Transform Rules or Redirect Rules on the zone. Before
adding one that covers `blindvault.allisson.dev`, check that it does not rewrite responses.

## GitHub

The environment `cloudflare-pages` allows only tags `v*` and holds:

| Name | Kind | Value |
| --- | --- | --- |
| `CLOUDFLARE_API_TOKEN` | secret | the token above, pasted by the owner |
| `CLOUDFLARE_ACCOUNT_ID` | secret | the account ID |
| `ORIGIN` | variable | the origin the post-deployment check reads: `https://blindvault.allisson.dev` (it was `https://blindvault.pages.dev` for v0.5.0, before the move below) |

The workflow accepts no other value of `ORIGIN`.

## Moving the official origin

Done on 2026-11-06, after v0.5.0 deployed to Cloudflare Pages and its check passed against
`blindvault.pages.dev`, in this order (D230):

1. Add `blindvault.allisson.dev` as a custom domain of the project, which replaced its DNS record
   (a CNAME to `allisson.github.io`, not proxied).
2. Set `ORIGIN` to `https://blindvault.allisson.dev`.
3. Add an account Bulk Redirect from `blindvault.pages.dev` to `https://blindvault.allisson.dev`
   (301, preserving the path and the query string). Not earlier: the check of the first release
   would have followed it to GitHub Pages.
4. Remove the GitHub Pages deployment and the `github-pages` environment.

## Rotating the token

Create a token with the same permission, store it with
`gh secret set CLOUDFLARE_API_TOKEN --env cloudflare-pages --repo allisson/blindvault`, then delete
the old one in the dashboard. The value never goes through a chat or a file.
