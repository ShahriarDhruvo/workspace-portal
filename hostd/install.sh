#!/bin/bash
# portal-hostd installer, both roles. Idempotent; run as root. See hostd/README.md.
#   sudo bash hostd/install.sh portal [--token-stdin] [--port 9180]
#   sudo bash hostd/install.sh llm --portal <portal server IPv4> [--engine-unit gufo.service|none]
#                                  [--engine-user USER] [--token-stdin] [--port 9180]
#   sudo bash hostd/install.sh uninstall
# --token-stdin reads the token as one line from stdin (an argument would show in /proc/*/cmdline).
# Without it an existing /etc/portal-hostd/token is kept, else a new one is generated.
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX=${HOSTD_TEST_PREFIX:-}   # set by test_hostd.py only
LIB_DIR=$PREFIX/usr/local/lib/portal-hostd
CONF_DIR=$PREFIX/etc/portal-hostd
CONF=$CONF_DIR/hostd.conf
TOKEN_FILE=$CONF_DIR/token
UNIT_FILE=$PREFIX/etc/systemd/system/portal-hostd.service
UNIT="portal-hostd.service"

usage() { sed -n '3,8s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; exit 2; }
die() { echo "install.sh: $*" >&2; exit 1; }
warn() { echo "install.sh: warning: $*" >&2; }
say() { echo "install.sh: $*"; }

conf_get() {  # conf_get KEY: its value in the installed conf, empty without one
    [[ -f $CONF ]] || return 0
    sed -n "s/^$1=//p" "$CONF" | tail -n 1
}

put() {  # put MODE FILE: stdin becomes FILE, never half-written
    (umask 077 && cat >"$2.new")
    chmod "$1" "$2.new"
    mv -f "$2.new" "$2"
}

fw_running() { command -v firewall-cmd >/dev/null 2>&1 && firewall-cmd --state >/dev/null 2>&1; }
fw_rule() { printf 'rule family="ipv4" source address="%s/32" port port="%s" protocol="tcp" accept' "$1" "$2"; }

fw_remove() {  # fw_remove IP PORT: drop the rule from every zone that has it
    local ip=$1 port=$2 rule zone changed=0
    [[ -n $ip && -n $port ]] || return 0
    fw_running || { warn "firewalld is not running; not removing the rule for $ip:$port"; return 0; }
    rule=$(fw_rule "$ip" "$port")
    for zone in $(firewall-cmd --get-zones); do
        if firewall-cmd --permanent --zone="$zone" --query-rich-rule="$rule" >/dev/null 2>&1; then
            firewall-cmd --permanent --zone="$zone" --remove-rich-rule="$rule" >/dev/null
            say "firewalld: removed the rule for $ip -> tcp/$port from zone $zone"
            changed=1
        fi
    done
    if [[ $changed == 1 ]]; then firewall-cmd --reload >/dev/null; fi
}

fw_add() {  # fw_add IP PORT: add the rule to the zone of the interface that routes to IP
    local ip=$1 port=$2 rule dev zone
    fw_running || { warn "firewalld is not running; open tcp/$port for $ip yourself"; return 0; }
    rule=$(fw_rule "$ip" "$port")
    dev=$(ip -4 route get "$ip" 2>/dev/null | sed -n 's/.* dev \([^ ]*\).*/\1/p' | head -n 1) || true
    zone=$( [[ -n $dev ]] && firewall-cmd --get-zone-of-interface="$dev" 2>/dev/null ) || zone=$(firewall-cmd --get-default-zone)
    if firewall-cmd --permanent --zone="$zone" --query-rich-rule="$rule" >/dev/null 2>&1; then
        say "firewalld: zone $zone already lets $ip reach tcp/$port"
    else
        firewall-cmd --permanent --zone="$zone" --add-rich-rule="$rule" >/dev/null
        firewall-cmd --reload >/dev/null
        say "firewalld: zone $zone now lets $ip reach tcp/$port"
    fi
}

state_hash() {  # of what a running daemon depends on; a file not there yet adds nothing
    { cat "$LIB_DIR/portal-hostd.py" "$UNIT_FILE" "$CONF" "$TOKEN_FILE" 2>/dev/null || true; } | sha256sum | cut -d' ' -f1
}

wait_health() {  # wait_health PORT: up to 10 s for GET /v1/health
    local port=$1
    for _ in $(seq 1 20); do
        if python3 -I -c "import sys,urllib.request as u; r=u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:$port/v1/health', timeout=2); sys.exit(0 if r.status == 200 else 1)" 2>/dev/null; then
            return 0
        fi
        sleep 0.5
    done
    systemctl --no-pager status "$UNIT" >&2 || true
    journalctl --no-pager -u "$UNIT" -n 30 >&2 || true
    die "portal-hostd did not answer http://127.0.0.1:$port/v1/health within 10 s"
}

uninstall() {
    local ip port
    ip=$(conf_get FIREWALL_SOURCE)
    port=$(conf_get PORT)
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl daemon-reload
    systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
    fw_remove "$ip" "${port:-9180}"
    rm -rf "$CONF_DIR" "$LIB_DIR"
    say "removed portal-hostd (unit, $CONF_DIR, $LIB_DIR$( [[ -n $ip ]] && echo ', firewalld rule' ))."
    say "an engine user's ~/.local/state/portal-hostd (saved previous quadlet) is kept; delete it by hand if unwanted."
}

[[ $EUID -eq 0 ]] || die "run as root (sudo bash hostd/install.sh ...)"
role=${1:-}
case $role in
    portal | llm) shift ;;
    uninstall) uninstall; exit 0 ;;
    '' | -h | --help) usage ;;
    *) die "unknown role '$role' (portal, llm or uninstall)" ;;
