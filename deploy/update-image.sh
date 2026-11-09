#!/usr/bin/env bash
# Builds the workspace image for a Qwen Code version and switches the portal to it.
#
#   sudo bash deploy/update-image.sh 0.28.0            update (or roll back) to that version
#   sudo bash deploy/update-image.sh --refresh          rebuild the current version from scratch,
#                                                       picking up new Debian packages (Chromium, …)
#   sudo bash deploy/update-image.sh 0.28.0 --refresh   both
#
# The image is tagged workspace-portal/workspace:qwen-<version>; QWEN_CODE_VERSION in .env selects
# it. Running workspaces keep their image until they stop; every new start uses the new one.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root

version=""
build_args=()
for arg in "$@"; do
  case $arg in
    --refresh) build_args+=(--no-cache) ;;
    -*) die "unknown option $arg (usage: $0 [<qwen-code-version>] [--refresh])" ;;
    *) version=$arg ;;
  esac
done
current=$(env_get QWEN_CODE_VERSION)
version=${version:-$current}
[[ $version =~ ^[0-9]+\.[0-9]+\.[0-9]+([-.][0-9A-Za-z.]+)?$ ]] || die "\"$version\" is not a Qwen Code version (like 0.28.0)"
image=$(workspace_image "$version")

if [[ ${#build_args[@]} -eq 0 ]] && docker image inspect "$image" >/dev/null 2>&1; then
  log "$image already exists (use --refresh to rebuild it)"
else
  build_workspace_image "$version" "${build_args[@]}"
fi

installed=$(docker run --rm --network none --entrypoint qwen "$image" --version 2>/dev/null | tr -d '[:space:]' || true)
[[ $installed == "$version" ]] || die "$image reports Qwen Code \"$installed\", expected $version"
log "$image contains Qwen Code $installed"

env_set QWEN_CODE_VERSION "$version"
log "switching the gateway to $image"
docker compose up -d gateway

bash "$ROOT/deploy/verify-isolation.sh" || die "the isolation check failed with the new image; roll back with: sudo bash $0 $current"

cat <<DONE

  Workspaces now start with Qwen Code ${version}. Running ones keep their current image until they
  stop: stop them in the admin console to move everyone now.
  Roll back with:  sudo bash deploy/update-image.sh ${current}

DONE
