# shellcheck shell=bash
# Helpers of the deploy scripts (source it). Settings come from .env; a missing or blank one is .env.example's.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
require_root() { [[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"; }

# KEY's value in FILE as docker compose reads a KEY=value line without "$" or escapes: without quotes, or without
# a " #" comment when unquoted. Fails when the key is missing or empty.
env_value() { # file key
  local line
  line=$(grep -E "^$2=" "$1" 2>/dev/null | tail -n 1) || return 1
  line=${line#*=}
  case $line in
    \"*) line=${line#\"}; line=${line%%\"*} ;;
    \'*) line=${line#\'}; line=${line%%\'*} ;;
    *) line=${line%% #*}; line=${line%"${line##*[![:space:]]}"} ;;
  esac
  [[ -n $line ]] || return 1
  printf '%s' "$line"
}

env_get() { # key [default, for a setting .env.example leaves empty]
  env_value "$ENV_FILE" "$1" || env_value "$ROOT/.env.example" "$1" || printf '%s' "${2-}"
}

env_set() { # key value
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    # A last line without a newline would swallow the new one.
    [[ -z $(tail -c 1 "$ENV_FILE") ]] || echo >>"$ENV_FILE"
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# True when the setting is one of the words, in any case.
env_is() { # key word...
  local value word
  value=$(env_get "$1")
  for word in "${@:2}"; do [[ ${value,,} != "$word" ]] || return 0; done
  return 1
}

online_enabled() { ! env_is ONLINE_WORKSPACES false off no 0; }
exa_enabled() { env_is EXA_SEARCH true on yes 1; }
selinux_on() { command -v selinuxenabled >/dev/null && selinuxenabled; }

# Per agent: its name and the .env key of its version, which is also the build argument of its Dockerfile stage.
# Its CLI and its stage are named like the agent.
AGENTS=(qwen dsh opencode)
declare -A AGENT_NAME=([qwen]="Qwen Code" [dsh]="DeepSeek Harness" [opencode]="OpenCode")
declare -A AGENT_VERSION_KEY=([qwen]=QWEN_CODE_VERSION [dsh]=DSH_VERSION [opencode]=OPENCODE_VERSION)
known_agent() { [[ -n ${AGENT_NAME[${1:-?}]-} ]] || die "unknown agent \"$1\" (one of: ${AGENTS[*]})"; }

# Sets ENABLED_AGENTS from WORKSPACE_AGENTS, read as the gateway does: in any case, empty items left out. Dies on
# an unknown agent, so call it outside $(...).
load_enabled_agents() {
  local agent
  read -r -a ENABLED_AGENTS <<<"$(env_get WORKSPACE_AGENTS | tr ',[:upper:]' ' [:lower:]')"
  [[ ${#ENABLED_AGENTS[@]} -gt 0 ]] || die "WORKSPACE_AGENTS is empty: list one or more of ${AGENTS[*]}"
  for agent in "${ENABLED_AGENTS[@]}"; do known_agent "$agent"; done
}

# A version as the gateway accepts one (isVersion in packages/core/src/wire/versions.ts). C locale: ASCII ranges only.
VERSION_PATTERN='[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?'
valid_version() { # version
  local LC_ALL=C
  [[ ${#1} -le 100 && $1 =~ ^$VERSION_PATTERN$ ]]
}

# The versions in use: KEY=VALUE lines with the .env keys, written by the admin console and update-image.sh and
# read by the gateway at boot. A missing or invalid entry means .env's version.
agent_versions_file() { printf '%s/config/agent-versions.env' "$(env_get PORTAL_DATA_DIR)"; }

agent_version() { # agent
  local key=${AGENT_VERSION_KEY[$1]} version
  if version=$(env_value "$(agent_versions_file)" "$key") && valid_version "$version"; then
    printf '%s' "$version"
  else
    env_get "$key"
  fi
}

# Keeps the file's other lines and replaces it by a rename (mktemp: root only, as the gateway writes it).
agent_version_set() { # agent version
  local key=${AGENT_VERSION_KEY[$1]} file tmp
  file=$(agent_versions_file)
  tmp=$(mktemp "$(dirname "$file")/.agent-versions.env.XXXXXX")
  { grep -vE "^$key=" "$file" 2>/dev/null || true; printf '%s=%s\n' "$key" "$2"; } >"$tmp"
  mv -f "$tmp" "$file"
}

workspace_image() { # agent [version]
  printf 'workspace-portal/workspace:%s-%s' "$1" "${2:-$(agent_version "$1")}"
}

# Dies unless the agent in the image reports VERSION (asked offline, with a home it can write to, as the gateway
# asks: OpenCode opens its log there even for this).
check_workspace_image() { # agent version
  local image reported
  image=$(workspace_image "$1" "$2")
  reported=$(docker run --rm --network none --tmpfs /tmp -e HOME=/tmp --entrypoint "$1" "$image" --version 2>/dev/null |
    grep -oE "$VERSION_PATTERN" | head -n 1) || true
  [[ $reported == "$2" ]] || die "$image reports ${AGENT_NAME[$1]} \"$reported\", expected $2"
}

build_workspace_image() { # agent version [docker build options...]
  local agent=$1 version=$2
  shift 2
  log "building $(workspace_image "$agent" "$version") (${AGENT_NAME[$agent]} $version)"
  docker build --pull "$@" --target "$agent" --build-arg "${AGENT_VERSION_KEY[$agent]}=$version" \
    -t "$(workspace_image "$agent" "$version")" "$ROOT/workspace-image"
  check_workspace_image "$agent" "$version"
}

# Dies while Admin > Updates runs an agent or engine update, which a rebuild or a gateway restart would break.
# (A gateway that doesn't answer runs none. The secret goes to curl on stdin, not on its command line.)
no_console_update() { # [what to do afterwards]
  local answer
  answer=$(curl -fsS --max-time 20 -H @- "http://127.0.0.1:$(env_get CONTROL_PORT)/control/updates/running" \
    <<<"Authorization: Bearer $(env_get GATEWAY_CONTROL_SECRET)" 2>/dev/null) || return 0
  [[ ! $answer =~ \"running\":\ *true ]] || die "Admin > Updates is running an update: wait for it or cancel it there${1:+; $1}"
}

# Docker before 25.0.5 lets containers on internal networks resolve internet names (CVE-2024-29018).
docker_version_ok() {
  local version
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || return 1
  [[ $version == [0-9]* && $(printf '%s\n' 25.0.5 "$version" | sort -V | head -n 1) == 25.0.5 ]]
}

# The stack's own SearXNG, and the one the gateway uses (SEARXNG_URL when .env names another).
searxng_builtin_url() { printf 'http://127.0.0.1:%s' "$(env_get SEARXNG_PORT)"; }
searxng_url() {
  local url
  url=$(env_get SEARXNG_URL "$(searxng_builtin_url)")
  printf '%s' "${url%/}"
}
searxng_is_builtin() {
  local url
  url=$(searxng_url)
  [[ ${url/\/\/localhost:/\/\/127.0.0.1:} == "$(searxng_builtin_url)" ]]
}
searxng_answers() { # url
  local auth header=()
  auth=$(env_get SEARXNG_AUTHORIZATION)
  [[ -z $auth ]] || header=(-H "Authorization: $auth")
  curl -fsS --max-time 5 -o /dev/null "${header[@]}" "$1/healthz" 2>/dev/null
}

# The word after KEY on each line of stdin: ip's "via <router>", "dev <interface>", "src <address>".
word_after() { awk -v key="$1" '{for (i = 1; i < NF; i++) if ($i == key) print $(i + 1)}'; }
host_ip() { ip -4 route get 1.1.1.1 2>/dev/null | word_after src; }
routers() { ip -4 route show default | word_after via; }

# This server's name in its tailnet's HTTPS certificates. Fails when the tailnet issues none.
tailscale_name() {
  tailscale status --json 2>/dev/null | python3 -I -c 'import json, sys; print(json.load(sys.stdin)["CertDomains"][0])' 2>/dev/null
}
# Where browsers find the portal: with deploy/tailscale-https.sh under that name, else at this host's address.
portal_url() {
  if env_is PORTAL_HTTPS true; then
    printf 'https://%s' "$(tailscale_name || echo '<https-name>')"
  else
    printf 'http://%s:%s' "$(host_ip || echo '<server-ip>')" "$(env_get WEB_PORT)"
  fi
}

url_host() { python3 -I -c 'import sys, urllib.parse as u; print(u.urlsplit(sys.argv[1]).hostname or "")' "$1" 2>/dev/null; }
url_port() {
  python3 -I -c 'import sys, urllib.parse as u
url = u.urlsplit(sys.argv[1]); print(url.port or (443 if url.scheme == "https" else 80))' "$1" 2>/dev/null
}
# The IPv4 addresses a URL's host has now (none for an IPv6 literal or a name that doesn't resolve).
url_ipv4s() { getent ahostsv4 "$(url_host "$1")" 2>/dev/null | awk '{print $1}' | sort -u; }

# firewall.sh's not_public ranges, one per line.
not_public_ranges() { bash "$ROOT/deploy/firewall.sh" not-public; }

# The resolver settings the firewall would let no answer through for, as " KEY (value)": it lets DNS through only
# to public IPv4 addresses outside NEVER.
bad_resolvers() { # never
  local key
  for key in ONLINE_DNS_1 ONLINE_DNS_2 READER_DNS_1 READER_DNS_2 SEARXNG_DNS_1 SEARXNG_DNS_2; do
    python3 -I -c '
import ipaddress, sys
try:
    address = ipaddress.IPv4Address(sys.argv[1])
except ValueError:
    sys.exit(1)
sys.exit(any(address in ipaddress.ip_network(n, strict=False) for n in " ".join(sys.argv[2:]).replace(",", " ").split()))' \
      "$(env_get "$key")" "$(not_public_ranges)" "$1" || printf ' %s (%s)' "$key" "$(env_get "$key")"
  done
}

# IPv4 addresses and CIDRs from stdin (separated by commas, spaces or newlines) as one comma-separated list:
# networks masked, overlaps merged, loopback and IPv6 left out. Fails, naming them, on items that are neither.
ipv4_networks() {
  python3 -I -c '
import ipaddress, sys
networks, bad = [], []
for item in sys.stdin.read().replace(",", " ").split():
    try:
        network = ipaddress.ip_network(item, strict=False)
    except ValueError:
        bad.append(item)
        continue
    if network.version == 4 and not network.is_loopback:
        networks.append(network)
if bad:
    sys.exit("not an IPv4 address or CIDR: " + ", ".join(bad))
print(",".join(str(n.network_address) if n.prefixlen == 32 else str(n) for n in ipaddress.collapse_addresses(networks)))'
}

# firewall.sh's NEVER_REACH, what the Online workspaces, the reader and SearXNG reach at no address: this host's
# networks and routers, the servers the portal talks to (at the addresses their names have now) and
# FIREWALL_NEVER_REACH.
never_reach() {
  local key url addresses
  {
    ip -4 -o addr show scope global | awk '{print $4}'
    routers
    for key in LLM_UPSTREAM_URL HOSTD_LLM_URL HOSTD_PORTAL_URL SEARXNG_URL READER_URL; do
      url=$(env_get "$key")
      [[ $url == *://* ]] || continue
      addresses=$(url_ipv4s "$url") || true
      [[ -n $addresses ]] || warn "$key: $(url_host "$url") has no IPv4 address now, so the firewall can't keep the Online workspaces, the reader and SearXNG off it by address. Run the installer again once it resolves."
      printf '%s\n' "$addresses"
    done
    env_get FIREWALL_NEVER_REACH
    echo
  } | ipv4_networks
}

# The UIDs of users 1 … AGENT_PORT_COUNT - 1 from the base in KEY: the /etc/subuid and /etc/subgid ranges that
# overlap them. (Their owners could read those workspaces' files through a user namespace.)
subid_overlaps() { # WORKSPACE_UID_BASE | ONLINE_UID_BASE
  local base
  base=$(env_get "$1")
  awk -F: -v first="$((base + 1))" -v last="$((base + $(env_get AGENT_PORT_COUNT) - 1))" \
    '$2 ~ /^[0-9]+$/ && $3 ~ /^[0-9]+$/ && $2 <= last && $2 + $3 - 1 >= first {
       printf " %s (%d-%d in %s)", $1, $2, $2 + $3 - 1, FILENAME }' /etc/subuid /etc/subgid 2>/dev/null || true
}

# FIRST-LAST of the four ranges browsers reach besides WEB_PORT: the Private and the Online workspaces, then each
# kind's previews, PREVIEW_PORT_OFFSET above (the gateway's, in gateway/src/config.ts: a test compares the two).
PREVIEW_PORT_OFFSET=1000
port_ranges() {
  local base count online
  base=$(env_get AGENT_PORT_BASE) count=$(env_get AGENT_PORT_COUNT)
  online=$(env_get ONLINE_AGENT_PORT_BASE "$((base + count))")
  for base in "$base" "$online" "$((base + PREVIEW_PORT_OFFSET))" "$((online + PREVIEW_PORT_OFFSET))"; do
    printf '%s-%s ' "$((base + 1))" "$((base + count - 1))"
  done
  echo
}

# Who may reach those ports: FIREWALL_ALLOW_SOURCE, else the LAN of the default route and, with a tailscale0
# interface, Tailscale's range.
portal_sources() {
  local configured dev lan
  configured=$(env_get FIREWALL_ALLOW_SOURCE)
  if [[ -n $configured ]]; then printf '%s' "$configured"; return; fi
  dev=$(ip -4 route show default | word_after dev | head -n 1)
  lan=$(ip -4 route show dev "${dev:-lo}" scope link proto kernel 2>/dev/null | awk '{print $1; exit}')
  if ip link show tailscale0 >/dev/null 2>&1; then lan="${lan:+$lan }100.64.0.0/10"; fi
  printf '%s' "$lan"
}

# Adds or removes the firewalld rich rules that open the portal's ports to portal_sources. Both kinds' ranges,
# also with Online off: the gateway answers there that the workspace is stopped.
firewalld_rules() { # add | remove
  local source port rule refused=die
  [[ $1 == add ]] || refused=warn
  for source in $(portal_sources); do
    for port in "$(env_get WEB_PORT)" $(port_ranges); do
      rule="rule family=\"ipv4\" source address=\"$source\" port port=\"$port\" protocol=\"tcp\" accept"
      # A rule already there (or already gone) is exit status 0; a rule firewalld refuses to add leaves the port closed.
      firewall-cmd --permanent "--$1-rich-rule=$rule" >/dev/null 2>&1 || "$refused" "firewalld: could not $1: $rule"
    done
  done
  firewall-cmd --reload >/dev/null
}