esac

token_stdin=0 port=9180 portal="" engine_unit="" engine_user="${SUDO_USER:-}"
while [[ $# -gt 0 ]]; do
    case $1 in
        --token-stdin) token_stdin=1; shift ;;
        --port) port=${2:?--port needs a value}; shift 2 ;;
        --portal) portal=${2:?--portal needs a value}; shift 2 ;;
        --engine-unit) engine_unit=${2:?--engine-unit needs a value}; shift 2 ;;
        --engine-user) engine_user=${2:?--engine-user needs a value}; shift 2 ;;
        -h | --help) usage ;;
        *) die "unknown option $1" ;;
    esac
done
[[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || die "--port must be 1..65535"
[[ -f $SRC_DIR/portal-hostd.py && -f $SRC_DIR/portal-hostd.service ]] || die "run this from the repo (hostd/ files missing)"
command -v python3 >/dev/null || die "python3 is required"

# ---- what the role adds to the conf and the unit
bind=127.0.0.1 identity="DynamicUser=yes" protect_home="ProtectHome=yes" after="" role_conf=()
if [[ $role == llm ]]; then
    bind=0.0.0.0
    [[ $portal =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "llm role needs --portal <portal server IPv4>"
    if [[ $engine_unit != none ]]; then
        [[ -n $engine_user && $engine_user != root ]] || die "pass --engine-user (the user that owns the engine quadlet)"
        IFS=: read -r _ _ uid _ _ home _ < <(getent passwd "$engine_user") || die "no such user $engine_user"
        qdir=$home/.config/containers/systemd
        if [[ -z $engine_unit && ! -f $qdir/gufo.container ]]; then engine_unit=none; fi
    fi
    if [[ $engine_unit == none ]]; then
        say "no engine control (no --engine-unit and no gufo quadlet for ${engine_user:-the sudo user})"
    else
        engine_unit=${engine_unit:-gufo}
        engine_unit=${engine_unit%.service}.service
        quadlet=$qdir/${engine_unit%.service}.container
        [[ -f $quadlet ]] || die "engine quadlet $quadlet not found"
        [[ -e $PREFIX/var/lib/systemd/linger/$engine_user ]] ||
            die "linger is off for $engine_user (sudo loginctl enable-linger $engine_user)"
        state_dir=$home/.local/state/portal-hostd
        runuser -u "$engine_user" -- install -d -m 0700 "$state_dir"
        engine_url=$(conf_get ENGINE_URL)   # a re-run keeps the conf's ENGINE_URL and INTERVAL_MS
        role_conf=("ENGINE_UNIT=$engine_unit" "ENGINE_QUADLET=$quadlet" "ENGINE_URL=${engine_url:-http://127.0.0.1:8080}")
        identity="User=$engine_user
Group=$(id -gn "$engine_user")
Environment=XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
ReadWritePaths=$qdir $state_dir"
        protect_home="ProtectHome=read-only"
        after=" user@$uid.service"
        say "engine control: $engine_unit (quadlet $quadlet, user $engine_user)"
    fi
    role_conf+=("FIREWALL_SOURCE=$portal")
fi

before=$(state_hash)
old_ip=$(conf_get FIREWALL_SOURCE)
old_port=$(conf_get PORT)
interval=$(conf_get INTERVAL_MS)

# ---- token, conf, daemon, unit
if [[ $token_stdin == 1 ]]; then
    IFS=$' \t\r' read -r token || [[ -n $token ]] || die "--token-stdin: no token on stdin"   # \r: a line that ends CR LF
    [[ ${#token} -ge 32 && ! $token =~ [[:space:]] ]] || die "--token-stdin: the token must be at least 32 characters without whitespace"
elif [[ -s $TOKEN_FILE ]]; then
    token=$(<"$TOKEN_FILE")
else
    token=$(python3 -I -c 'import secrets; print(secrets.token_hex(32))')
fi
install -d -m 0755 "$CONF_DIR" "$LIB_DIR"
mkdir -p "${UNIT_FILE%/*}"
put 0600 "$TOKEN_FILE" <<<"$token"
printf '%s\n' "# portal-hostd configuration (written by hostd/install.sh; not secret)" \
    "ROLE=$role" "BIND=$bind" "PORT=$port" "INTERVAL_MS=${interval:-500}" "${role_conf[@]}" | put 0644 "$CONF"
install -m 0755 "$SRC_DIR/portal-hostd.py" "$LIB_DIR/portal-hostd.py"
python3 -I -m py_compile "$LIB_DIR/portal-hostd.py" || warn "could not precompile (the service compiles at start instead)"
if [[ -f $SRC_DIR/README.md ]]; then install -m 0644 "$SRC_DIR/README.md" "$LIB_DIR/README.md"; fi
unit=$(<"$SRC_DIR/portal-hostd.service")
unit=${unit//@ROLE@/$role}
unit=${unit//@AFTER@/$after}
unit=${unit//@IDENTITY@/$identity}
unit=${unit//@PROTECT_HOME@/$protect_home}
put 0644 "$UNIT_FILE" <<<"$unit"
if command -v restorecon >/dev/null; then restorecon -R "$LIB_DIR" "$CONF_DIR" "$UNIT_FILE" || true; fi

# ---- firewall: only the llm role is reached from another host
[[ $role == llm && $old_ip == "$portal" && $old_port == "$port" ]] || fw_remove "$old_ip" "$old_port"
[[ $role != llm ]] || fw_add "$portal" "$port"

# ---- start
systemctl daemon-reload
systemctl enable "$UNIT" >/dev/null 2>&1
if [[ $(state_hash) != "$before" ]] || ! systemctl is-active --quiet "$UNIT"; then
    systemctl restart "$UNIT"
    say "portal-hostd (re)started"
else
    say "portal-hostd unchanged and running"
fi
wait_health "$port"
say "health check passed (role $role, port $port)"

if [[ $role == llm ]]; then
    src=$(ip -4 route get "$portal" 2>/dev/null | sed -n 's/.* src \([0-9.]*\).*/\1/p' | head -n 1) || true
    [[ $token_stdin == 0 ]] || token="<the token you passed on stdin>"
    echo
    echo "Put these lines in the portal's .env:"
    echo "HOSTD_LLM_URL=http://${src:-<this host IPv4>}:$port"
    echo "HOSTD_LLM_TOKEN=$token"
fi
