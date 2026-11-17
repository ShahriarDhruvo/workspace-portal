#!/usr/bin/env bash
# shellcheck disable=SC2016,SC2034  # check() evaluates single-quoted conditions (see below)
# Proves that a Private workspace can reach the gateway's service port (model + web search) and nothing
# else, that an Online workspace can reach its own service port and the public internet (TCP, and DNS at
# its two resolvers) and nothing else, and that the page reader and the search engine can reach the
# public internet and nothing else.
#
#   1. Host: the Docker engine, both workspace networks and the firewall table are what the gateway
#      and deploy/firewall.sh expect: Docker requires the firewall unit, the fence marker answers, the
#      `never` set covers what the installer would put in it now, the resolvers are public, and no
#      /etc/subuid or /etc/subgid range overlaps either kind's UIDs.
#   2. Running workspaces: every wp-ws-* (Private) and wp-wo-* (Online) container has the restrictions
#      the gateway applies, its own kind's UID, network and folders, and no user has two.
#   2b. Workspace folders: users/<id> and each kind's folder are root's (0711), each kind's home and
#      workspace belong to that kind's UID only (0700).
#   3. Reachability from a Private workspace: for every enabled agent, a throwaway container on the
#      Private network (that agent's image, a workspace UID, read-only root, no capabilities) probes
#      TCP, UDP, ICMP and IPv6 targets: the gateway's other ports, every host address, the Online
#      service listener, the LLM server and SearXNG directly, the page reader, the router, the
#      internet and the other workspaces of both kinds (each on its agent's port).
#   3b. Reachability from an Online workspace: the same kind of container on the Online network, with
#      the Online DNS settings, must reach its service port, public names and public TCP ports (web
#      and other), and nothing of the rest: the host's other ports and addresses, the Private
#      listener, the LAN, the LLM server and portal-hostd (public addresses included), the reader and
#      SearXNG, the other workspaces of both kinds, UDP other than DNS to its two resolvers, ICMP, IPv6.
#   4. The page reader: its container has nothing (no capabilities, mounts or secrets), it refuses
#      every address that is not public, and the firewall stops it from reaching the host, the LAN,
#      the workspaces and SearXNG even when asked from inside the container.
#   5. The search engine (SearXNG): its container has nothing but its own key, it answers the
#      gateway's kind of request, and the firewall stops it from reaching the host, the LAN, the
#      workspaces and the reader.
#
# Safe to run any time; touches no user data.
#   sudo bash deploy/verify-isolation.sh
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

NETWORK=$(env_get WORKSPACE_NETWORK)
BRIDGE=$(env_get WORKSPACE_BRIDGE)
SUBNET=$(env_get WORKSPACE_SUBNET)
GW=$(env_get WORKSPACE_GATEWAY_IP)
SERVICE_PORT=$(env_get SERVICE_PORT)
CONTROL_PORT=$(env_get CONTROL_PORT)
WEB_PORT=$(web_port)
AGENT_PORTS=$(agent_port_range)
FIRST_AGENT_PORT=${AGENT_PORTS%-*}
PREVIEW_PORTS=$(preview_port_range)
FIRST_PREVIEW_PORT=${PREVIEW_PORTS%-*}
UID_BASE=$(env_get WORKSPACE_UID_BASE)
DATA_DIR=$(env_get PORTAL_DATA_DIR)
READER_PORT=$(env_get READER_PORT)
READER_BRIDGE=$(env_get READER_BRIDGE)
READER_SUBNET=$(env_get READER_SUBNET)
READER_ON=true
[[ $(env_get READER_URL | tr '[:upper:]' '[:lower:]') != off ]] || READER_ON=false
READER_ID=""
if $READER_ON; then READER_ID=$(docker compose --project-directory "$ROOT" ps -q reader 2>/dev/null || true); fi
READER_IP=""
if [[ -n $READER_ID ]]; then READER_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$READER_ID"); fi
READER_GW=$(ip -4 -o addr show dev "$READER_BRIDGE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
SEARXNG_PORT=$(env_get SEARXNG_PORT)
SEARXNG_BRIDGE=$(env_get SEARXNG_BRIDGE)
SEARXNG_SUBNET=$(env_get SEARXNG_SUBNET)
SEARXNG_ID=$(docker compose --project-directory "$ROOT" ps -q searxng 2>/dev/null || true)
SEARXNG_IP=""
if [[ -n $SEARXNG_ID ]]; then SEARXNG_IP=$(docker inspect -f '{{range .NetworkSettings.Networks}}{{.IPAddress}}{{end}}' "$SEARXNG_ID"); fi
SEARXNG_GW=$(ip -4 -o addr show dev "$SEARXNG_BRIDGE" 2>/dev/null | awk '{print $4}' | cut -d/ -f1 || true)
GATEWAY_ID=$(docker compose --project-directory "$ROOT" ps -q gateway 2>/dev/null || true)
ONLINE_NETWORK=$(env_get ONLINE_NETWORK)
ONLINE_BRIDGE=$(env_get ONLINE_BRIDGE)
ONLINE_SUBNET=$(env_get ONLINE_SUBNET)
ONLINE_RANGE=$(env_get ONLINE_IP_RANGE)
ONLINE_GW=$(env_get ONLINE_GATEWAY_IP)
ONLINE_DNS_1=$(env_get ONLINE_DNS_1)
ONLINE_DNS_2=$(env_get ONLINE_DNS_2)
ONLINE_UID_BASE=$(env_get ONLINE_UID_BASE)
ONLINE_AGENT_PORTS=$(online_agent_port_range)
FIRST_ONLINE_AGENT_PORT=${ONLINE_AGENT_PORTS%-*}
ONLINE_PREVIEW_PORTS=$(online_preview_port_range)
FIRST_ONLINE_PREVIEW_PORT=${ONLINE_PREVIEW_PORTS%-*}
ONLINE_ON=false
if online_enabled; then ONLINE_ON=true; fi
PORT_COUNT=$(env_get AGENT_PORT_COUNT)
load_enabled_agents

pass=0 fail=0
ok() { echo "PASS  $1"; pass=$((pass + 1)); }
bad() { echo "FAIL  $1"; fail=$((fail + 1)); }
# The condition is a single-quoted expression evaluated here, so it reads the variables set just before
# (hence the file-wide shellcheck directive at the top).
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; } # description condition

