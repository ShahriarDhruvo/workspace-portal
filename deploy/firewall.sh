#!/usr/bin/env bash
# Workspace Portal: host firewall for the two workspace networks (Private and Online), the search
# engine and the page reader (nftables).
#
# The Private workspace network is a Docker *internal* network, so Docker already refuses to route
# anything from it to the outside world. This adds the rest, in a table of its own
# (inet workspace_portal):
#
#   * To the host, a workspace may only open connections to the gateway's service port (LLM +
#     search). Without this it could reach every host service listening on 0.0.0.0 (SSH, the portal,
#     the LLM server, …) through the bridge address.
#   * Nothing from or to the Private network is forwarded, a second lock on the same door should
#     the network ever lose its internal flag.
#
# The Online workspace network is a NAT bridge: its workspaces reach the public internet, and
# nothing else. Its own three chains:
#
#   * online_to_host: to the host, only new TCP connections to the gateway's service port on the
#     Online bridge address (the gateway answers there only to Online containers).
#   * online_out: first two drops, whatever the port: the set `never` (the portal's own container
#     networks, and NEVER_REACH: this host's networks and router, the LLM server and the other servers
#     the portal talks to, whatever their addresses, public ones included; see deploy/install.sh) and
#     the set `not_public` (private, link-local, carrier-NAT and other reserved ranges: the LAN, the
#     other Online containers, whose subnet is private too, …). Then DNS (TCP/UDP 53) to its two
#     resolvers, then new TCP to any port. No other UDP, no ICMP of its own, no IPv6.
#   * online_in: only replies are forwarded to it; nothing can open a connection to an Online
#     workspace.
#
# The search engine (the searxng container) and the page reader (the reader container), each on a
# bridge of its own, are the opposite case: they must reach the internet, and must reach nothing
# else. The same three rules hold for each of them:
#
#   * To the host, it may only answer the gateway, which calls it through a loopback-published port.
#   * It is forwarded only to public addresses outside `never`, on TCP 80 and 443, and to its two DNS
#     servers. So nothing can be fetched from the LAN, the LLM server or a cloud metadata address
#     even if the reader's own checks (reader/reader.py) were wrong or a search engine answered with
#     a redirect to such an address.
#   * Nothing is forwarded to it. That includes the other of the two: they are on separate bridges
#     so that the reader, which parses pages from anywhere, shares no network with the container
#     whose results decide which pages an agent may open.
#
# The drops come before the DNS accept, so not even a resolver can be a way into the LAN (the gateway
# and the installer refuse resolvers that are not public, too).
#
# The fence marker: the input chain's first rule refuses TCP to 127.0.0.1:SERVICE_PORT (nothing
# listens there: the service API is on the bridge addresses) as "administratively prohibited", so a
# connection there fails with EHOSTUNREACH while this table is loaded and with ECONNREFUSED without
# it. The gateway, which may not list the ruleset (no NET_ADMIN), checks it that way and starts no
# Online workspace, and stops the running ones, unless the marker answers (gateway/src/fence.ts). It
# came with the Online chains, so a table from before them doesn't pass either.
#
# A drop in any nftables base chain is final, so rules other tools add elsewhere (Docker,
# firewalld, Tailscale) cannot reopen what this table drops. Matching on both the bridge name and
# the subnet keeps the rules effective even if one of them were wrong. The table is replaced in
# one atomic transaction, so there is never a moment without rules.
#
# Usage: firewall.sh apply | remove | status | print | not-public   (apply, remove and status need root;
# idempotent). print: the ruleset apply would load. not-public: the not_public ranges, one per line.
# Reads WORKSPACE_SUBNET, WORKSPACE_GATEWAY_IP, WORKSPACE_BRIDGE, SERVICE_PORT, ONLINE_SUBNET,
# ONLINE_GATEWAY_IP, ONLINE_BRIDGE, ONLINE_DNS_1, ONLINE_DNS_2, NEVER_REACH, and for the reader and
# SearXNG their _SUBNET, _BRIDGE, _DNS_1 and _DNS_2 from the environment; the systemd unit loads them
# from /etc/workspace-portal/firewall.env. The Online chains are loaded even with ONLINE_WORKSPACES=off:
# without the network they match nothing, and they are in place the moment it is turned on.
set -euo pipefail

