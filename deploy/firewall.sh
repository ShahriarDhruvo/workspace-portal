#!/usr/bin/env bash
# Workspace Portal: host firewall rules for the workspace network.
#
# The workspace network is a Docker *internal* network, so Docker itself already refuses to route
# anything from it to the outside world. These rules add two things on top:
#
#   * Forwarded traffic from the workspace subnet is dropped outright (a second lock on the same
#     door, should the network ever be recreated without the internal flag).
#   * Traffic from the workspace bridge to the host itself is dropped, except new connections to
#     the gateway's service port (LLM + search). Without this, workspaces could reach every host
#     service listening on 0.0.0.0 (SSH, the portal itself, …) through the bridge address.
#
# Usage: firewall.sh apply | remove | status        (needs root; idempotent)
# Reads WORKSPACE_SUBNET, WORKSPACE_GATEWAY_IP, WORKSPACE_BRIDGE and SERVICE_PORT from the
# environment (the systemd unit loads /etc/workspace-portal/firewall.env).
set -euo pipefail

SUBNET=${WORKSPACE_SUBNET:-172.29.0.0/16}
GW_IP=${WORKSPACE_GATEWAY_IP:-172.29.0.1}
BRIDGE=${WORKSPACE_BRIDGE:-br-wportal}
SERVICE_PORT=${SERVICE_PORT:-4001}

ipt() { iptables -w 5 "$@"; }
ip6t() { ip6tables -w 5 "$@"; }

ensure_chain() { ipt -N "$1" 2>/dev/null || ipt -F "$1"; }

remove_jump() { while ipt -C "$1" "${@:2}" 2>/dev/null; do ipt -D "$1" "${@:2}"; done; }
remove_jump6() { while ip6t -C "$1" "${@:2}" 2>/dev/null; do ip6t -D "$1" "${@:2}"; done; }

apply() {
  # DOCKER-USER exists once dockerd has started.
  if ! ipt -nL DOCKER-USER >/dev/null 2>&1; then
    echo "DOCKER-USER chain missing: is Docker running?" >&2
    exit 1
  fi

  # Nothing from a workspace is ever forwarded, in either direction of a new connection.
  ensure_chain WPORTAL-FWD
  ipt -A WPORTAL-FWD -j DROP
  remove_jump DOCKER-USER -s "$SUBNET" -j WPORTAL-FWD
  remove_jump DOCKER-USER -d "$SUBNET" -j WPORTAL-FWD
  ipt -I DOCKER-USER 1 -s "$SUBNET" -j WPORTAL-FWD
  ipt -I DOCKER-USER 1 -d "$SUBNET" -j WPORTAL-FWD

  # To the host: only the gateway's service port.
  ensure_chain WPORTAL-IN
  ipt -A WPORTAL-IN -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
  ipt -A WPORTAL-IN -p tcp -d "$GW_IP" --dport "$SERVICE_PORT" -m conntrack --ctstate NEW -j ACCEPT
  ipt -A WPORTAL-IN -j DROP
  remove_jump INPUT -i "$BRIDGE" -j WPORTAL-IN
  ipt -I INPUT 1 -i "$BRIDGE" -j WPORTAL-IN

  # The network has no IPv6, but drop anything arriving on the bridge over IPv6 regardless.
  if command -v ip6tables >/dev/null 2>&1; then
    remove_jump6 INPUT -i "$BRIDGE" -j DROP
    remove_jump6 FORWARD -i "$BRIDGE" -j DROP
    ip6t -I INPUT 1 -i "$BRIDGE" -j DROP
    ip6t -I FORWARD 1 -i "$BRIDGE" -j DROP
  fi

  echo "workspace-portal firewall applied (subnet $SUBNET, bridge $BRIDGE, gateway $GW_IP:$SERVICE_PORT)"
}

remove() {
  remove_jump DOCKER-USER -s "$SUBNET" -j WPORTAL-FWD
  remove_jump DOCKER-USER -d "$SUBNET" -j WPORTAL-FWD
  remove_jump INPUT -i "$BRIDGE" -j WPORTAL-IN
  for chain in WPORTAL-FWD WPORTAL-IN; do
    ipt -F "$chain" 2>/dev/null || true
    ipt -X "$chain" 2>/dev/null || true
  done
  if command -v ip6tables >/dev/null 2>&1; then
    remove_jump6 INPUT -i "$BRIDGE" -j DROP
    remove_jump6 FORWARD -i "$BRIDGE" -j DROP
  fi
  echo "workspace-portal firewall removed"
}

status() {
  ipt -S DOCKER-USER | grep WPORTAL || echo "no DOCKER-USER jump"
  ipt -S INPUT | grep WPORTAL || echo "no INPUT jump"
  ipt -S WPORTAL-FWD 2>/dev/null || true
  ipt -S WPORTAL-IN 2>/dev/null || true
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  status) status ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