# ---------------------------------------------------------------- 1. host
echo "== host"
check "Docker engine $(docker version --format '{{.Server.Version}}' 2>/dev/null) has the internal-network DNS fix (>= 25.0.5)" docker_version_ok
docker network inspect "$NETWORK" >/dev/null 2>&1 || die "network $NETWORK does not exist yet: start the stack first"
net() { docker network inspect -f "$1" "$NETWORK"; }
check "network $NETWORK is internal (no route off the host)" '[[ $(net "{{.Internal}}") == true ]]'
check "network $NETWORK has inter-container traffic disabled" '[[ $(net "{{index .Options \"com.docker.network.bridge.enable_icc\"}}") == false ]]'
check "network $NETWORK uses bridge $BRIDGE (the firewall matches on it)" '[[ $(net "{{index .Options \"com.docker.network.bridge.name\"}}") == "$BRIDGE" ]]'
check "network $NETWORK is $SUBNET with gateway $GW" '[[ $(net "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}}{{end}}") == "$SUBNET $GW" ]]'
check "network $NETWORK has no IPv6" '[[ $(net "{{.EnableIPv6}}") == false ]]'
check "firewall unit workspace-portal-firewall is active" 'systemctl is-active --quiet workspace-portal-firewall'
check "Docker requires the firewall unit (a failed firewall keeps Docker and every container down)" \
  '[[ " $(systemctl show -p Requires --value docker.service) " == *" workspace-portal-firewall.service "* ]]'
rules=$(nft list table inet workspace_portal 2>/dev/null || true)
check "firewall table allows only $GW tcp/$SERVICE_PORT from the workspace network" \
  '[[ $rules == *"iifname \"$BRIDGE\" jump from_workspace"* && $rules == *"ip daddr $GW tcp dport $SERVICE_PORT ct state new accept"* ]]'
# What the gateway checks before it lets an Online workspace run (gateway/src/fence.ts): a connection to
# 127.0.0.1:SERVICE_PORT is refused as administratively prohibited (EHOSTUNREACH) while the table is loaded.
fence_answer() {
  python3 -I -c '
import errno, socket, sys
s = socket.socket(); s.settimeout(2)
try: s.connect(("127.0.0.1", int(sys.argv[1]))); print("connected")
except OSError as error: print(errno.errorcode.get(error.errno, "timeout") if error.errno else "timeout")' "$SERVICE_PORT"
}
fence=$(fence_answer)
check "the fence marker answers on 127.0.0.1:$SERVICE_PORT (EHOSTUNREACH, got $fence): the gateway lets Online workspaces run only then" '[[ $fence == EHOSTUNREACH ]]'
# The `never` set as loaded must cover what the installer would put in it now: the addresses the LLM server and
# the rest have now, this host's networks (what not_public covers anyway aside: a Docker network created since
# is no reason to re-run the installer). The probes below try them, too.
never_now=$(never_reach 2>/dev/null || true)
never_missing=$(nft -j list set inet workspace_portal never 2>/dev/null | python3 -I -c '
import ipaddress, json, sys
loaded = []
try:
    items = next(entry["set"] for entry in json.load(sys.stdin)["nftables"] if "set" in entry).get("elem", [])
except (ValueError, StopIteration, KeyError):
    items = []
for item in items:
    item = item.get("elem", {}).get("val", item) if isinstance(item, dict) and "elem" in item else item
    if isinstance(item, str):
        loaded.append(ipaddress.ip_network(item))
    elif "prefix" in item:
        loaded.append(ipaddress.ip_network("%s/%s" % (item["prefix"]["addr"], item["prefix"]["len"])))
    elif "range" in item:
        loaded.extend(ipaddress.summarize_address_range(*map(ipaddress.ip_address, item["range"])))
loaded += [ipaddress.ip_network(n) for n in sys.argv[2].split()]
wanted = [ipaddress.ip_network(n) for n in sys.argv[1].split(",") if n]
print(" ".join(str(n) for n in wanted if not any(n.subnet_of(l) for l in loaded)))' "$never_now" "$(not_public_ranges)" 2>/dev/null || echo "(the set could not be read)")
check "firewall set never covers this host's networks and the servers the portal talks to (${never_now}) ${never_missing:+; missing: $never_missing: re-run sudo bash deploy/install.sh}" '[[ -n $never_now && -z $never_missing ]]'
# Resolvers: public ones (the firewall drops private addresses before it lets DNS through, as the gateway and the
# installer refuse others).
for key in ONLINE_DNS_1 ONLINE_DNS_2 READER_DNS_1 READER_DNS_2 SEARXNG_DNS_1 SEARXNG_DNS_2; do
  resolver=$(env_get "$key")
  check "$key ($resolver) is a public resolver, outside the never set" \
    '[[ $resolver =~ ^[0-9]+(\.[0-9]+){3}$ ]] && ipv4_public "$resolver" && ipv4_outside "$resolver" "$never_now"'
done
# A host account with a subordinate range over a workspace UID could read that workspace's files through a user
# namespace (podman unshare). The installer refuses such ranges; one added since (useradd) shows here.
for uid_key in WORKSPACE_UID_BASE ONLINE_UID_BASE; do
  uid_base=$(env_get "$uid_key")
  first=$((uid_base + 1)) last=$((uid_base + PORT_COUNT - 1)) overlap=""
  for file in /etc/subuid /etc/subgid; do
    [[ -r $file ]] || continue
    while IFS=: read -r name start size; do
      [[ $start =~ ^[0-9]+$ && $size =~ ^[0-9]+$ ]] || continue
      if ((start <= last && start + size - 1 >= first)); then overlap+=" ${name}'s ${start}-$((start + size - 1)) in ${file}"; fi
    done <"$file"
  done
  check "no /etc/subuid or /etc/subgid range overlaps the ${uid_key%_BASE} range ${first}-${last}${overlap:+ (overlapping:$overlap)}" '[[ -z $overlap ]]'
done

# The Online network: a NAT bridge (its way to the internet), otherwise as fenced as the Private one. Its
# firewall chains are loaded whether or not Online is on.
if $ONLINE_ON; then
  if docker network inspect "$ONLINE_NETWORK" >/dev/null 2>&1; then
    onet() { docker network inspect -f "$1" "$ONLINE_NETWORK"; }
    check "network $ONLINE_NETWORK is not internal, with masquerade (Online workspaces reach the internet through NAT)" \
      '[[ $(onet "{{.Internal}} {{index .Options \"com.docker.network.bridge.enable_ip_masquerade\"}}") == "false true" ]]'
    check "network $ONLINE_NETWORK has inter-container traffic disabled" '[[ $(onet "{{index .Options \"com.docker.network.bridge.enable_icc\"}}") == false ]]'
    check "network $ONLINE_NETWORK uses bridge $ONLINE_BRIDGE (the firewall matches on it)" '[[ $(onet "{{index .Options \"com.docker.network.bridge.name\"}}") == "$ONLINE_BRIDGE" ]]'
    check "network $ONLINE_NETWORK is $ONLINE_SUBNET with gateway $ONLINE_GW, addresses from $ONLINE_RANGE" \
      '[[ $(onet "{{range .IPAM.Config}}{{.Subnet}} {{.Gateway}} {{.IPRange}}{{end}}") == "$ONLINE_SUBNET $ONLINE_GW $ONLINE_RANGE" ]]'
    check "network $ONLINE_NETWORK has no IPv6" '[[ $(onet "{{.EnableIPv6}}") == false ]]'
  else
    bad "network $ONLINE_NETWORK exists (the gateway creates it at start while ONLINE_WORKSPACES is on)"
  fi
else
  echo "(Online workspaces are off: ONLINE_WORKSPACES=off)"
fi
online_out=$(nft list chain inet workspace_portal online_out 2>/dev/null || true)
online_in=$(nft list chain inet workspace_portal online_in 2>/dev/null || true)
online_dns=$(grep 'th dport 53 accept' <<<"$online_out" || true)
check "firewall table allows only $ONLINE_GW tcp/$SERVICE_PORT on the host from the Online network" \
  '[[ $rules == *"iifname \"$ONLINE_BRIDGE\" jump online_to_host"* && $rules == *"ip daddr $ONLINE_GW tcp dport $SERVICE_PORT ct state new accept"* ]]'
check "firewall table lets the Online network out only to DNS at $ONLINE_DNS_1 and $ONLINE_DNS_2 and over TCP to public addresses outside never, IPv4 only" \
  '[[ $rules == *"iifname \"$ONLINE_BRIDGE\" jump online_out"* && $online_out == *"meta nfproto != ipv4 drop"*"ip daddr @never drop"*"ip daddr @not_public drop"*"th dport 53 accept"*"meta l4proto tcp ct state new accept"*"drop"* && $online_dns == *"$ONLINE_DNS_1"* && $online_dns == *"$ONLINE_DNS_2"* ]]'
check "firewall table forwards nothing to the Online network but replies" \
  '[[ $rules == *"oifname \"$ONLINE_BRIDGE\" jump online_in"* && $online_in == *"ct state established,related accept"*"drop"* && $online_in != *"new"* ]]'

# ---------------------------------------------------------------- 2. running workspaces
echo "== running workspaces"
running=$(docker ps -q --filter label=workspace-portal.workspace=1)
[[ -n $running ]] || echo "(none running; start one and re-run to inspect it)"
seen_users=" "
for id in $running; do
  name=$(docker inspect -f '{{.Name}}' "$id"); name=${name#/}
  user_id=$(docker inspect -f '{{index .Config.Labels "workspace-portal.user-id"}}' "$id")
  user=$(docker inspect -f '{{.Config.User}}' "$id")
  agent=$(docker inspect -f '{{index .Config.Labels "workspace-portal.agent"}}' "$id")
  kind=$(docker inspect -f '{{index .Config.Labels "workspace-portal.kind"}}' "$id")
  # Containers from before kinds carry no kind label: they are Private.
  case ${kind:-private} in
    private) kind=private own_network=$NETWORK own_uid_base=$UID_BASE prefix=wp-ws- ;;
    online) own_network=$ONLINE_NETWORK own_uid_base=$ONLINE_UID_BASE prefix=wp-wo- ;;
    *) bad "$name has a kind the gateway doesn't know (workspace-portal.kind=$kind)"; continue ;;
  esac
  check "$name is user $user_id's only running workspace (one kind at a time)" '[[ $seen_users != *" $user_id "* ]]'
  seen_users+="$user_id "
  check "$name is the $kind workspace of user $user_id ($prefix$user_id)" '[[ $name == "$prefix$user_id" ]]'
  check "$name runs a known agent (${agent:-qwen, from before the agent label})" '[[ -z $agent || " ${AGENTS[*]} " == *" $agent "* ]]'
  check "$name runs as its own $kind UID ($user)" '[[ $user == "$((own_uid_base + user_id)):$((own_uid_base + user_id))" ]]'
  check "$name: read-only root, all capabilities dropped, no-new-privileges, not privileged" \
    '[[ $(docker inspect -f "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}}" "$id") == "true [ALL] [no-new-privileges:true] false" ]]'
  check "$name: only on $own_network, no published ports" \
    '[[ $(docker inspect -f "{{.HostConfig.NetworkMode}} {{len .HostConfig.PortBindings}} {{len .NetworkSettings.Networks}}" "$id") == "$own_network 0 1" ]]'
  # Online mounts only users/<id>/online/; Private only users/<id>/, never its online/ (a Private container
  # from before kinds still mounts users/<id>/home and workspace).
  sources=$(docker inspect -f '{{range .Mounts}}{{.Source}}{{"\n"}}{{end}}' "$id" | grep -v '^$' || true)
  if [[ $kind == online ]]; then
    foreign=$(grep -v "^$DATA_DIR/users/$user_id/online/" <<<"$sources" || true)
  else
    foreign=$({ grep -v "^$DATA_DIR/users/$user_id/" <<<"$sources"; grep "^$DATA_DIR/users/$user_id/online/" <<<"$sources"; } || true)
  fi
  check "$name mounts only its own user's $kind folders" '[[ -z $foreign ]]'
  if [[ $kind == online ]]; then
    check "$name resolves names only through $ONLINE_DNS_1 and $ONLINE_DNS_2" \
      '[[ $(docker inspect -f "{{.HostConfig.Dns}}" "$id") == "[$ONLINE_DNS_1 $ONLINE_DNS_2]" ]]'
    check "$name runs while Online workspaces are on (ONLINE_WORKSPACES)" '$ONLINE_ON'
  fi
