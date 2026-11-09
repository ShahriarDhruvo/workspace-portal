# Shared helpers for the deploy scripts. Source it; don't run it.
#
# Settings come from .env, falling back to .env.example, so every default lives in one place.

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
ENV_FILE="$ROOT/.env"

log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m!!\033[0m %s\n' "$*" >&2; }
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
require_root() { [[ $EUID -eq 0 ]] || die "run as root: sudo bash $0"; }

# Prints the value of KEY in FILE, parsed like docker compose does: quotes removed, and for
# unquoted values a " #" comment stripped. Returns 1 when the key is missing or empty.
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

# The setting KEY: from .env, else .env.example, else DEFAULT (empty if not given).
env_get() { # key [default]
  env_value "$ENV_FILE" "$1" || env_value "$ROOT/.env.example" "$1" || printf '%s' "${2-}"
}

# Sets KEY=VALUE in .env, replacing an existing line or appending one.
env_set() { # key value
  if grep -qE "^$1=" "$ENV_FILE"; then
    sed -i "s|^$1=.*|$1=$2|" "$ENV_FILE"
  else
    printf '%s=%s\n' "$1" "$2" >>"$ENV_FILE"
  fi
}

# The workspace image is named after the Qwen Code version it contains; docker-compose.yml derives
# the gateway's WORKSPACE_IMAGE the same way.
workspace_image() { # [version]
  printf 'workspace-portal/workspace:qwen-%s' "${1:-$(env_get QWEN_CODE_VERSION)}"
}

build_workspace_image() { # version [extra docker build args...]
  local version=$1
  shift
  log "building $(workspace_image "$version") (Qwen Code $version)"
  docker build --pull "$@" --build-arg "QWEN_CODE_VERSION=$version" -t "$(workspace_image "$version")" "$ROOT/workspace-image"
}

# The host's address on the default route (what users type in the browser on the LAN).
host_ip() { ip -4 route get 1.1.1.1 2>/dev/null | awk '{for(i=1;i<=NF;i++) if($i=="src"){print $(i+1); exit}}'; }

# The ports users' browsers need: the portal and one port per workspace.
web_port() { env_get WEB_PORT; }
agent_port_range() { # prints FIRST-LAST
  local base count
  base=$(env_get AGENT_PORT_BASE)
  count=$(env_get AGENT_PORT_COUNT)
  printf '%s-%s' "$((base + 1))" "$((base + count - 1))"
}

# Sources allowed to reach those ports: FIREWALL_ALLOW_SOURCE, or the LAN of the default route
# plus Tailscale's address range when a tailscale0 interface exists.
portal_sources() {
  local configured dev lan
  configured=$(env_get FIREWALL_ALLOW_SOURCE)
  if [[ -n $configured ]]; then printf '%s' "$configured"; return; fi
  dev=$(ip -4 route show default | awk '{for(i=1;i<=NF;i++) if($i=="dev"){print $(i+1); exit}}')
  lan=$(ip -4 route show dev "${dev:-lo}" scope link proto kernel 2>/dev/null | awk '{print $1; exit}')
  if ip link show tailscale0 >/dev/null 2>&1; then lan="${lan:+$lan }100.64.0.0/10"; fi
  printf '%s' "$lan"
}

# firewalld rich rules (or ufw rules) for the portal ports, one per source and port range.
portal_rich_rules() {
  local source port
  for source in $(portal_sources); do
    for port in "$(web_port)" "$(agent_port_range)"; do
      printf 'rule family="ipv4" source address="%s" port port="%s" protocol="tcp" accept\n' "$source" "$port"
    done
  done
}

# Docker engines before 25.0.5 forward DNS queries from internal networks to the outside world
# (CVE-2024-29018), which would give workspaces a way out.
docker_version_ok() {
  local version major minor patch
  version=$(docker version --format '{{.Server.Version}}' 2>/dev/null) || return 1
  IFS=. read -r major minor patch <<<"${version%%[-+]*}"
  minor=${minor:-0} patch=${patch%%[!0-9]*}
  [[ $major =~ ^[0-9]+$ && $minor =~ ^[0-9]+$ ]] || return 1
  ((major > 25 || (major == 25 && minor > 0) || (major == 25 && minor == 0 && ${patch:-0} >= 5)))
}
