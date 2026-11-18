#!/usr/bin/env bash
# Builds an agent's workspace image and makes that version the one new workspaces start with, as Admin > Updates
# does, then runs deploy/verify-isolation.sh, which the console can't. Works with the portal down.
#   sudo bash deploy/update-image.sh qwen 0.28.0      Qwen Code to that version, newer or older (dsh: DeepSeek Harness)
#   sudo bash deploy/update-image.sh qwen --refresh   rebuild its version in use from scratch (new Debian packages)
#   sudo bash deploy/update-image.sh --refresh        the same for every enabled agent
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
usage="usage: $0 <agent> <version> | [<agent>] --refresh   (agents: ${AGENTS[*]})"
no_console_update
load_enabled_agents

agent="" version="" refresh=()
for arg in "$@"; do
  case $arg in
    --refresh) refresh=(--no-cache) ;;
    -*) die "$usage" ;;
    *) if [[ -z $agent ]]; then agent=$arg; elif [[ -z $version ]]; then version=$arg; else die "$usage"; fi ;;
  esac
done
[[ -n $version || ${#refresh[@]} -gt 0 ]] || die "$usage"
targets=("${ENABLED_AGENTS[@]}")
if [[ -n $agent ]]; then known_agent "$agent"; targets=("$agent"); fi

rollback=""
for target in "${targets[@]}"; do
  previous=$(agent_version "$target")
  wanted=${version:-$previous}
  valid_version "$wanted" || die "\"$wanted\" is not a version such as 0.28.0"
  if [[ ${#refresh[@]} -eq 0 ]] && docker image inspect "$(workspace_image "$target" "$wanted")" >/dev/null 2>&1; then
    log "$(workspace_image "$target" "$wanted") exists (--refresh rebuilds it)"
    check_workspace_image "$target" "$wanted"
  else
    build_workspace_image "$target" "$wanted" "${refresh[@]}"
  fi
  # The console saves a version when its own build ends: not while one runs.
  no_console_update "then run this again"
  agent_version_set "$target" "$wanted"
  rollback+=$'\n'"    sudo bash $0 $target $previous"
  [[ " ${ENABLED_AGENTS[*]} " == *" $target "* ]] || warn "${AGENT_NAME[$target]} is not in WORKSPACE_AGENTS, so users can't choose it"
done

# The gateway reads the versions in use when it starts. The workspaces keep running; a console update would not.
no_console_update "the version is saved: when that update is over, run: docker compose up -d --force-recreate gateway"
log "restarting the gateway"
docker compose up -d --force-recreate gateway
bash deploy/verify-isolation.sh || die "the isolation check failed with the new image; roll back with:$rollback"

for target in "${targets[@]}"; do
  echo "New ${AGENT_NAME[$target]} workspaces start with version $(agent_version "$target")."
done
echo "Running ones keep their image until they stop: stop them in the admin console to move everyone now. Roll back with:$rollback"