done

# ---------------------------------------------------------------- 2b. workspace folders
echo "== workspace folders"
# Ownership is the access model (docs/ARCHITECTURE.md, Data directory): root's folders hold each kind's two,
# which only that kind's UID may enter.
owner_mode() { stat -c '%u:%g %a' "$1" 2>/dev/null || echo missing; }
users_dir="$DATA_DIR/users"
check "users/ is root's, mode 0711" '[[ $(owner_mode "$users_dir") == "0:0 711" ]]'
for dir in "$users_dir"/*; do
  [[ -e $dir ]] || continue
  user_id=${dir##*/}
  if [[ ! -d $dir || ! $user_id =~ ^[1-9][0-9]*$ ]]; then
    bad "users/$user_id is not a user's folder (users/<id>)"
    continue
  fi
  check "users/$user_id is root's, mode 0711" '[[ $(owner_mode "$dir") == "0:0 711" ]]'
  for kind in private online; do
    [[ -e $dir/$kind ]] || continue
    if [[ $kind == private ]]; then uid=$((UID_BASE + user_id)); else uid=$((ONLINE_UID_BASE + user_id)); fi
    check "users/$user_id/$kind is root's, mode 0711" '[[ $(owner_mode "$dir/$kind") == "0:0 711" ]]'
    for sub in home workspace; do
      [[ -e $dir/$kind/$sub ]] || continue
      check "users/$user_id/$kind/$sub belongs to the $kind UID $uid alone, mode 0700" '[[ $(owner_mode "$dir/$kind/$sub") == "$uid:$uid 700" ]]'
    done
    if [[ -e $dir/$kind/system ]]; then check "users/$user_id/$kind/system is root's, mode 0755" '[[ $(owner_mode "$dir/$kind/system") == "0:0 755" ]]'; fi
  done
  # The Private files from before kinds stay where they were only while the container from before mounts them; the
  # gateway moves them into private/ at the next start.
  legacy=$(find "$dir" -mindepth 1 -maxdepth 1 \( -name home -o -name workspace -o -name system \) -printf '%f ' | sed 's/ $//')
  others=$(find "$dir" -mindepth 1 -maxdepth 1 ! -name private ! -name online ! -name home ! -name workspace ! -name system -printf '%f ' | sed 's/ $//')
  check "users/$user_id holds nothing but private/ and online/${others:+ (also: $others)}" '[[ -z $others ]]'
  if [[ -n $legacy ]]; then
    check "users/$user_id/{$legacy} (the Private files from before kinds) are still mounted by user $user_id's Private container from before" \
      '[[ -n $(docker ps -q --filter "name=^wp-ws-$user_id\$" --filter label=workspace-portal.workspace=1) ]]'
    for sub in home workspace; do
      if [[ -e $dir/$sub ]]; then check "users/$user_id/$sub belongs to the Private UID $((UID_BASE + user_id)) alone, mode 0700" '[[ $(owner_mode "$dir/$sub") == "$((UID_BASE + user_id)):$((UID_BASE + user_id)) 700" ]]'; fi
    done
  fi
