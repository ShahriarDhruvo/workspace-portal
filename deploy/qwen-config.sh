#!/usr/bin/env bash
# Installs Qwen Code settings for every workspace, after checking they are valid JSON.
#
#   sudo bash deploy/qwen-config.sh install <file> [<file>]   settings.json and/or system-defaults.json
#   sudo bash deploy/qwen-config.sh show                      print the installed files
#   sudo bash deploy/qwen-config.sh check                     validate the installed files
#
# Files are recognised by name: settings.json (system scope, overrides users) and
# system-defaults.json (defaults users may change). JSON with // and /* */ comments is accepted.
# Workspaces read them at their next start; running workspaces keep their settings until then.
set -euo pipefail

ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)
die() { printf '\033[1;31mxx\033[0m %s\n' "$*" >&2; exit 1; }
log() { printf '\033[1;36m==>\033[0m %s\n' "$*"; }

env_get() { # key default
  local line
  line=$(grep -E "^$1=" "$ROOT/.env" 2>/dev/null | tail -n 1 || true)
  line=${line#*=}
  line=${line%\"}; line=${line#\"}
  printf '%s' "${line:-$2}"
}
DIR="$(env_get PORTAL_DATA_DIR /srv/workspace-portal)/config/qwen"

validate() { # file
  python3 - "$1" <<'PY'
import json, re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
out, i, in_str = [], 0, False
while i < len(text):
    c = text[i]
    if in_str:
        out.append(c)
        if c == "\\": out.append(text[i + 1] if i + 1 < len(text) else ""); i += 1
        elif c == '"': in_str = False
    elif c == '"': in_str = True; out.append(c)
    elif text.startswith("//", i):
        while i < len(text) and text[i] != "\n": i += 1
        out.append("\n")
    elif text.startswith("/*", i):
        end = text.find("*/", i + 2); i = len(text) if end < 0 else end + 1
        out.append(" ")
    else: out.append(c)
    i += 1
try:
    value = json.loads("".join(out)) if "".join(out).strip() else {}
except json.JSONDecodeError as e:
    sys.exit(f"{path}: not valid JSON: {e}")
if not isinstance(value, dict):
    sys.exit(f"{path}: must contain a JSON object")
PY
}

case "${1:-}" in
  install)
    shift
    [[ $# -ge 1 ]] || die "usage: $0 install <settings.json|system-defaults.json> [...]"
    [[ $EUID -eq 0 ]] || die "run as root (sudo)"
    for file in "$@"; do
      name=$(basename "$file")
      [[ "$name" == settings.json || "$name" == system-defaults.json ]] || die "$file: name it settings.json or system-defaults.json"
      validate "$file"
    done
    install -d -m 0755 -o root -g root "$DIR"
    for file in "$@"; do
      install -m 0644 -o root -g root "$file" "$DIR/$(basename "$file")"
      log "installed $DIR/$(basename "$file")"
    done
    if command -v restorecon >/dev/null; then restorecon -R "$DIR" 2>/dev/null || true; fi
    echo "Workspaces use the new settings from their next start. To apply them now, stop running"
    echo "workspaces in the admin console; they start again when their user opens them."
    ;;
  show)
    for name in settings.json system-defaults.json; do
      echo "== $DIR/$name"
      cat "$DIR/$name" 2>/dev/null || echo "(not installed: built-in defaults apply)"
    done
    ;;
  check)
    for name in settings.json system-defaults.json; do
      if [[ -f "$DIR/$name" ]]; then validate "$DIR/$name" && echo "ok  $DIR/$name"; else echo "--  $DIR/$name (not installed)"; fi
    done
    ;;
  *) die "usage: $0 install <file>... | show | check" ;;
esac
