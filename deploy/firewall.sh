#!/usr/bin/env bash
# Workspace Portal: host firewall for the workspace network (nftables).
#
# The workspace network is a Docker *internal* network, so Docker already refuses to route anything
# from it to the outside world. This adds the rest, in a table of its own (inet workspace_portal):
#
#   * To the host, a workspace may only open connections to the gateway's service port (LLM +
#     search). Without this it could reach every host service listening on 0.0.0.0 (SSH, the portal,
#     the LLM server, …) through the bridge address.
#   * Nothing from or to the workspace network is forwarded, a second lock on the same door should
#     the network ever lose its internal flag.
#
# A drop in any nftables base chain is final, so rules other tools add elsewhere (Docker,
# firewalld, Tailscale) cannot reopen what this table drops. Matching on both the bridge name and
# the subnet keeps the rules effective even if one of them were wrong. The table is replaced in
# one atomic transaction, so there is never a moment without rules.
#
# Usage: firewall.sh apply | remove | status        (needs root; idempotent)
# Reads WORKSPACE_SUBNET, WORKSPACE_GATEWAY_IP, WORKSPACE_BRIDGE and SERVICE_PORT from the
# environment; the systemd unit loads them from /etc/workspace-portal/firewall.env.
set -euo pipefail

SUBNET=${WORKSPACE_SUBNET:-172.29.0.0/16}
GW_IP=${WORKSPACE_GATEWAY_IP:-172.29.0.1}
BRIDGE=${WORKSPACE_BRIDGE:-br-wportal}
SERVICE_PORT=${SERVICE_PORT:-4001}
TABLE="inet workspace_portal"

ruleset() {
  cat <<NFT
table $TABLE {
  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "$BRIDGE" jump from_workspace
    iifname != "lo" ip saddr $SUBNET jump from_workspace
  }

  chain from_workspace {
    ct state established,related accept
    ip daddr $GW_IP tcp dport $SERVICE_PORT ct state new accept
    drop
  }

  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    iifname "$BRIDGE" drop
    oifname "$BRIDGE" drop
    ip saddr $SUBNET drop
    ip daddr $SUBNET drop
  }
}
NFT
}

# Earlier versions used iptables chains (WPORTAL-IN / WPORTAL-FWD); remove them if present.
remove_legacy_iptables() {
  command -v iptables >/dev/null 2>&1 || return 0
  local rule
  for rule in "INPUT -i $BRIDGE -j WPORTAL-IN" "DOCKER-USER -s $SUBNET -j WPORTAL-FWD" "DOCKER-USER -d $SUBNET -j WPORTAL-FWD"; do
    # shellcheck disable=SC2086 # the rule is meant to split into arguments
    while iptables -w 5 -C $rule 2>/dev/null; do iptables -w 5 -D $rule; done
  done
  for chain in WPORTAL-IN WPORTAL-FWD; do
    iptables -w 5 -F "$chain" 2>/dev/null || true
    iptables -w 5 -X "$chain" 2>/dev/null || true
  done
  if command -v ip6tables >/dev/null 2>&1; then
    for rule in "INPUT -i $BRIDGE -j DROP" "FORWARD -i $BRIDGE -j DROP"; do
      # shellcheck disable=SC2086
      while ip6tables -w 5 -C $rule 2>/dev/null; do ip6tables -w 5 -D $rule; done
    done
  fi
}

apply() {
  # "table … {}" makes the delete safe on the first run; all three steps are one transaction.
  { echo "table $TABLE {}"; echo "delete table $TABLE"; ruleset; } | nft -f -
  remove_legacy_iptables
  echo "workspace-portal firewall applied (bridge $BRIDGE, subnet $SUBNET, allowed: $GW_IP tcp/$SERVICE_PORT)"
}

remove() {
  nft delete table "$TABLE" 2>/dev/null || true
  remove_legacy_iptables
  echo "workspace-portal firewall removed"
}

status() {
  nft list table "$TABLE" 2>/dev/null || { echo "not applied: table $TABLE is missing" >&2; return 1; }
}

case "${1:-}" in
  apply) apply ;;
  remove) remove ;;
  status) status ;;
  *) echo "usage: $0 apply|remove|status" >&2; exit 2 ;;
esac