done

# ---------------------------------------------------------------- 3. reachability
echo "== reachability from a workspace"
# "ip port label" lines for TCP targets that must be unreachable.
closed=()
add_closed() { closed+=("$1 $2 $3"); }
add_closed "$GW" 22 "host-SSH-via-the-bridge"
add_closed "$GW" "$WEB_PORT" "the-portal-via-the-bridge"
add_closed "$GW" "$CONTROL_PORT" "the-gateway-control-API"
add_closed "$GW" "$FIRST_AGENT_PORT" "a-workspace-port-via-the-bridge"
add_closed "$GW" "$FIRST_PREVIEW_PORT" "a-preview-port-via-the-bridge"
for address in $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -v -e '^127\.' -e "^$GW$"); do
  add_closed "$address" 22 "SSH-on-host-address-$address"
  add_closed "$address" "$WEB_PORT" "the-portal-on-host-address-$address"
done
# The model server and SearXNG must only be reachable through the gateway: every address their names have now. One
# on this host is tried through the bridge; host_local keeps its port for the Online bridge (3b).
host_local=()
upstream() { # url label
  local host port address
  host=$(url_host "$1")
  port=$(url_port "$1")
  case $host in
    localhost | 127.* | "$(host_ip)")
      add_closed "$GW" "$port" "$2-directly"
      host_local+=("$port $2")
      ;;
    *) for address in $(url_ipv4s "$1"); do add_closed "$address" "$port" "$2-directly"; done ;;
  esac
}
upstream "$(env_get LLM_UPSTREAM_URL)" "the-LLM-server"
upstream "$(searxng_url)" "SearXNG"
# portal-hostd (server readings, engine updates) is the gateway's to ask, never a workspace's.
for hostd in HOSTD_PORTAL HOSTD_LLM; do
  url=$(env_get "${hostd}_URL")
  if [[ -n $(env_get "${hostd}_TOKEN") && -n $url && ${url,,} != off ]]; then upstream "$url" "the-${hostd#HOSTD_}-portal-hostd"; fi
done
ROUTER=$(ip -4 route show default | awk '{print $3; exit}')
if [[ -n $ROUTER ]]; then add_closed "$ROUTER" 80 "the-router"; fi
add_closed 1.1.1.1 443 "the-internet"
add_closed 8.8.8.8 53 "public-DNS-over-TCP"
# The page reader is the gateway's to call, never a workspace's.
add_closed "$GW" "$READER_PORT" "the-page-reader-via-the-bridge"
if [[ -n $READER_GW ]]; then add_closed "$READER_GW" "$READER_PORT" "the-page-reader-on-its-own-bridge"; fi
if [[ -n $READER_IP ]]; then add_closed "$READER_IP" 8080 "the-page-reader-container"; fi
# Nor is the stack's own SearXNG: the gateway does the searching.
if ! searxng_is_builtin; then add_closed "$GW" "$SEARXNG_PORT" "the-built-in-SearXNG-via-the-bridge"; fi
if [[ -n $SEARXNG_GW ]]; then add_closed "$SEARXNG_GW" "$SEARXNG_PORT" "the-built-in-SearXNG-on-its-own-bridge"; fi
if [[ -n $SEARXNG_IP ]]; then add_closed "$SEARXNG_IP" 8080 "the-built-in-SearXNG-container"; fi
# "ip port" of every running workspace on one network (Private or Online): its address there and its agent's port,
# from its agent label (Qwen Code's without one, from before the label; both agents' for an agent the label names
# but this script doesn't know).
workspace_peers() { # network
  local id ip agent
  for id in $(docker ps -q --filter label=workspace-portal.workspace=1); do
    ip=$(docker inspect -f "{{with index .NetworkSettings.Networks \"$1\"}}{{.IPAddress}}{{end}}" "$id")
    [[ -n $ip ]] || continue
    agent=$(docker inspect -f '{{index .Config.Labels "workspace-portal.agent"}}' "$id")
    case ${agent:-qwen} in
      qwen | dsh) echo "$ip $(agent_port "${agent:-qwen}")" ;;
      *) for agent in "${AGENTS[@]}"; do echo "$ip $(agent_port "$agent")"; done ;;
    esac
  done
}
while read -r peer port; do
  if [[ -n $peer ]]; then add_closed "$peer" "$port" "another-workspace"; fi
done < <(workspace_peers "$NETWORK")
# Nothing of the Online side: its service listener, the Online ports, its workspaces.
private_closed=("$ONLINE_GW $SERVICE_PORT the-Online-service-listener" "$GW $FIRST_ONLINE_AGENT_PORT an-Online-workspace-port-via-the-bridge"
  "$GW $FIRST_ONLINE_PREVIEW_PORT an-Online-preview-port-via-the-bridge")
while read -r peer port; do
  if [[ -n $peer ]]; then private_closed+=("$peer $port an-Online-workspace"); fi
done < <(workspace_peers "$ONLINE_NETWORK")

# The probes run inside a throwaway workspace container: a common head and tail around what a kind must
# and must not reach.
PROBE_HEAD=$(cat <<'SH'
pass=0; fail=0
ok()  { echo "PASS  $1"; pass=$((pass+1)); }
bad() { echo "FAIL  $1"; fail=$((fail+1)); }
reach() { timeout 3 bash -c "exec 3<>/dev/tcp/$1/$2" 2>/dev/null; }
no_ipv6() {
  if python3 -c 'import sys; sys.exit(0 if all(l.split()[-1] == "lo" for l in open("/proc/net/if_inet6")) else 1)' 2>/dev/null; then
    ok "no IPv6 address on any interface"
  else
    bad "has an IPv6 address: $(grep -v ' lo$' /proc/net/if_inet6 | awk '{print $6}' | tr '\n' ' ')"
  fi
}
SH
)

