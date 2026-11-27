#!/bin/bash
# portal-hostd installer, both roles. Idempotent; run as root. See hostd/README.md.
#   sudo bash hostd/install.sh portal [--token-stdin] [--port 9180]
#   sudo bash hostd/install.sh llm --portal <portal server IPv4> [--engine-unit gufo.service|none]
#                                  [--engine-user USER] [--engine-url URL] [--engine-router URL MODEL|none]
#                                  [--apps on|none] [--token-stdin] [--port 9180]
#   sudo bash hostd/install.sh uninstall
# --token-stdin reads the token as one line from stdin (an argument would show in /proc/*/cmdline).
# Without it an existing /etc/portal-hostd/token is kept, else a new one is generated.
# --engine-router: llama-swap's address and the engine's model there; a re-run without it keeps the conf's.
# --apps: updates of the other software in llm-server/apps.json (on by default with engine control); a re-run
# without it keeps the conf's choice.
set -euo pipefail

SRC_DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
PREFIX=${HOSTD_TEST_PREFIX:-}   # set by test_hostd.py only
LIB_DIR=$PREFIX/usr/local/lib/portal-hostd
APPS_FILE=/usr/local/lib/portal-hostd/apps/apps.json   # as the daemon sees it; apps.json and each app's <id>/
APPS_SRC=$SRC_DIR/../llm-server
CONF_DIR=$PREFIX/etc/portal-hostd
CONF=$CONF_DIR/hostd.conf
TOKEN_FILE=$CONF_DIR/token
UNIT_FILE=$PREFIX/etc/systemd/system/portal-hostd.service
UNIT="portal-hostd.service"

usage() { sed -n '3,12s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; exit 2; }
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

route_field() { ip -4 route get "$1" 2>/dev/null | sed -n "s/.* $2 \([^ ]*\).*/\1/p" | head -n 1 || true; }  # route_field IP dev|src
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
    dev=$(route_field "$ip" dev)
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
    # The apps' install scripts run anew each time; apps.json is read at start.
    { cat "$LIB_DIR/portal-hostd.py" "$UNIT_FILE" "$CONF" "$TOKEN_FILE" "$LIB_DIR/apps/apps.json" 2>/dev/null || true; } |
        sha256sum | cut -d' ' -f1
}

wait_health() {  # wait_health PORT: 20 tries of GET /v1/health, half a second apart
    local port=$1
    for _ in $(seq 1 20); do
        if python3 -I -c "import sys,urllib.request as u; r=u.build_opener(u.ProxyHandler({})).open('http://127.0.0.1:$port/v1/health', timeout=2); sys.exit(0 if r.status == 200 else 1)" 2>/dev/null; then
            return 0
        fi
        sleep 0.5
    done
    systemctl --no-pager status "$UNIT" >&2 || true
    journalctl --no-pager -u "$UNIT" -n 30 >&2 || true
    die "portal-hostd did not answer http://127.0.0.1:$port/v1/health in 20 tries"
}

uninstall() {
    local ip port
    ip=$(conf_get FIREWALL_SOURCE)
    port=$(conf_get PORT)
    systemctl disable --now "$UNIT" >/dev/null 2>&1 || true
    rm -f "$UNIT_FILE"
    systemctl daemon-reload
    systemctl reset-failed "$UNIT" >/dev/null 2>&1 || true
    fw_remove "$ip" "$port"
    rm -rf "$CONF_DIR" "$LIB_DIR"
    say "removed portal-hostd (unit, $CONF_DIR, $LIB_DIR$( [[ -n $ip ]] && echo ', firewalld rule' ))."
    say "an engine user's ~/.local/state/portal-hostd (saved previous quadlet) is kept; delete it by hand if unwanted."
    say "the other software's installed versions (llm-server/apps.json's roots) are kept."
}

[[ $EUID -eq 0 ]] || die "run as root (sudo bash hostd/install.sh ...)"
role=${1:-}
case $role in
    portal | llm) shift ;;
    uninstall) uninstall; exit 0 ;;
    '' | -h | --help) usage ;;
    *) die "unknown role '$role' (portal, llm or uninstall)" ;;
