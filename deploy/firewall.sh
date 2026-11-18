#!/usr/bin/env bash
# The nftables table inet workspace_portal: what the workspaces, the page reader and SearXNG may reach.
#   Private workspaces: the gateway's service port on the host; nothing is forwarded from or to them.
#   Online workspaces: their service port, DNS at their two resolvers, new TCP to public addresses.
#   The reader and SearXNG: DNS at their two resolvers, TCP 80 and 443 to public addresses; on the host they
#   only answer the gateway.
# Only replies are forwarded to any of them. "Public" is outside the sets not_public and never (the container
# networks and NEVER_REACH), which are dropped before DNS is let through, so no resolver is a way into the LAN.
# A drop in a base chain is final: no rule of Docker, firewalld or Tailscale reopens it. Bridge and subnet are
# both matched, in case one of them is wrong.
# The input chain's first rule is the fence marker: TCP to 127.0.0.1:SERVICE_PORT, where nothing listens, fails
# with EHOSTUNREACH while this table is loaded and with ECONNREFUSED without it. The gateway runs Online
# workspaces only while it sees the former (gateway/src/workspaces/fence.ts).
#
#   firewall.sh apply | check | remove | status | print | not-public
# apply, check (a dry run) and print take the settings of /etc/workspace-portal/firewall.env, which
# deploy/install.sh writes, from the environment. Standalone: systemd runs a copy of this file at boot.
set -euo pipefail

TABLE="inet workspace_portal"
# The IANA special-purpose IPv4 ranges; NOT_PUBLIC in gateway/src/config.ts is the same list (a test compares them).
NOT_PUBLIC="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3"

# The never set. NEVER_REACH may hold IPv4 addresses and CIDRs only: nft would look a name up.
never_elements() {
  local item items=() out="$WORKSPACE_SUBNET, $ONLINE_SUBNET, $READER_SUBNET, $SEARXNG_SUBNET"
  IFS=, read -r -a items <<<"$NEVER_REACH"
  for item in "${items[@]}"; do
    item=${item//[[:space:]]/}
    [[ -n $item ]] || continue
    if [[ ! $item =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}(/([0-9]|[12][0-9]|3[0-2]))?$ ]]; then
      echo "firewall.sh: NEVER_REACH holds \"$item\", not an IPv4 address or CIDR" >&2
      return 1
    fi
    out+=", $item"
  done
  printf '%s' "$out"
}

# The template for the reader and for SearXNG: NAME, BRIDGE, SUBNET, DNS_1 and DNS_2 stand for that one's name
# and its READER_* or SEARXNG_* settings.
internet_only() { # template
  local name key setting line
  for name in reader searxng; do
    line=${1//NAME/$name}
    for key in BRIDGE SUBNET DNS_1 DNS_2; do
      setting=${name^^}_$key
      line=${line//$key/${!setting}}
    done
    printf '%s\n' "$line"
  done
}

ruleset() {
  local never setting
  # Here, before any output: a failure in a $(...) of the here-document would only leave its part out of the table.
  for setting in WORKSPACE_{SUBNET,GATEWAY_IP,BRIDGE} SERVICE_PORT ONLINE_{SUBNET,GATEWAY_IP,BRIDGE,DNS_1,DNS_2} {READER,SEARXNG}_{SUBNET,BRIDGE,DNS_1,DNS_2} NEVER_REACH; do
    [[ -n ${!setting-} ]] || { echo "firewall.sh: $setting is missing or empty" >&2; return 1; }
  done
  never=$(never_elements) || return 1
  cat <<NFT
table $TABLE {
  set not_public {
    type ipv4_addr
    flags interval
    elements = { $NOT_PUBLIC }
  }

  set never {
    type ipv4_addr
    flags interval
    auto-merge
    elements = { $never }
  }

  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "lo" ip daddr 127.0.0.1 tcp dport $SERVICE_PORT reject with icmpx admin-prohibited
    iifname "$WORKSPACE_BRIDGE" jump from_workspace
    iifname != "lo" ip saddr $WORKSPACE_SUBNET jump from_workspace
    iifname "$ONLINE_BRIDGE" jump online_to_host
    iifname != "lo" ip saddr $ONLINE_SUBNET jump online_to_host
$(internet_only '    iifname "BRIDGE" jump NAME_to_host
    iifname != "lo" ip saddr SUBNET jump NAME_to_host')
  }

  chain from_workspace {
    ct state established,related accept
    ip daddr $WORKSPACE_GATEWAY_IP tcp dport $SERVICE_PORT ct state new accept
    drop
  }

  chain online_to_host {
    ct state established,related accept
    ip daddr $ONLINE_GATEWAY_IP tcp dport $SERVICE_PORT ct state new accept
    drop
  }

  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    iifname "$WORKSPACE_BRIDGE" drop
    oifname "$WORKSPACE_BRIDGE" drop
    ip saddr $WORKSPACE_SUBNET drop
    ip daddr $WORKSPACE_SUBNET drop
    iifname "$ONLINE_BRIDGE" jump online_out
    ip saddr $ONLINE_SUBNET jump online_out
    oifname "$ONLINE_BRIDGE" jump online_in
    ip daddr $ONLINE_SUBNET jump online_in
$(internet_only '    iifname "BRIDGE" jump NAME_out
    ip saddr SUBNET jump NAME_out
    oifname "BRIDGE" jump NAME_in
    ip daddr SUBNET jump NAME_in')
  }

  chain online_out {
    ct state established,related accept
    meta nfproto != ipv4 drop
    ip daddr @never drop
    ip daddr @not_public drop
    ip daddr { $ONLINE_DNS_1, $ONLINE_DNS_2 } meta l4proto { tcp, udp } th dport 53 accept
    meta l4proto tcp ct state new accept
    drop
  }

  chain online_in {
    ct state established,related accept
    drop
  }
$(internet_only '
  chain NAME_to_host {
    ct state established,related accept
    drop
  }

  chain NAME_out {
    ct state established,related accept
    meta nfproto != ipv4 drop
    ip daddr @never drop
    ip daddr @not_public drop
    ip daddr { DNS_1, DNS_2 } meta l4proto { tcp, udp } th dport 53 accept
    tcp dport { 80, 443 } accept
    drop
  }

  chain NAME_in {
    ct state established,related accept
    drop
  }')
}
NFT
}

# One transaction, so there is never a moment without rules; "table … {}" lets the delete pass on a first run.
load() { # [-c: a dry run]
  local rules
  # Built first: a ruleset that fails halfway must not follow the delete.
  rules=$(ruleset)
  { echo "table $TABLE {}"; echo "delete table $TABLE"; printf '%s\n' "$rules"; } | nft "$@" -f -
}

case "${1:-}" in
  apply) load ;;
  check) load -c ;;
  remove) nft delete table "$TABLE" 2>/dev/null || true ;;
  status) nft list table "$TABLE" ;;
  print) ruleset ;;
  not-public) tr -d ' ' <<<"$NOT_PUBLIC" | tr ',' '\n' ;;
  *) echo "usage: $0 apply|check|remove|status|print|not-public" >&2; exit 2 ;;
esac