PRIVATE_PROBE=$(cat <<'SH'
if reach "$GW" "$SERVICE_PORT"; then ok "reaches the gateway service port $GW:$SERVICE_PORT (model + search)"; else bad "cannot reach the gateway service port $GW:$SERVICE_PORT"; fi
while read -r ip port label; do
  [ -n "$ip" ] || continue
  if reach "$ip" "$port"; then bad "REACHES ${label//-/ } ($ip:$port)"; else ok "blocked: ${label//-/ } ($ip:$port)"; fi
done <<<"$CLOSED"

# UDP and ICMP have no handshake: send a real DNS query or echo request and wait for an answer.
python3 - "$GW" "$ROUTER" <<'PY'
import socket, struct, sys
gw, router = sys.argv[1], sys.argv[2]
def dns(server):
    query = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(query, (server, 53)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
def ping(host):
    try: s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except OSError: return False  # unprivileged ICMP not even allowed
    s.settimeout(2)
    try:
        s.sendto(struct.pack(">BBHHH", 8, 0, 0, 0, 1) + b"probe", (host, 0)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
for server in [gw, router, "1.1.1.1", "8.8.8.8"]:
    if server: print(("FAIL  answers" if dns(server) else "PASS  blocked:") + f" DNS over UDP to {server}:53")
for host in [gw, router, "1.1.1.1"]:
    if host: print(("FAIL  answers" if ping(host) else "PASS  blocked:") + f" ICMP echo to {host}")
PY
no_ipv6
if getent hosts example.com >/dev/null 2>&1; then bad "DNS resolves example.com"; else ok "no DNS for internet names"; fi
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$GW:$SERVICE_PORT/llm/v1/models" || true)
if [ "$code" = 403 ]; then ok "the service API refuses callers that are not workspaces (HTTP 403)"; else bad "the service API answered HTTP $code to a caller that is not a workspace"; fi
SH
)

ONLINE_PROBE=$(cat <<'SH'
if reach "$ONLINE_GW" "$SERVICE_PORT"; then ok "reaches its gateway service port $ONLINE_GW:$SERVICE_PORT (model + search)"; else bad "cannot reach its gateway service port $ONLINE_GW:$SERVICE_PORT"; fi
while read -r ip port label; do
  [ -n "$ip" ] || continue
  if reach "$ip" "$port"; then bad "REACHES ${label//-/ } ($ip:$port)"; else ok "blocked: ${label//-/ } ($ip:$port)"; fi
done <<<"$CLOSED"

# The public internet: names through its two resolvers, then any TCP port.
if getent ahostsv4 example.com >/dev/null 2>&1; then ok "resolves public names (example.com)"; else bad "cannot resolve public names (ONLINE_DNS_1 / ONLINE_DNS_2 in .env)"; fi
if reach 1.1.1.1 443; then ok "reaches the public internet (1.1.1.1:443)"; else bad "cannot reach the public internet (1.1.1.1:443)"; fi
if reach 1.1.1.1 853; then ok "reaches a public port other than 80 and 443 (1.1.1.1:853)"; else bad "cannot reach a public port other than 80 and 443 (1.1.1.1:853)"; fi
github=$(getent ahostsv4 github.com 2>/dev/null | awk '{print $1; exit}')
if [ -n "$github" ] && reach "$github" 22; then ok "reaches a public host by name on another port (github.com:22)"; else bad "cannot reach github.com:22"; fi

# UDP and ICMP have no handshake: send a real query or echo request and wait for an answer. (DNS over TCP is
# TCP like any other: open to every public server, as every TCP port is.)
python3 - "$ONLINE_DNS_1" "$OTHER_DNS" "$ONLINE_GW" "$ROUTER" <<'PY'
import socket, struct, sys
own_dns, other_dns, gw, router = sys.argv[1:5]
def ask(server, port, payload):
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try:
        s.sendto(payload, (server, port)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
DNS = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
NTP = b"\x1b" + 47 * b"\0"
def ping(host):
    try: s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except OSError: return False  # unprivileged ICMP not even allowed
    s.settimeout(2)
    try:
        s.sendto(struct.pack(">BBHHH", 8, 0, 0, 0, 1) + b"probe", (host, 0)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
print(("PASS  answers:" if ask(own_dns, 53, DNS) else "FAIL  no answer:") + f" DNS over UDP to its own resolver {own_dns}:53")
for server in [other_dns, gw, router]:
    if server: print(("FAIL  answers" if ask(server, 53, DNS) else "PASS  blocked:") + f" DNS over UDP to {server}:53")
print(("FAIL  answers" if ask("162.159.200.1", 123, NTP) else "PASS  blocked:") + " UDP other than DNS (NTP to 162.159.200.1:123)")
for host in [gw, router, "1.1.1.1"]:
    if host: print(("FAIL  answers" if ping(host) else "PASS  blocked:") + f" ICMP echo to {host}")
def reach6(host, port):
    try: s = socket.socket(socket.AF_INET6, socket.SOCK_STREAM)
    except OSError: return False
    s.settimeout(3)
    try: s.connect((host, port)); return True
    except OSError: return False
    finally: s.close()
print(("FAIL  reaches" if reach6("2606:4700:4700::1111", 443) else "PASS  blocked:") + " the internet over IPv6 ([2606:4700:4700::1111]:443)")
PY
no_ipv6
code=$(curl -s -o /dev/null -w '%{http_code}' --max-time 5 "http://$ONLINE_GW:$SERVICE_PORT/llm/v1/models" || true)
if [ "$code" = 403 ]; then ok "its service API refuses callers that are not Online workspaces (HTTP 403)"; else bad "its service API answered HTTP $code to a caller that is not a workspace"; fi
SH
)

PROBE_TAIL=$(cat <<'SH'
[ "$(id -u)" != 0 ] && ok "runs as uid $(id -u), not root" || bad "runs as root"
caps=$(awk '/^CapEff/ {print $2}' /proc/self/status)
[ "$caps" = 0000000000000000 ] && ok "no capabilities" || bad "capabilities: $caps"
grep -q '^NoNewPrivs:[[:space:]]*1' /proc/self/status && ok "no-new-privileges" || bad "new privileges allowed"
if LC_ALL=C touch /usr/probe 2>&1 | grep -q 'Read-only file system'; then ok "read-only root filesystem"; else bad "root filesystem is not read-only"; fi
if [ -n "$(find / -xdev -perm /6000 -type f 2>/dev/null | head -1)" ]; then bad "setuid/setgid binaries in the image"; else ok "no setuid/setgid binaries"; fi
if [ -S /var/run/docker.sock ] || [ -S /run/docker.sock ]; then bad "the Docker socket is inside"; else ok "no Docker socket inside"; fi
if [ -n "$(ls -A /srv 2>/dev/null)" ]; then bad "host data visible in /srv"; else ok "no host data inside"; fi
echo "probe: passed $pass, failed $fail"
[ "$fail" = 0 ]
SH
)

# Runs inside the reader and the SearXNG container (sections 4 and 5): what the firewall lets each
# of them reach.
INSIDE_PROBE=$(cat <<'PY'
import errno, os, socket, struct
who, other_dns = os.environ["WHO"], os.environ["OTHER_DNS"]
def reach(ip, port):
    s = socket.socket(); s.settimeout(3)
    try: s.connect((ip, int(port))); return True
    except OSError: return False
    finally: s.close()
# UDP and ICMP have no handshake: send a real DNS query or echo request and wait for an answer.
def dns(server):
    query = struct.pack(">HHHHHH", 0x1234, 0x0100, 1, 0, 0, 0) + b"\x07example\x03com\x00" + struct.pack(">HH", 1, 1)
    s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM); s.settimeout(2)
    try: s.sendto(query, (server, 53)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
def ping(host):
    try: s = socket.socket(socket.AF_INET, socket.SOCK_DGRAM, socket.IPPROTO_ICMP)
    except OSError: return False  # unprivileged ICMP not even allowed
    s.settimeout(2)
    try: s.sendto(struct.pack(">BBHHH", 8, 0, 0, 0, 1) + b"probe", (host, 0)); s.recvfrom(512); return True
    except OSError: return False
    finally: s.close()
for line in os.environ["TARGETS"].splitlines():
    ip, port, label = line.split(None, 2)
    print((f"FAIL  {who} REACHES " if reach(ip, port) else f"PASS  {who} blocked: ") + label.replace("-", " ") + f" ({ip}:{port})")
print((f"FAIL  {who} REACHES " if reach(other_dns, 53) else f"PASS  {who} blocked: ") + f"a DNS server other than its own ({other_dns}:53)")
print((f"FAIL  {who} gets an answer from " if dns(other_dns) else f"PASS  {who} blocked: ") + f"DNS over UDP to a server other than its own ({other_dns}:53)")
print((f"FAIL  {who} gets an answer to " if ping("1.1.1.1") else f"PASS  {who} blocked: ") + "ICMP echo to 1.1.1.1")
print((f"PASS  {who} reaches" if reach("1.1.1.1", 443) else f"FAIL  {who} cannot reach") + " the public internet (1.1.1.1:443)")
try: socket.getaddrinfo("example.com", 443, socket.AF_INET); print(f"PASS  {who} resolves public names")
except OSError: print(f"FAIL  {who} cannot resolve public names ({os.environ['DNS_SETTINGS']} in .env)")
print(f"FAIL  {who} runs as root" if os.getuid() == 0 else f"PASS  {who} runs as uid {os.getuid()}, not root")
caps = [line.split()[1] for line in open("/proc/self/status") if line.startswith("CapEff")][0]
print(f"PASS  {who} has no capabilities" if int(caps, 16) == 0 else f"FAIL  {who} capabilities: " + caps)
# EROFS and nothing else: "permission denied" would also be the answer of a writable root to this user.
try: open("/usr/probe", "w"); print(f"FAIL  {who} root filesystem is writable")
except OSError as error:
    print(f"PASS  {who} has a read-only root filesystem" if error.errno == errno.EROFS else f"FAIL  {who} root filesystem is not read-only ({error.strerror})")
print("inside probe: done")
PY
)

NAME="wp-isolation-probe-$$"
trap 'docker rm -f "$NAME" >/dev/null 2>&1 || true' EXIT
# Runs a probe in a throwaway container from every enabled agent's image, as a workspace of a kind runs
# (that kind's network, a UID in its range that no real user has, the same restrictions), and counts
# what it prints.
run_probe() { # kind network uid-base script [docker run options...]
  local kind=$1 network=$2 uid=$(($3 + 99999)) script=$4 agent image output
  shift 4
  for agent in "${ENABLED_AGENTS[@]}"; do
    image=$(workspace_image "$agent")
    echo "-- from the $(agent_name "$agent") image ($image), as a $kind workspace"
    if ! docker image inspect "$image" >/dev/null 2>&1; then
      bad "$image exists (build it: sudo bash deploy/install.sh)"
      continue
    fi
    output=$(docker run --rm --name "$NAME" --network "$network" --user "$uid:$uid" \
      --read-only --tmpfs /tmp:rw,nosuid,nodev,size=16m --cap-drop ALL --security-opt no-new-privileges \
      --pids-limit 128 --memory 256m --entrypoint /bin/bash "$@" \
      "$image" -c "$PROBE_HEAD"$'\n'"$script"$'\n'"$PROBE_TAIL" 2>&1) || true
    echo "$output" | grep -v '^probe: '
    pass=$((pass + $(grep -c '^PASS' <<<"$output" || true)))
    fail=$((fail + $(grep -c '^FAIL' <<<"$output" || true)))
    grep -q '^probe: ' <<<"$output" || bad "the $kind probe container ($agent) did not run to the end (see output above)"
  done
}
run_probe private "$NETWORK" "$UID_BASE" "$PRIVATE_PROBE" \
  -e GW="$GW" -e SERVICE_PORT="$SERVICE_PORT" -e ROUTER="${ROUTER:-}" \
  -e CLOSED="$(printf '%s\n' "${closed[@]}" "${private_closed[@]}")"

# ---------------------------------------------------------------- 3b. reachability from an Online workspace
echo "== reachability from an Online workspace"
if ! $ONLINE_ON; then
  echo "(off: ONLINE_WORKSPACES=off)"
elif ! docker network inspect "$ONLINE_NETWORK" >/dev/null 2>&1; then
  bad "network $ONLINE_NETWORK exists, to probe from"
else
  # What the Private probe may not reach, but for the public internet, which Online may reach on any TCP
  # port (DNS is checked against its own two resolvers below). The LLM server, portal-hostd and an outside
  # SearXNG stay out of reach even at public addresses (the firewall's never set); and the host's ports on the
  # Online bridge, the Private listener, and the other workspaces of both kinds.
  online_closed=()
  for target in "${closed[@]}"; do
    case $target in
      *the-internet | *public-DNS-over-TCP) ;;
      *) online_closed+=("$target") ;;
    esac
  done
  for entry in "${host_local[@]}"; do
    read -r port label <<<"$entry"
    online_closed+=("$ONLINE_GW $port $label-via-the-Online-bridge")
  done
  online_closed+=("$GW $SERVICE_PORT the-Private-service-listener"
    "$ONLINE_GW 22 host-SSH-via-the-Online-bridge" "$ONLINE_GW $WEB_PORT the-portal-via-the-Online-bridge"
    "$ONLINE_GW $CONTROL_PORT the-gateway-control-API-via-the-Online-bridge"
    "$ONLINE_GW $FIRST_AGENT_PORT a-Private-workspace-port-via-the-Online-bridge"
    "$ONLINE_GW $FIRST_ONLINE_AGENT_PORT an-Online-workspace-port-via-the-Online-bridge"
    "$ONLINE_GW $FIRST_PREVIEW_PORT a-Private-preview-port-via-the-Online-bridge"
    "$ONLINE_GW $FIRST_ONLINE_PREVIEW_PORT an-Online-preview-port-via-the-Online-bridge"
    "$ONLINE_GW $READER_PORT the-page-reader-via-the-Online-bridge" "$ONLINE_GW $SEARXNG_PORT SearXNG-via-the-Online-bridge")
  while read -r peer port; do
    if [[ -n $peer ]]; then online_closed+=("$peer $port another-Online-workspace"); fi
  done < <(workspace_peers "$ONLINE_NETWORK")
  # A public resolver that is not one of the two.
  for candidate in 8.8.8.8 208.67.222.222 9.9.9.10; do
    if [[ $candidate != "$ONLINE_DNS_1" && $candidate != "$ONLINE_DNS_2" ]]; then other_dns=$candidate; break; fi
  done
  run_probe online "$ONLINE_NETWORK" "$ONLINE_UID_BASE" "$ONLINE_PROBE" \
    --dns "$ONLINE_DNS_1" --dns "$ONLINE_DNS_2" --dns-search . \
    -e ONLINE_GW="$ONLINE_GW" -e SERVICE_PORT="$SERVICE_PORT" -e ROUTER="${ROUTER:-}" -e ONLINE_DNS_1="$ONLINE_DNS_1" -e OTHER_DNS="$other_dns" \
    -e CLOSED="$(printf '%s\n' "${online_closed[@]}")"
fi

# ---------------------------------------------------------------- 4 and 5. the internet-only containers
# What the firewall must keep the reader and SearXNG from, asked from inside each container as if
# its own checks had failed.
inside=("$GW $SERVICE_PORT the-gateway-service-port" "$GW 22 host-SSH-via-the-workspace-bridge" "$ONLINE_GW $SERVICE_PORT the-Online-service-listener")
for address in $(ip -4 -o addr show | awk '{print $4}' | cut -d/ -f1 | grep -v '^127\.'); do
  inside+=("$address 22 SSH-on-host-address-$address" "$address $WEB_PORT the-portal-on-host-address-$address" "$address $CONTROL_PORT the-gateway-control-API-on-$address")
done
if [[ -n $ROUTER ]]; then inside+=("$ROUTER 80 the-router" "$ROUTER 53 DNS-on-the-router"); fi
# The firewall keeps these containers off the LLM server and portal-hostd at any address, public ones included
# (its never set).
for target in "${closed[@]}"; do
  case $target in
    *the-LLM-server-directly | *portal-hostd-directly | *SearXNG-directly | *another-workspace) inside+=("$target") ;;
  esac
done
for target in "${private_closed[@]}"; do
  case $target in *an-Online-workspace) inside+=("$target") ;; esac
