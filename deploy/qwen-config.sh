#!/usr/bin/env bash
# The Qwen Code settings every workspace starts with; DeepSeek Harness takes its models from them too.
#   sudo bash deploy/qwen-config.sh install <file>...   checks and installs settings.json (overrides the users'
#                                                       own settings) and/or system-defaults.json (the models, and
#                                                       defaults users may change)
#   sudo bash deploy/qwen-config.sh show | check        prints, or checks, the installed files
# JSON with // and /* */ comments. Workspaces read the files when they start.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
DIR="$(env_get PORTAL_DATA_DIR)/config/qwen"

# Accepts what the gateway does (gateway/src/agents/qwen-settings.ts): comments are whitespace, the rest strict JSON.
validate() { # file
  python3 -I - "$1" <<'PY'
import json, os, re, sys
path = sys.argv[1]
text = open(path, encoding="utf-8").read()
json_text = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?(?:\*/|\Z)', lambda m: m[0] if m[0][0] == '"' else " ", text, flags=re.S)
def reject(constant): raise ValueError(f"{constant} is not valid JSON")
try:
    value = json.loads(json_text, parse_constant=reject) if text.strip() else {}
except ValueError as error:
    sys.exit(f"{path}: not valid JSON: {error}")
if not isinstance(value, dict):
    sys.exit(f"{path}: must contain a JSON object")
models = value.get("modelProviders")
models = models.get("openai") if isinstance(models, dict) else None
models = [m for m in models if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"].strip()] if isinstance(models, list) else []
if os.path.basename(path) == "system-defaults.json" and not models:
    sys.exit(f'{path}: must define at least one model under modelProviders.openai (an entry with an "id")')
PY
}

case ${1:-} in
  install)
    [[ $# -ge 2 ]] || die "usage: $0 install <settings.json|system-defaults.json>..."
    for file in "${@:2}"; do
      [[ ${file##*/} == @(settings.json|system-defaults.json) ]] || die "$file: name it settings.json or system-defaults.json"
      validate "$file"
    done
    install -d -m 0700 -o root -g root "$DIR"
    for file in "${@:2}"; do
      install -m 0600 -o root -g root "$file" "$DIR/${file##*/}"
      log "installed $DIR/${file##*/}"
    done
    restorecon -R "$DIR" 2>/dev/null || true
    echo "Workspaces use the new settings from their next start: stop running ones in the admin console to apply them now."
    ;;
  show)
    for name in settings.json system-defaults.json; do
      echo "== $DIR/$name"
      cat "$DIR/$name" 2>/dev/null || echo "(not installed)"
    done
    ;;
  check)
    status=0
    for name in settings.json system-defaults.json; do
      if [[ -f $DIR/$name ]]; then
        if validate "$DIR/$name"; then echo "ok  $DIR/$name"; else status=1; fi
      elif [[ $name == settings.json ]]; then
        echo "--  $DIR/$name (not installed; optional)"
      else
        echo "xx  $DIR/$name is missing: workspaces cannot start without models"
        status=1
      fi
    done
    exit "$status"
    ;;
  *) die "usage: $0 install <file>... | show | check" ;;
esac