esac

token_stdin=0 port=9180 portal="" engine_unit="" engine_user="${SUDO_USER:-}" engine_url="" router_url="" router_model="" apps=""
while [[ $# -gt 0 ]]; do
    case $1 in
        --token-stdin) token_stdin=1; shift ;;
        --port) port=${2:?--port needs a value}; shift 2 ;;
        --portal) portal=${2:?--portal needs a value}; shift 2 ;;
        --engine-unit) engine_unit=${2:?--engine-unit needs a value}; shift 2 ;;
        --engine-user) engine_user=${2:?--engine-user needs a value}; shift 2 ;;
        --engine-url) engine_url=${2:?--engine-url needs a value}; shift 2 ;;
        --engine-router)
            router_url=${2:?--engine-router needs URL MODEL, or none}
            if [[ $router_url == none ]]; then router_model=none; shift 2
            else router_model=${3:?--engine-router needs URL MODEL}; shift 3; fi ;;
        --apps)
            apps=${2:?--apps needs on or none}
            [[ $apps == on || $apps == none ]] || die "--apps needs on or none"
            shift 2 ;;
        -h | --help) usage ;;
        *) die "unknown option $1" ;;
    esac
done
[[ $port =~ ^[0-9]+$ && $port -ge 1 && $port -le 65535 ]] || die "--port must be 1..65535"
[[ -f $SRC_DIR/portal-hostd.py && -f $SRC_DIR/portal-hostd.service ]] || die "run this from the repo (hostd/ files missing)"
command -v python3 >/dev/null || die "python3 is required"