done
inside+=("1.1.1.1 22 a-public-address-on-another-port")

# The restrictions both containers run under.
locked_down() { # who container user network bridge subnet port
  local who=$1 id=$2 user=$3 network=$4 bridge=$5 subnet=$6 port=$7
  on() { docker inspect -f "$1" "$id"; }
  check "$who: read-only root, all capabilities dropped, no-new-privileges, not privileged" \
    '[[ $(on "{{.HostConfig.ReadonlyRootfs}} {{.HostConfig.CapDrop}} {{.HostConfig.SecurityOpt}} {{.HostConfig.Privileged}}") == "true [ALL] [no-new-privileges:true] false" ]]'
  check "$who runs as an unprivileged user ($(on '{{.Config.User}}'))" '[[ $(on "{{.Config.User}}") == "$user" ]]'
  check "$who has no volumes and no Docker socket" '[[ $(on "{{len .Mounts}}") == 0 ]]'
  check "$who is published on the loopback interface only (127.0.0.1:$port)" '[[ $(docker port "$id" 8080/tcp) == "127.0.0.1:$port" ]]'
  check "$who is on its own network only ($network)" '[[ $(on "{{range \$name, \$_ := .NetworkSettings.Networks}}{{\$name}} {{end}}") == "$network " ]]'
  check "$who network is bridge $bridge, $subnet, without IPv6" \
    '[[ $(docker network inspect -f "{{index .Options \"com.docker.network.bridge.name\"}} {{range .IPAM.Config}}{{.Subnet}}{{end}} {{.EnableIPv6}}" "$network") == "$bridge $subnet false" ]]'
}

