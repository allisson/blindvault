#!/usr/bin/env bash
# Serves apps/web/dist with a configuration of deploy/ in Docker, for playwright.self-hosting
# .config.ts (D195): `serve.sh nginx` on http://localhost:8080, `serve.sh caddy` on
# http://localhost:8081, `serve.sh stop` removes both. Images are pinned by digest.
set -euo pipefail

NGINX=nginx:1.30.5-alpine@sha256:0985e772fb9f729e6fa0980da05fca5d9c468e870eed43071545afa9d2e27d94
CADDY=caddy:2.11.4-alpine@sha256:6aeddd44c3078b0f9a35206472a11420648a79c184603ef95957d0a20044cb2b

here=$(cd "$(dirname "$0")" && pwd)
repo=$(cd "$here/../../../.." && pwd)
dist="$repo/apps/web/dist"

case "${1:-}" in
  nginx)
    docker pull -q "$NGINX" >/dev/null
    docker run -d --rm --name blindvault-nginx -p 8080:8080 \
      -v "$dist:/srv/blindvault:ro" \
      -v "$repo/deploy/nginx/blindvault.conf:/etc/nginx/blindvault.conf:ro" \
      -v "$here/nginx-server.conf:/etc/nginx/conf.d/default.conf:ro" \
      "$NGINX" >/dev/null
    url=http://localhost:8080
    ;;
  caddy)
    docker pull -q "$CADDY" >/dev/null
    docker run -d --rm --name blindvault-caddy -p 8081:8081 \
      -e BLINDVAULT_SITE=:8081 \
      -v "$dist:/srv/blindvault:ro" \
      -v "$repo/deploy/Caddyfile:/etc/caddy/Caddyfile:ro" \
      "$CADDY" >/dev/null
    url=http://localhost:8081
    ;;
  stop)
    docker rm -f blindvault-nginx blindvault-caddy >/dev/null 2>&1 || true
    exit 0
    ;;
  *)
    echo "usage: $0 nginx|caddy|stop" >&2
    exit 2
    ;;
esac

for _ in $(seq 1 30); do
  if curl -fs -o /dev/null "$url/"; then
    echo "$url"
    exit 0
  fi
  sleep 1
done
echo "$1 did not answer at $url" >&2
exit 1
