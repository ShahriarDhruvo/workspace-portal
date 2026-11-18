#!/usr/bin/env bash
# The portal over HTTPS, for the devices of this server's tailnet and nobody else:
#   sudo bash deploy/tailscale-https.sh        Tailscale ends TLS on each of the portal's ports
#   sudo bash deploy/tailscale-https.sh off    back to HTTP on every address
# The tailnet needs MagicDNS and HTTPS certificates (admin console, DNS). The ports are those in .env: run it
# with "off" before changing one or uninstalling the portal, and again after the change.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
[[ $# -eq 0 || $* == off ]] || die "usage: $0 [off]"
[[ -f $ENV_FILE ]] || die "install the portal first: sudo bash deploy/install.sh"
no_console_update "then run this again"

ports=$(for range in "$(env_get WEB_PORT)" $(port_ranges); do seq "${range%-*}" "${range#*-}"; done)
# Behind Tailscale the ports listen on this host only, and the session cookie is for HTTPS only.
listen_on() { # address, cookie Secure
  env_set WEB_BIND "$1"
  env_set AGENT_BIND "$1"
  env_set SESSION_COOKIE_SECURE "$2"
  docker compose up -d --wait
}

if [[ $# -eq 0 ]]; then
  tailscale_name >/dev/null || die "Tailscale gives this server no HTTPS name: it must run and be signed in, with MagicDNS and HTTPS certificates enabled for the tailnet"
  # First: Tailscale listens on these ports of its own address, which a listener on every address collides with.
  listen_on 127.0.0.1 true
  log "Tailscale Serve: TCP $(env_get WEB_PORT) $(port_ranges)(half a minute)"
  for port in $ports; do
    tailscale serve --bg "--tls-terminated-tcp=$port" "tcp://127.0.0.1:$port" >/dev/null || die "tailscale serve refused port $port: run this again, or with \"off\" to go back"
  done
else
  # "off" fails for a port that is not mapped, so its failures are ignored: ask first whether Tailscale answers.
  ! command -v tailscale >/dev/null || tailscale serve status >/dev/null || die "Tailscale does not answer, so its ports would stay mapped: start it, then run this again"
  for port in $ports; do tailscale serve "--tls-terminated-tcp=$port" off >/dev/null 2>&1 || true; done
  listen_on 0.0.0.0 false
fi
echo "Portal: $(portal_url)"