# The firewall chains of one of them: the jumps from its bridge, and in its own forward chain the
# drops of the never set and of everything that is not public before the two ports are let through.
fenced() { # who chain-prefix bridge
  local who=$1 name=$2 bridge=$3 out
  out=$(nft list chain inet workspace_portal "${name}_out" 2>/dev/null || true)
  check "firewall table keeps $who off the host, the never set and private networks" \
    '[[ $rules == *"iifname \"$bridge\" jump ${name}_to_host"* && $rules == *"iifname \"$bridge\" jump ${name}_out"* && $rules == *"oifname \"$bridge\" jump ${name}_in"* && $out == *"ip daddr @never drop"*"ip daddr @not_public drop"*"tcp dport { 80, 443 } accept"*"drop"* ]]'
}

# Runs INSIDE_PROBE in a container and counts what it prints.
probe_inside() { # who container dns-settings-prefix target...
  local who=$1 id=$2 prefix=$3 output other_dns candidate
  shift 3
  # A public resolver that is not one of the container's two.
  for candidate in 8.8.8.8 208.67.222.222 9.9.9.10; do
    if [[ $candidate != "$(env_get "${prefix}_1")" && $candidate != "$(env_get "${prefix}_2")" ]]; then other_dns=$candidate; break; fi
  done
  output=$(docker exec -e WHO="$who" -e DNS_SETTINGS="${prefix}_1 / ${prefix}_2" -e OTHER_DNS="$other_dns" -e TARGETS="$(printf '%s\n' "$@")" "$id" python3 -c "$INSIDE_PROBE" 2>&1) || true
  echo "$output" | grep -v '^inside probe: '
  pass=$((pass + $(grep -c '^PASS' <<<"$output" || true)))
  fail=$((fail + $(grep -c '^FAIL' <<<"$output" || true)))
  grep -q '^inside probe: done' <<<"$output" || bad "the probe inside the $who container did not run to the end (see output above)"
}

