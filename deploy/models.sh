#!/usr/bin/env bash
# The portal's models, which every agent offers, in the format of Qwen Code's settings, and the AI server's image and
# media models.
#   sudo bash deploy/models.sh install <file>...   checks and installs system-defaults.json (the models, and Qwen
#                                                  Code's defaults users may change), settings.json (Qwen Code's
#                                                  settings that override the users' own) and/or media.json (the
#                                                  image and media models, by kind and tier: llm-server/media.json)
#   sudo bash deploy/models.sh show | check        prints, or checks, the installed files
# JSON with // and /* */ comments. Workspaces read the files when they start; the gateway reads media.json when it
# starts, so installing it restarts the gateway, and the file before it comes back if the gateway does not start.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
require_root
DIR="$(env_get PORTAL_DATA_DIR)/config/models"

# Accepts what the gateway does (harnesses/models.ts): comments are whitespace, the rest strict JSON.
validate() { # file
  python3 -I - "$1" <<'PY'
import json, os, re, sys
path = sys.argv[1]
# newline="": a lone CR ends no comment for the gateway. The set is what its String.prototype.trim removes.
text = open(path, encoding="utf-8", newline="").read()
blank = re.fullmatch("[\t\n\v\f\r \xa0\u1680\u2000-\u200a\u2028\u2029\u202f\u205f\u3000\ufeff]*", text)
json_text = re.sub(r'"(?:\\.|[^"\\])*"|//[^\n]*|/\*.*?(?:\*/|\Z)', lambda m: m[0] if m[0][0] == '"' else " ", text, flags=re.S)
def reject(constant): raise ValueError(f"{constant} is not valid JSON")
try:
    value = {} if blank else json.loads(json_text, parse_constant=reject)
except ValueError as error:
    sys.exit(f"{path}: not valid JSON: {error}")
if not isinstance(value, dict):
    sys.exit(f"{path}: must contain a JSON object")
models = value.get("modelProviders")
models = models.get("openai") if isinstance(models, dict) else None
models = [m for m in models if isinstance(m, dict) and isinstance(m.get("id"), str) and m["id"].strip()] if isinstance(models, list) else []
if os.path.basename(path) == "system-defaults.json" and not models:
    sys.exit(f'{path}: must define at least one model under modelProviders.openai (an entry with an "id")')
# The gateway checks the rest of media.json (harnesses/media.ts): this is what an edit gets wrong most.
if os.path.basename(path) == "media.json":
    kinds = ("image", "imageEdit", "video", "music", "speech", "transcription")
    for kind, tiers in value.items():
        if kind in ("$schema", "$version"): continue
        if kind not in kinds: sys.exit(f'{path}: "{kind}" is no kind of media (use {", ".join(kinds)})')
        if not isinstance(tiers, dict) or not tiers or set(tiers) - {"fast", "quality"}:
            sys.exit(f'{path}: {kind} must be an object with "fast" and/or "quality"')
        for tier, entry in tiers.items():
            if not isinstance(entry, dict) or not isinstance(entry.get("model"), str) or not entry["model"]:
                sys.exit(f'{path}: {kind}.{tier} needs a "model": the id the AI server serves it under')
PY
}

# The gateway reads media.json when it starts: restart it, and put back the file before if it does not come up.
restart_gateway() { # previous copy of media.json, or ""
  cd "$ROOT"
  if docker compose up -d --force-recreate --wait gateway >/dev/null 2>&1; then
    log "the gateway restarted with the new media.json"
    return
  fi
  warn "the gateway did not start with the new media.json: $(docker compose logs --tail 20 gateway 2>&1 | grep -m1 -i 'media registry' || echo 'see: docker compose logs gateway')"
  if [[ -n $1 ]]; then install -m 0600 -o root -g root "$1" "$DIR/media.json"; else rm -f "$DIR/media.json"; fi
  docker compose up -d --force-recreate --wait gateway >/dev/null 2>&1 || true
  die "put the media.json before it back; fix the file and install it again"
}

case ${1:-} in
  install)
    [[ $# -ge 2 ]] || die "usage: $0 install <settings.json|system-defaults.json|media.json>..."
    for file in "${@:2}"; do
      [[ ${file##*/} == @(settings.json|system-defaults.json|media.json) ]] || die "$file: name it settings.json, system-defaults.json or media.json"
      validate "$file"
      [[ ${file##*/} != media.json ]] || no_console_update "then run this again"
    done
    install -d -m 0700 -o root -g root "$DIR"
    previous=""
    media=false
    for file in "${@:2}"; do
      if [[ ${file##*/} == media.json ]]; then
        media=true
        if [[ -f $DIR/media.json ]]; then
          previous=$(mktemp)
          trap 'rm -f "$previous"' EXIT
          cp "$DIR/media.json" "$previous"
        fi
      fi
      install -m 0600 -o root -g root "$file" "$DIR/${file##*/}"
      log "installed $DIR/${file##*/}"
    done
    restorecon -R "$DIR" 2>/dev/null || true
    if $media; then
      restart_gateway "$previous"
    fi
    echo "Workspaces use the new settings from their next start: stop running ones in the admin console to apply them now."
    ;;
  show)
    for name in settings.json system-defaults.json media.json; do
      echo "== $DIR/$name"
      cat "$DIR/$name" 2>/dev/null || echo "(not installed)"
    done
    ;;
  check)
    status=0
    for name in settings.json system-defaults.json media.json; do
      if [[ -f $DIR/$name ]]; then
        if validate "$DIR/$name"; then echo "ok  $DIR/$name"; else status=1; fi
      elif [[ $name == settings.json ]]; then
        echo "--  $DIR/$name (not installed; optional)"
      elif [[ $name == media.json ]]; then
        echo "--  $DIR/$name (not installed: no image or media models)"
      else
        echo "xx  $DIR/$name is missing: workspaces cannot start without models"
        status=1
      fi
    done
    exit "$status"
    ;;
  *) die "usage: $0 install <file>... | show | check" ;;
esac
