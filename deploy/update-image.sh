#!/usr/bin/env bash
# Builds a workspace image for an agent version and switches the portal to it. The admin console
# (Admin > Agents) does the same without a shell, except for the isolation check this script runs at
# the end (deploy/verify-isolation.sh needs root on the host: after a console update, run it yourself).
# This script is for the command line and for when the portal itself is down.
#
#   sudo bash deploy/update-image.sh qwen 0.28.0          Qwen Code: update (or roll back) to that version
#   sudo bash deploy/update-image.sh dsh 0.2.3            DeepSeek Harness: the same
#   sudo bash deploy/update-image.sh qwen --refresh       rebuild the current version from scratch,
#                                                         picking up new Debian packages (Chromium, …)
#   sudo bash deploy/update-image.sh --refresh            rebuild every enabled agent's current version
#
# Images are tagged workspace-portal/workspace:<agent>-<version>. The current version of each agent
# is kept in PORTAL_DATA_DIR/config/agent-versions.env (shared with the admin console; .env's
# QWEN_CODE_VERSION and DSH_VERSION are only the defaults). Running workspaces keep their image until
# they stop; every new start uses the new one. It refuses to run while the admin console runs an update,
# and checks again before it saves a version and before it restarts the gateway (a build takes a while).
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
console_busy="the admin console is updating an agent right now (Admin > Agents): wait for it to finish, or cancel it there"
console_update_running && die "$console_busy"

usage="usage: $0 <agent> [<version>] [--refresh]   or   $0 --refresh   (agents: ${AGENTS[*]})"
load_enabled_agents
agent="" version="" build_args=()
for arg in "$@"; do
  case $arg in
    --refresh) build_args+=(--no-cache) ;;
    -h | --help) echo "$usage"; exit 0 ;;
    -*) die "unknown option $arg ($usage)" ;;
    *)
      if [[ -z $agent ]]; then
        agent_name "$arg" >/dev/null
        agent=$arg
      elif [[ -z $version ]]; then
        version=$arg
      else
        die "$usage"
      fi
      ;;
  esac
done
if [[ -n $agent ]]; then
  targets=("$agent")
elif [[ ${#build_args[@]} -gt 0 ]]; then
  targets=("${ENABLED_AGENTS[@]}")
else
  die "$usage"
fi

declare -A previous=()
for target in "${targets[@]}"; do
  previous[$target]=$(agent_version "$target")
  wanted=${version:-${previous[$target]}}
  valid_version "$wanted" || die "\"$wanted\" is not a $(agent_name "$target") version (like 0.28.0)"
  image=$(workspace_image "$target" "$wanted")

  if [[ ${#build_args[@]} -eq 0 ]] && docker image inspect "$image" >/dev/null 2>&1; then
    log "$image already exists (use --refresh to rebuild it)"
  else
    build_workspace_image "$target" "$wanted" "${build_args[@]}"
  fi
  installed=$(image_agent_version "$target" "$image")
  [[ $installed == "$wanted" ]] || die "$image reports $(agent_name "$target") \"$installed\", expected $wanted"
  log "$image contains $(agent_name "$target") $installed"
  # The console saves its result when its job ends: an update started there meanwhile could make another
  # version of this agent current right after this one. (Both change only their own agent's line.)
  console_update_running && die "$console_busy; then run this again"
  agent_version_set "$target" "$wanted"
done

for target in "${targets[@]}"; do
  [[ " ${ENABLED_AGENTS[*]} " == *" $target "* ]] || warn "$(agent_name "$target") is not in WORKSPACE_AGENTS, so users can't choose it yet"
done

# The gateway reads the current versions at boot. --force-recreate restarts a running gateway and
# creates a missing one; workspaces keep running and the new gateway adopts them. A restart would abandon
# an update the console started meanwhile.
console_update_running && die "$console_busy. The new version is saved and applies once the gateway restarts: when that update is over, run: docker compose up -d --force-recreate gateway"
log "restarting the gateway with the new image"
docker compose up -d --force-recreate gateway

rollback=""
for target in "${targets[@]}"; do rollback+=$'\n'"    sudo bash $0 $target ${previous[$target]}"; done
bash "$ROOT/deploy/verify-isolation.sh" || die "the isolation check failed with the new image; roll back with:$rollback"

cat <<DONE

$(for target in "${targets[@]}"; do printf '  New %s workspaces start with version %s.\n' "$(agent_name "$target")" "$(agent_version "$target")"; done)
  Running ones keep their current image until they stop: stop them in the admin console to
  move everyone now. Roll back with:${rollback}

DONE