echo "== page reader"
if ! $READER_ON; then
  echo "(off: READER_URL=off)"
elif [[ -z $READER_ID ]]; then
  bad "the reader container is running (start it: sudo bash deploy/install.sh)"
else
  locked_down reader "$READER_ID" 10002:10002 workspace-portal-reader "$READER_BRIDGE" "$READER_SUBNET" "$READER_PORT"
  check "reader holds no secret (no key, password or token in its environment)" \
    '! docker inspect -f "{{range .Config.Env}}{{println .}}{{end}}" "$READER_ID" | grep -qiE "secret|password|api_key|authorization|token"'
  fenced "the reader" reader "$READER_BRIDGE"

  # What the reader itself refuses. Each of these must come back as a refusal, never as a page.
  HOST_IP=$(host_ip || true)
  refused=("http://127.0.0.1/" "http://localhost/" "http://127.1/" "http://2130706433/" "http://0x7f.0.0.1/" "http://[::1]/"
    "http://[::ffff:127.0.0.1]/" "http://169.254.169.254/latest/meta-data/" "http://$GW:$SERVICE_PORT/llm/v1/models"
    "http://100.100.100.100/" "http://example.com:22/" "http://user:pw@example.com/" "file:///etc/passwd" "gopher://example.com/"
    "http://portal.local/" "http://router/" "$(env_get LLM_UPSTREAM_URL)/v1/models" "$(searxng_builtin_url)/search?q=x&format=json")
  if ! searxng_is_builtin; then refused+=("$(searxng_url)/search?q=x&format=json"); fi
  if [[ -n $HOST_IP ]]; then refused+=("http://$HOST_IP:$WEB_PORT/" "http://$HOST_IP/"); fi
  if [[ -n $ROUTER ]]; then refused+=("http://$ROUTER/"); fi
  if [[ -n $READER_GW ]]; then refused+=("http://$READER_GW/"); fi
  if [[ -n $SEARXNG_IP ]]; then refused+=("http://$SEARXNG_IP:8080/"); fi
  ask_reader() { # url -> the reader's JSON answer
    python3 -c 'import json,sys; print(json.dumps({"url": sys.argv[1]}))' "$1" |
      curl -s --max-time 40 -H 'content-type: application/json' --data-binary @- "http://127.0.0.1:$READER_PORT/read" || true
  }
  for url in "${refused[@]}"; do
    answer=$(ask_reader "$url")
    check "reader refuses $url" '[[ $answer == *"\"ok\": false"* && $answer =~ \"code\":\ \"(blocked|bad_url)\" ]]'
  done
  answer=$(ask_reader "https://example.com/")
  check "reader reads a public page (https://example.com/)" '[[ $answer == *"\"ok\": true"* && $answer == *"Example Domain"* ]]'

  reader_inside=("${inside[@]}")
  for target in "${closed[@]}"; do
    case $target in *SearXNG-directly | *the-built-in-SearXNG-*) reader_inside+=("$target") ;; esac
  done
  probe_inside reader "$READER_ID" READER_DNS "${reader_inside[@]}"
fi

echo "== search engine (SearXNG)"
if [[ -z $SEARXNG_ID ]]; then
  bad "the searxng container is running (start it: sudo bash deploy/install.sh)"
else
  locked_down SearXNG "$SEARXNG_ID" 977:977 workspace-portal-searxng "$SEARXNG_BRIDGE" "$SEARXNG_SUBNET" "$SEARXNG_PORT"
  searxng_env=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$SEARXNG_ID")
  check "SearXNG holds no secret but its own key (nothing of the portal's, the LLM's or the admin's)" \
    '! grep -iE "secret|password|api_key|authorization|token" <<<"$searxng_env" | grep -qv "^SEARXNG_SECRET="'
  searxng_key=$(sed -n 's/^SEARXNG_SECRET=//p' <<<"$searxng_env")
  check "SearXNG has a key of its own (not empty, not the example key)" '[[ -n $searxng_key && $searxng_key != ultrasecretkey ]]'
  fenced SearXNG searxng "$SEARXNG_BRIDGE"
  check "SearXNG answers on 127.0.0.1:$SEARXNG_PORT" 'curl -fsS --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/healthz" >/dev/null'
  # An empty query asks no search engine: SearXNG answers 400 when the JSON format is allowed and
  # 403 when it is not.
  check "SearXNG allows the JSON format the gateway asks for" \
    '[[ $(curl -s -o /dev/null -w "%{http_code}" --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/search?q=&format=json") == 400 ]]'
  # What the gateway container was really started with, against what .env says now.
  gateway_searxng=""
  if [[ -n $GATEWAY_ID ]]; then gateway_searxng=$(docker inspect -f '{{range .Config.Env}}{{println .}}{{end}}' "$GATEWAY_ID" | sed -n 's/^SEARXNG_URL=//p'); fi
  check "the gateway searches through $(searxng_url), as .env says" '[[ ${gateway_searxng%/} == "$(searxng_url)" ]]'
  if searxng_is_builtin; then
    # The engines SearXNG has loaded, and the ones among them that it asks on every search.
    config=$(curl -fsS --max-time 5 "http://127.0.0.1:$SEARXNG_PORT/config" || true)
    engine_names() { # all | enabled
      python3 -c 'import json,sys; print("\n".join(e["name"] for e in json.load(sys.stdin)["engines"] if sys.argv[1] == "all" or e["enabled"]))' "$1" <<<"$config" 2>/dev/null || true
    }
    loaded=$(engine_names all)
    always=$(engine_names enabled | paste -sd, | sed 's/,/, /g')
    check "SearXNG asks at least one engine on every search (${always:-none})" '[[ -n $always ]]'
    fallback_setting=$(env_get SEARCH_FALLBACK_ENGINES)
    if [[ ${fallback_setting,,} != none ]]; then
      IFS=, read -r -a fallback <<<"$fallback_setting"
      for engine in "${fallback[@]}"; do
        engine=$(sed 's/^ *//; s/ *$//' <<<"$engine")
        [[ -n $engine ]] || continue
        check "SearXNG has loaded the fallback engine $engine (SEARCH_FALLBACK_ENGINES)" 'grep -qxF "$engine" <<<"$loaded"'
      done
    fi
  else
    echo "(the gateway searches through $(searxng_url), not through this SearXNG)"
    check "the SearXNG at $(searxng_url) answers" 'searxng_answers "$(searxng_url)"'
  fi

  searxng_inside=("${inside[@]}")
  for target in "${closed[@]}"; do
    case $target in *the-page-reader-*) searxng_inside+=("$target") ;; esac
  done
  probe_inside SearXNG "$SEARXNG_ID" SEARXNG_DNS "${searxng_inside[@]}"
fi

echo "passed $pass, failed $fail"
[[ $fail -eq 0 ]]