bind=127.0.0.1 identity="DynamicUser=yes" protect_home="ProtectHome=yes" after="" role_conf=() apps_on=0
if [[ $role == llm ]]; then
    bind=0.0.0.0
    [[ $portal =~ ^([0-9]{1,3}\.){3}[0-9]{1,3}$ ]] || die "llm role needs --portal <portal server IPv4>"
    if [[ $engine_unit != none ]]; then
        [[ -n $engine_user && $engine_user != root ]] || die "pass --engine-user (the user that owns the engine quadlet)"
        IFS=: read -r _ _ uid gid _ home _ < <(getent passwd "$engine_user") || die "no such user $engine_user"
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
        # A re-run keeps the conf's ENGINE_URL, router and INTERVAL_MS unless options say otherwise.
        engine_url=${engine_url:-$(conf_get ENGINE_URL)}
        if [[ -z $router_url ]]; then router_url=$(conf_get ENGINE_ROUTER_URL) router_model=$(conf_get ENGINE_ROUTER_MODEL); fi
        role_conf=("ENGINE_UNIT=$engine_unit" "ENGINE_QUADLET=$quadlet" "ENGINE_URL=${engine_url:-http://127.0.0.1:8080}")
        if [[ -n $router_url && $router_url != none ]]; then
            [[ $router_url =~ ^https?://[^[:space:]]+$ && $router_model =~ ^[^[:space:]/]+$ ]] ||
                die "--engine-router needs an http(s) URL and a model id"
            role_conf+=("ENGINE_ROUTER_URL=$router_url" "ENGINE_ROUTER_MODEL=$router_model")
            behind=", behind llama-swap at $router_url"
        fi
        # Without --apps a re-run keeps the conf's choice: an empty APPS_FILE= line is "none".
        if [[ -z $apps ]]; then
            if [[ -f $CONF ]] && grep -qx 'APPS_FILE=' "$CONF"; then apps=none; else apps=on; fi
        fi
        writable="$qdir $state_dir"
        if [[ $apps == on ]]; then
            [[ -f $APPS_SRC/apps.json && -d $APPS_SRC/apps ]] || die "llm-server/apps.json or llm-server/apps/ missing (or pass --apps none)"
            # The daemon's own check of apps.json, so a bad one fails here and not at its start. Prints the ids on one
            # line, then each dir app's root. -B: no root-owned __pycache__ in the checkout.
            listing=$(python3 -I -B -c '
import importlib.util, sys
spec = importlib.util.spec_from_file_location("hostd", sys.argv[1]); hostd = importlib.util.module_from_spec(spec)
spec.loader.exec_module(hostd)
apps = hostd.load_apps(*sys.argv[2:])
print(" ".join(apps))
for app in apps.values():
    if app["kind"] == "dir": print(app["root"])
' "$SRC_DIR/portal-hostd.py" "$APPS_SRC/apps.json" "$home" "$qdir") || die "llm-server/apps.json: see above"
            { read -r app_ids; mapfile -t roots; } <<<"$listing"
            for root in "${roots[@]}"; do
                [[ $root != *[[:space:]]* ]] || die "llm-server/apps.json: the root '$root' has a space"
                if [[ -d $root ]]; then
                    [[ $(stat -c %u "$root") == "$uid" ]] || warn "$root is not owned by $engine_user: its updates will fail"
                elif [[ $root == "$home"/* ]]; then
                    runuser -u "$engine_user" -- mkdir -p "$root"
                else
                    mkdir -p "${root%/*}"
                    install -d -o "$uid" -g "$gid" -m 0755 "$root"
                fi
                writable+=" -$root"   # "-": a root deleted by hand does not keep the daemon from starting
            done
            role_conf+=("APPS_FILE=$APPS_FILE")
            apps_on=1
            say "updates of other software: $app_ids"
        else
            say "no updates of other software (--apps none)"
            role_conf+=("APPS_FILE=")
        fi
        identity="User=$engine_user
Group=$(id -gn "$engine_user")
Environment=XDG_RUNTIME_DIR=/run/user/$uid DBUS_SESSION_BUS_ADDRESS=unix:path=/run/user/$uid/bus
ReadWritePaths=$writable"
        protect_home="ProtectHome=read-only"
        after=" user@$uid.service"
        say "engine control: $engine_unit (quadlet $quadlet, user $engine_user${behind:-})"
    fi
    role_conf+=("FIREWALL_SOURCE=$portal")
fi

before=$(state_hash)
old_ip=$(conf_get FIREWALL_SOURCE)
old_port=$(conf_get PORT)
interval=$(conf_get INTERVAL_MS)

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
install -m 0644 "$SRC_DIR/README.md" "$LIB_DIR/README.md"
rm -rf "$LIB_DIR/apps.new"
if [[ $apps_on == 1 ]]; then
    # apps.json beside each app's directory (install.sh and the files it copies), as the daemon expects them.
    (umask 022 && mkdir "$LIB_DIR/apps.new" && cp "$APPS_SRC/apps.json" "$LIB_DIR/apps.new/" &&
        cp -R "$APPS_SRC/apps/." "$LIB_DIR/apps.new/")
    rm -rf "$LIB_DIR/apps"
    mv "$LIB_DIR/apps.new" "$LIB_DIR/apps"
else
    rm -rf "$LIB_DIR/apps"
fi
unit=$(<"$SRC_DIR/portal-hostd.service")
unit=${unit//@ROLE@/$role}
unit=${unit//@AFTER@/$after}
unit=${unit//@IDENTITY@/$identity}
unit=${unit//@PROTECT_HOME@/$protect_home}
put 0644 "$UNIT_FILE" <<<"$unit"
if command -v restorecon >/dev/null; then restorecon -R "$LIB_DIR" "$CONF_DIR" "$UNIT_FILE" || true; fi

# Only the llm role is reached from another host.
[[ $role == llm && $old_ip == "$portal" && $old_port == "$port" ]] || fw_remove "$old_ip" "$old_port"
[[ $role != llm ]] || fw_add "$portal" "$port"

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
    src=$(route_field "$portal" src)
    [[ $token_stdin == 0 ]] || token="<the token you passed on stdin>"
    echo
    echo "Put these lines in the portal's .env:"
    echo "HOSTD_LLM_URL=http://${src:-<this host IPv4>}:$port"
    echo "HOSTD_LLM_TOKEN=$token"
fi
