#!/usr/bin/env bash
# Workspace Portal: host firewall for the workspace network, the search engine and the page reader
# (nftables).
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
# The search engine (the searxng container) and the page reader (the reader container), each on a
# bridge of its own, are the opposite case: they must reach the internet, and must reach nothing
# else. The same three rules hold for each of them:
#
#   * To the host, it may only answer the gateway, which calls it through a loopback-published port.
#   * It is forwarded only to public addresses, on TCP 80 and 443, and to its two DNS servers.
#     Private, link-local, carrier-NAT and other reserved ranges are dropped, so nothing can be
#     fetched from the LAN, the LLM server or a cloud metadata address even if the reader's own
#     checks (reader/reader.py) were wrong or a search engine answered with a redirect to such an
#     address.
#   * Nothing is forwarded to it. That includes the other of the two: they are on separate bridges
#     so that the reader, which parses pages from anywhere, shares no network with the container
#     whose results decide which pages an agent may open.
#
# A drop in any nftables base chain is final, so rules other tools add elsewhere (Docker,
# firewalld, Tailscale) cannot reopen what this table drops. Matching on both the bridge name and
# the subnet keeps the rules effective even if one of them were wrong. The table is replaced in
# one atomic transaction, so there is never a moment without rules.
#
# Usage: firewall.sh apply | remove | status | print        (needs root, except print; idempotent)
# Reads WORKSPACE_SUBNET, WORKSPACE_GATEWAY_IP, WORKSPACE_BRIDGE, SERVICE_PORT, and for the reader
# and SearXNG their _SUBNET, _BRIDGE, _DNS_1 and _DNS_2 from the environment; the systemd unit loads
# them from /etc/workspace-portal/firewall.env.
set -euo pipefail

SUBNET=${WORKSPACE_SUBNET:-172.29.0.0/16}
GW_IP=${WORKSPACE_GATEWAY_IP:-172.29.0.1}
BRIDGE=${WORKSPACE_BRIDGE:-br-wportal}
SERVICE_PORT=${SERVICE_PORT:-4001}
READER_SUBNET=${READER_SUBNET:-172.30.250.0/28}
READER_BRIDGE=${READER_BRIDGE:-br-wreader}
READER_DNS_1=${READER_DNS_1:-1.1.1.1}
READER_DNS_2=${READER_DNS_2:-9.9.9.9}
SEARXNG_SUBNET=${SEARXNG_SUBNET:-172.30.250.16/28}
SEARXNG_BRIDGE=${SEARXNG_BRIDGE:-br-wsearxng}
SEARXNG_DNS_1=${SEARXNG_DNS_1:-1.1.1.1}
SEARXNG_DNS_2=${SEARXNG_DNS_2:-9.9.9.9}
# The containers that may reach the public internet and nothing else: "name bridge subnet dns1 dns2".
# The name prefixes their chains (reader_out, searxng_out, ...).
INTERNET_ONLY=(
  "reader $READER_BRIDGE $READER_SUBNET $READER_DNS_1 $READER_DNS_2"
  "searxng $SEARXNG_BRIDGE $SEARXNG_SUBNET $SEARXNG_DNS_1 $SEARXNG_DNS_2"
)
TABLE="inet workspace_portal"
# Everything that is not the public internet (the IANA special-purpose IPv4 ranges).
NOT_PUBLIC="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3"

# One line of the ruleset per internet-only container: the template's NAME, BRIDGE, SUBNET, DNS_1
# and DNS_2 stand for that container's values.
for_each_internet_only() { # template
  local entry name bridge subnet dns_1 dns_2 line
  for entry in "${INTERNET_ONLY[@]}"; do
    read -r name bridge subnet dns_1 dns_2 <<<"$entry"
    line=${1//NAME/$name}
    line=${line//BRIDGE/$bridge}
    line=${line//SUBNET/$subnet}
    line=${line//DNS_1/$dns_1}
    line=${line//DNS_2/$dns_2}
    printf '%s\n' "$line"
  done
}

ruleset() {
  cat <<NFT
table $TABLE {
  set not_public {
    type ipv4_addr
    flags interval
    elements = { $NOT_PUBLIC }
  }

  chain input {
    type filter hook input priority filter - 10; policy accept;
    iifname "$BRIDGE" jump from_workspace
    iifname != "lo" ip saddr $SUBNET jump from_workspace
$(for_each_internet_only '    iifname "BRIDGE" jump NAME_to_host
    iifname != "lo" ip saddr SUBNET jump NAME_to_host')
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
$(for_each_internet_only '    iifname "BRIDGE" jump NAME_out
    ip saddr SUBNET jump NAME_out
    oifname "BRIDGE" jump NAME_in
    ip daddr SUBNET jump NAME_in')
  }
$(for_each_internet_only '
  chain NAME_to_host {
    ct state established,related accept
    drop
  }

  chain NAME_out {
    ct state established,related accept
    meta nfproto != ipv4 drop
    ip daddr { DNS_1, DNS_2 } meta l4proto { tcp, udp } th dport 53 accept
    ip daddr @not_public drop
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
  for_each_internet_only "  NAME: bridge BRIDGE, subnet SUBNET, allowed: public tcp/80,443 and DNS at DNS_1, DNS_2"
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
  print) ruleset ;; # the ruleset "apply" would load, for a look or for nft -c
  *) echo "usage: $0 apply|remove|status|print" >&2; exit 2 ;;
esac
