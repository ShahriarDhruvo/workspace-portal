#!/bin/bash
# The AI server's installer: puts this checkout's files for llama-swap and the models in place, and restarts
# llama-swap when one of them changed. Idempotent; run as root after each `git pull`. See llm-server/README.md.
#   sudo bash llm-server/install.sh [--user USER]
# USER runs llama-swap and the models (default: the sudo user). What it writes:
#   ~USER/.local/bin/wait-gpu-memory
#   ~USER/.config/llama-swap/config.yaml     llama-swap.yaml
#   ~USER/.config/systemd/user/              llama-swap.service, media/*.service
#   ~USER/.config/containers/systemd/        gufo*.container, vllm-sov.container
#   /etc/ai-studio/cache.env, /etc/profile.d/ai-studio-cache.sh
#   ROOT/current/                            apps/ID/*.py, for each program of apps.json that is installed
# A quadlet keeps the Image= line of the installed one: Admin > Updates sets it. Then portal-hostd's installer
# runs with the settings it has, where it is installed, so Admin > Updates works from this checkout's apps.json.
# It installs no program and no model, and nothing of the fans, power and watchdog (docs/GUIDE.md).
set -euo pipefail

SRC=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
HOSTD_CONF=/etc/portal-hostd/hostd.conf
READY_SECONDS=300

usage() { sed -n '4,14s/^# \{0,1\}//p' "${BASH_SOURCE[0]}"; exit 2; }
die() { echo "install.sh: $*" >&2; exit 1; }
say() { echo "install.sh: $*"; }

[[ $EUID -eq 0 ]] || die "run as root (sudo bash llm-server/install.sh)"
user=${SUDO_USER:-}
while [[ $# -gt 0 ]]; do
    case $1 in
        --user) user=${2:?--user needs a value}; shift 2 ;;
        -h | --help) usage ;;
        *) die "unknown option $1" ;;
    esac
done
[[ -n $user && $user != root ]] || die "pass --user (the user that runs llama-swap and the models)"
IFS=: read -r _ _ uid gid _ home _ < <(getent passwd "$user") || die "no such user $user"
[[ -S /run/user/$uid/bus ]] || die "$user has no systemd user manager (sudo loginctl enable-linger $user)"
[[ -x $home/.local/lib/llama-swap/current/llama-swap ]] ||
    die "llama-swap is not installed for $user: see docs/GUIDE.md, \"Start the models\""

as_user() { runuser -u "$user" -- env XDG_RUNTIME_DIR="/run/user/$uid" "$@"; }

changed=0
put() {  # put MODE OWNER:GROUP SOURCE DEST: SOURCE becomes DEST, unless it already is
    if cmp -s "$3" "$4"; then return 0; fi
    install -m "$1" -o "${2%:*}" -g "${2#*:}" "$3" "$4"
    say "wrote $4"
    changed=1
}

units=$home/.config/systemd/user
quadlets=$home/.config/containers/systemd
as_user mkdir -p "$home/.local/bin" "$home/.config/llama-swap" "$units" "$quadlets"
install -d -m 755 /etc/ai-studio

put 755 "$uid:$gid" "$SRC/wait-gpu-memory" "$home/.local/bin/wait-gpu-memory"
put 644 "$uid:$gid" "$SRC/llama-swap.yaml" "$home/.config/llama-swap/config.yaml"
for unit in "$SRC/llama-swap.service" "$SRC"/media/*.service; do
    put 644 "$uid:$gid" "$unit" "$units/${unit##*/}"
done
put 644 root:root "$SRC/media/cache.env" /etc/ai-studio/cache.env
put 644 root:root "$SRC/media/ai-studio-cache.sh" /etc/profile.d/ai-studio-cache.sh

merged=$(mktemp)
trap 'rm -f "$merged"' EXIT
for quadlet in "$SRC"/gufo*.container "$SRC/vllm-sov.container"; do
    dest=$quadlets/${quadlet##*/}
    image=""
    if [[ -f $dest ]]; then image=$(sed -n '0,/^Image=/s/^Image=//p' "$dest"); fi
    if [[ -n $image ]]; then
        IMAGE=$image awk '/^Image=/ { print "Image=" ENVIRON["IMAGE"]; next } { print }' "$quadlet" >"$merged"
    else
        cat "$quadlet" >"$merged"
    fi
    put 644 "$uid:$gid" "$merged" "$dest"
done

# Each program's install.sh copied its adapter into the version it built: the one in use gets this checkout's.
while IFS=$'\t' read -r id root; do
    [[ -d $root/current ]] || continue
    for adapter in "$SRC/apps/$id"/*.py; do
        [[ -f $adapter && ${adapter##*/} != test_* ]] || continue
        put 644 "$uid:$gid" "$adapter" "$root/current/${adapter##*/}"
    done
done < <(python3 -I -c '
import json, sys
for app_id, app in json.load(open(sys.argv[1])).items():
    if app["kind"] == "dir":
        root = app["root"]
        print(app_id, sys.argv[2] + root[1:] if root.startswith("~/") else root, sep="\t")
' "$SRC/apps.json" "$home")

as_user systemctl --user daemon-reload
as_user systemctl --user enable --quiet llama-swap.service
if [[ $changed == 1 ]] || ! as_user systemctl --user is-active --quiet llama-swap.service; then
    as_user systemctl --user restart llama-swap.service
    say "llama-swap restarted; waiting for the LLM"
    ready=0
    for _ in $(seq $((READY_SECONDS / 2))); do
        running=$(curl -s --max-time 2 http://127.0.0.1:8080/running || true)
        if [[ $running == *'"state":"ready"'* ]]; then ready=1; break; fi
        sleep 2
    done
    if [[ $ready == 0 ]]; then
        as_user journalctl --user --no-pager -u llama-swap.service -n 30 >&2 || true
        die "llama-swap had no model ready after $READY_SECONDS s"
    fi
    say "the LLM is ready"
else
    say "nothing changed: llama-swap keeps running"
fi

if [[ -f $HOSTD_CONF ]] && grep -qx 'ROLE=llm' "$HOSTD_CONF"; then
    conf() { sed -n "s/^$1=//p" "$HOSTD_CONF" | tail -n 1; }
    engine_unit=$(conf ENGINE_UNIT)
    # The token goes in on stdin, so hostd's installer keeps it and does not print it.
    bash "$SRC/../hostd/install.sh" llm --portal "$(conf FIREWALL_SOURCE)" --port "$(conf PORT)" \
        --engine-user "$user" --engine-unit "${engine_unit:-none}" --token-stdin </etc/portal-hostd/token
else
    say "portal-hostd is not installed here: the live view and Admin > Updates need it (hostd/README.md)"
fi
