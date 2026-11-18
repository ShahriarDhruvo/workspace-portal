#!/usr/bin/env bash
# The portal over HTTPS, for the devices of this server's tailnet and nobody else:
#   sudo bash deploy/tailscale-https.sh        Tailscale ends TLS on each of the portal's ports
#   sudo bash deploy/tailscale-https.sh off    back to HTTP on the LAN
# The tailnet needs MagicDNS and HTTPS certificates (admin console, DNS). Run it again after changing a port.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
[[ $# -eq 0 || $* == off ]] || die "usage: $0 [off]"

bind=0.0.0.0 secure=false
if [[ $# -eq 0 ]]; then
  tailscale_name >/dev/null || die "Tailscale has no HTTPS name for this server: enable MagicDNS and HTTPS certificates for the tailnet"
  bind=127.0.0.1 secure=true
fi
log "Tailscale Serve: ${1:-on} for TCP $(env_get WEB_PORT) $(port_ranges)(half a minute)"
for range in "$(env_get WEB_PORT)" $(port_ranges); do
  for port in $(seq "${range%-*}" "${range#*-}"); do
    if [[ $# -eq 0 ]]; then
      tailscale serve --bg "--tls-terminated-tcp=$port" "tcp://127.0.0.1:$port" >/dev/null || die "tailscale serve refused port $port"
    else
      tailscale serve "--tls-terminated-tcp=$port" off >/dev/null 2>&1 || true
    fi
  done
done
# Behind Tailscale the ports listen on this host only, and the session cookie is for HTTPS only.
env_set WEB_BIND "$bind"
env_set AGENT_BIND "$bind"
env_set SESSION_COOKIE_SECURE "$secure"
docker compose up -d --wait
echo "Portal: $(portal_url)"
