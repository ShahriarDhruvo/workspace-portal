#!/usr/bin/env bash
# Installs the Qwen Code settings every workspace starts with, after checking them. DeepSeek Harness
# workspaces take their models from the same files.
#
#   sudo bash deploy/qwen-config.sh install <file> [<file>]   settings.json and/or system-defaults.json
#   sudo bash deploy/qwen-config.sh show                      print the installed files
#   sudo bash deploy/qwen-config.sh check                     validate the installed files
#
# Files are recognised by name:
#   settings.json         system scope: overrides what users set
#   system-defaults.json  defaults users may change; must define the models (modelProviders.openai)
# JSON with // and /* */ comments is accepted. Workspaces read the files at their next start.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root

DIR="$(env_get PORTAL_DATA_DIR)/config/qwen"

# The same rules as the gateway (gateway/src/agents/qwen-settings.ts): comments become whitespace, then
# strict JSON. Also warns about models DeepSeek Harness can't offer (gateway/src/agents/dsh-settings.ts).
validate() { # file
  python3 - "$1" <<'PY'
import json, sys
path = sys.argv[1]
name = path.rsplit("/", 1)[-1]
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
def reject(constant): raise ValueError(f"{constant} is not valid JSON")
try:
    source = "".join(out)
    value = json.loads(source, parse_constant=reject) if source.strip() else {}
except ValueError as e:
    sys.exit(f"{path}: not valid JSON: {e}")
if not isinstance(value, dict):
    sys.exit(f"{path}: must contain a JSON object")
providers = (value.get("modelProviders") or {}).get("openai") if isinstance(value.get("modelProviders"), dict) else None
models = [p for p in providers if isinstance(p, dict) and isinstance(p.get("id"), str) and p["id"].strip()] if isinstance(providers, list) else []
if name == "system-defaults.json" and not models:
    sys.exit(f"{path}: must define at least one model under modelProviders.openai (an entry with an \"id\")")
# DeepSeek Harness needs context window - output limit >= 78020 and lowers the output limit to fit,
# keeping at least 4096 tokens: a window under 82116 tokens leaves the model out of DeepSeek Harness.
def number(entry, *keys, default):
    for key in keys:
        entry = entry.get(key) if isinstance(entry, dict) else None
    return entry if isinstance(entry, (int, float)) and not isinstance(entry, bool) and entry > 0 else default
small = [m["id"].strip() for m in models if number(m, "generationConfig", "contextWindowSize", default=131072) < 82116]
if small:
    sys.stderr.write(f"warning: {path}: DeepSeek Harness leaves out {', '.join(small)} (context window under 82116 tokens)\n")
    if len(small) == len(models):
        sys.stderr.write("warning: with only these models, DeepSeek Harness workspaces won't start\n")
PY
}

case "${1:-}" in
  install)
    shift
    [[ $# -ge 1 ]] || die "usage: $0 install <settings.json|system-defaults.json> [...]"
    for file in "$@"; do
      name=$(basename "$file")
      [[ $name == settings.json || $name == system-defaults.json ]] || die "$file: name it settings.json or system-defaults.json"
      validate "$file"
    done
    install -d -m 0700 -o root -g root "$DIR"
    for file in "$@"; do
      install -m 0600 -o root -g root "$file" "$DIR/$(basename "$file")"
      log "installed $DIR/$(basename "$file")"
    done
    if command -v restorecon >/dev/null; then restorecon -R "$DIR" 2>/dev/null || true; fi
    echo "Workspaces use the new settings from their next start. To apply them now, stop running"
    echo "workspaces in the admin console; they start again when their user opens them."
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
      if [[ ! -f "$DIR/$name" ]]; then
        if [[ $name == system-defaults.json ]]; then echo "xx  $DIR/$name is missing: workspaces cannot start without models"; status=1
        else echo "--  $DIR/$name (not installed; optional)"; fi
      elif validate "$DIR/$name"; then
        echo "ok  $DIR/$name"
      else
        status=1
      fi
    done
    exit "$status"
    ;;
  *) die "usage: $0 install <file>... | show | check" ;;
esac
