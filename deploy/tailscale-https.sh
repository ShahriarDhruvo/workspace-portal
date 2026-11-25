#!/usr/bin/env bash
# The portal over HTTPS, for the devices of this server's tailnet and nobody else:
#   sudo bash deploy/tailscale-https.sh        Tailscale ends TLS: the portal on port 443, each workspace on its own
#   sudo bash deploy/tailscale-https.sh off    back to HTTP on every address
# The tailnet needs MagicDNS and HTTPS certificates (admin console, DNS). The ports are those in .env, of the
# agents WORKSPACE_AGENTS enables: run it with "off" before changing either or uninstalling the portal, and again
# after the change.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
[[ $# -eq 0 || $* == off ]] || die "usage: $0 [off]"
[[ -f $ENV_FILE ]] || die "install the portal first: sudo bash deploy/install.sh"
no_console_update "then run this again"

# Each workspace's port and its preview's, not their whole ranges: Tailscale is asked port by port, and the rest of
# a user's block serves nothing. On: those the gateway listens on. Off: every agent's, so none stays mapped.
if [[ $# -eq 0 ]]; then
  load_enabled_agents
  ports=$(workspace_ports "${ENABLED_AGENTS[@]}")
else
  ports=$(workspace_ports "${AGENTS[@]}")
fi
# Behind Tailscale the ports listen on this host only, and the portal knows that browsers use HTTPS.
listen_on() { # address, HTTPS
  env_set WEB_BIND "$1"
  env_set AGENT_BIND "$1"
  env_set PORTAL_HTTPS "$2"
  docker compose up -d --wait
}
serve() { # Tailscale's port, the portal's
  tailscale serve --bg "--tls-terminated-tcp=$1" "tcp://127.0.0.1:$2" >/dev/null || die "tailscale serve refused port $1: run this again, or with \"off\" to go back"
}

if [[ $# -eq 0 ]]; then
  tailscale_name >/dev/null || die "Tailscale gives this server no HTTPS name: it must run and be signed in, with MagicDNS and HTTPS certificates enabled for the tailnet"
  # First: Tailscale listens on these ports of its own address, which a listener on every address collides with.
  listen_on 127.0.0.1 true
  log "Tailscale Serve: TCP 443, and the $(wc -w <<<"$ports") ports of the workspaces and their previews in $(port_ranges) (half a minute)"
  serve 443 "$(env_get WEB_PORT)"
  for port in $ports; do serve "$port" "$port"; done
else
  # "off" fails for a port that is not mapped, so its failures are ignored: ask first whether Tailscale answers.
  ! command -v tailscale >/dev/null || tailscale serve status >/dev/null || die "Tailscale does not answer, so its ports would stay mapped: start it, then run this again"
  for port in 443 $ports; do tailscale serve "--tls-terminated-tcp=$port" off >/dev/null 2>&1 || true; done
  listen_on 0.0.0.0 false
fi
echo "Portal: $(portal_url)"