SUBNET=${WORKSPACE_SUBNET:-172.29.0.0/16}
GW_IP=${WORKSPACE_GATEWAY_IP:-172.29.0.1}
BRIDGE=${WORKSPACE_BRIDGE:-br-wportal}
SERVICE_PORT=${SERVICE_PORT:-4001}
ONLINE_SUBNET=${ONLINE_SUBNET:-172.28.0.0/16}
ONLINE_GW_IP=${ONLINE_GATEWAY_IP:-172.28.0.1}
ONLINE_BRIDGE=${ONLINE_BRIDGE:-br-wonline}
ONLINE_DNS_1=${ONLINE_DNS_1:-1.1.1.1}
ONLINE_DNS_2=${ONLINE_DNS_2:-9.9.9.9}
READER_SUBNET=${READER_SUBNET:-172.30.250.0/28}
READER_BRIDGE=${READER_BRIDGE:-br-wreader}
READER_DNS_1=${READER_DNS_1:-1.1.1.1}
READER_DNS_2=${READER_DNS_2:-9.9.9.9}
SEARXNG_SUBNET=${SEARXNG_SUBNET:-172.30.250.16/28}
SEARXNG_BRIDGE=${SEARXNG_BRIDGE:-br-wsearxng}
SEARXNG_DNS_1=${SEARXNG_DNS_1:-1.1.1.1}
SEARXNG_DNS_2=${SEARXNG_DNS_2:-9.9.9.9}
# Comma-separated IPv4 addresses and CIDRs (install.sh fills it in; empty: only the container networks).
NEVER_REACH=${NEVER_REACH:-}
# The containers that may reach the public internet and nothing else: "name bridge subnet dns1 dns2".
# The name prefixes their chains (reader_out, searxng_out, ...).
INTERNET_ONLY=(
  "reader $READER_BRIDGE $READER_SUBNET $READER_DNS_1 $READER_DNS_2"
  "searxng $SEARXNG_BRIDGE $SEARXNG_SUBNET $SEARXNG_DNS_1 $SEARXNG_DNS_2"
)
TABLE="inet workspace_portal"
# Everything that is not the public internet (the IANA special-purpose IPv4 ranges). The gateway refuses
# resolvers in it with the same list (NOT_PUBLIC in gateway/src/config.ts; a test keeps the two equal).
NOT_PUBLIC="0.0.0.0/8, 10.0.0.0/8, 100.64.0.0/10, 127.0.0.0/8, 169.254.0.0/16, 172.16.0.0/12, 192.0.0.0/24, 192.0.2.0/24, 192.88.99.0/24, 192.168.0.0/16, 198.18.0.0/15, 198.51.100.0/24, 203.0.113.0/24, 224.0.0.0/3"

# The `never` set: the portal's own container networks, whatever their addresses, and NEVER_REACH. It goes
# into the ruleset as it is, so anything but IPv4 addresses and CIDRs stops the script (and, at boot,
# Docker: docker.service requires the firewall unit).
never_elements() {
  local item items=() out="$SUBNET, $ONLINE_SUBNET, $READER_SUBNET, $SEARXNG_SUBNET"
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
  local never
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
    iifname "$BRIDGE" jump from_workspace
    iifname != "lo" ip saddr $SUBNET jump from_workspace
    iifname "$ONLINE_BRIDGE" jump online_to_host
    iifname != "lo" ip saddr $ONLINE_SUBNET jump online_to_host
$(for_each_internet_only '    iifname "BRIDGE" jump NAME_to_host
    iifname != "lo" ip saddr SUBNET jump NAME_to_host')
  }

  chain from_workspace {
    ct state established,related accept
    ip daddr $GW_IP tcp dport $SERVICE_PORT ct state new accept
    drop
  }

  chain online_to_host {
    ct state established,related accept
    ip daddr $ONLINE_GW_IP tcp dport $SERVICE_PORT ct state new accept
    drop
  }

  chain forward {
    type filter hook forward priority filter - 10; policy accept;
    iifname "$BRIDGE" drop
    oifname "$BRIDGE" drop
    ip saddr $SUBNET drop
    ip daddr $SUBNET drop
    iifname "$ONLINE_BRIDGE" jump online_out
    ip saddr $ONLINE_SUBNET jump online_out
    oifname "$ONLINE_BRIDGE" jump online_in
    ip daddr $ONLINE_SUBNET jump online_in
$(for_each_internet_only '    iifname "BRIDGE" jump NAME_out
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
$(for_each_internet_only '
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
  local rules
  # Built first, so that a bad setting (NEVER_REACH) stops the script here, with the rules loaded before untouched.
  rules=$(ruleset)
  # "table … {}" makes the delete safe on the first run; all three steps are one transaction.
  { echo "table $TABLE {}"; echo "delete table $TABLE"; printf '%s\n' "$rules"; } | nft -f -
  remove_legacy_iptables
  echo "workspace-portal firewall applied (bridge $BRIDGE, subnet $SUBNET, allowed: $GW_IP tcp/$SERVICE_PORT)"
  echo "  online: bridge $ONLINE_BRIDGE, subnet $ONLINE_SUBNET, allowed: $ONLINE_GW_IP tcp/$SERVICE_PORT, public tcp (any port) and DNS at $ONLINE_DNS_1, $ONLINE_DNS_2"
  for_each_internet_only "  NAME: bridge BRIDGE, subnet SUBNET, allowed: public tcp/80,443 and DNS at DNS_1, DNS_2"
  echo "  never reached by these, whatever the address: $(never_elements)"
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
  not-public) tr -d ' ' <<<"$NOT_PUBLIC" | tr ',' '\n' ;;
  *) echo "usage: $0 apply|remove|status|print|not-public" >&2; exit 2 ;;
esac
