#!/usr/bin/env bash
# Shares the running demo over the internet with Cloudflare quick tunnels (no account or domain needed).
#   ./tunnel.sh        start: opens 5 tunnels, rebuilds the web apps to use them, prints the links
#   ./tunnel.sh stop   close the tunnels and switch back to the normal LAN addresses
# Requires: cloudflared on PATH, docker compose stack already set up (docker/.env). Links change every start.
set -euo pipefail
cd "$(dirname "$0")"
D=.tunnel; mkdir -p $D
ports=(api:3000 backoffice:8080 pos:8081 storefront:8082 careers:8083)

stop() {
  for f in $D/*.pid; do [ -f "$f" ] && kill "$(cat "$f")" 2>/dev/null || true; done
  rm -f $D/*.pid $D/*.log $D/urls.txt
}

if [ "${1:-}" = stop ]; then
  stop
  (cd docker && docker compose up -d --build backend backoffice pos storefront careers)
  echo "Tunnels closed; apps rebuilt for LAN use."; exit 0
fi

command -v cloudflared >/dev/null || { echo "cloudflared is not installed" >&2; exit 1; }
[ -f docker/.env ] || { echo "docker/.env is missing (see DEMO.md)" >&2; exit 1; }
stop
declare -A url
for e in "${ports[@]}"; do
  n=${e%%:*}; p=${e##*:}
  nohup cloudflared tunnel --no-autoupdate --url "http://localhost:$p" >"$D/$n.log" 2>&1 &
  echo $! >"$D/$n.pid"
done
echo -n "Opening tunnels"
for e in "${ports[@]}"; do
  n=${e%%:*}
  for _ in $(seq 1 60); do
    u=$(grep -o 'https://[a-z0-9-]*\.trycloudflare\.com' "$D/$n.log" | head -1 || true)
    [ -n "$u" ] && break; echo -n "."; sleep 1
  done
  [ -n "${u:-}" ] || { echo; echo "No URL for $n; see $D/$n.log" >&2; exit 1; }
  url[$n]=$u; u=
done
echo " done"

# The web apps bake in the API address, and the API must allow the apps' origins.
export API_URL="${url[api]}" TRUST_PROXY=1
export CORS_EXTRA=",${url[backoffice]},${url[pos]},${url[storefront]},${url[careers]}"
(cd docker && docker compose up -d --build)

{
  echo "Back-office : ${url[backoffice]}/login"
  echo "Tablet POS  : ${url[pos]}"
  echo "Storefront  : ${url[storefront]}/demo"
  echo "Careers     : ${url[careers]}/demo"
  echo "API docs    : ${url[api]}/docs"
  echo "Login       : tenant demo, owner@demo.test, password ChangeMe-12345 (other roles in DEMO.md)"
} | tee $D/urls.txt
echo "Anyone with these links can sign in. Run ./tunnel.sh stop when done."
