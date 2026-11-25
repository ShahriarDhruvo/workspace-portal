#!/usr/bin/env bash
# Removes what deploy/install.sh installed, except .env and the data directory:
#   sudo bash deploy/uninstall.sh                 keeps the data directory (accounts, workspace files, settings)
#   sudo bash deploy/uninstall.sh --purge-data    deletes it too
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root
[[ $# -eq 0 || $* == --purge-data ]] || die "usage: $0 [--purge-data]"
DATA_DIR=$(env_get PORTAL_DATA_DIR)

log "removing the containers and their networks"
# Stops the stack in its own time; fails when .env lacks a setting, and then the labels below find it all the same.
docker compose down --remove-orphans 2>/dev/null || true
for label in com.docker.compose.project=workspace-portal workspace-portal.workspace workspace-portal.verify; do
  docker ps -aq --filter "label=$label" | xargs -r docker rm -f >/dev/null
done
for label in com.docker.compose.project=workspace-portal workspace-portal.network; do
  docker network ls -q --filter "label=$label" | xargs -r docker network rm >/dev/null || warn "could not remove every network; see: docker network ls"
done

log "removing the firewall"
# The drop-in first: with it, stopping the unit stops Docker.
rm -f /etc/systemd/system/docker.service.d/workspace-portal-firewall.conf
rmdir /etc/systemd/system/docker.service.d 2>/dev/null || true
systemctl daemon-reload
systemctl disable --now workspace-portal-firewall.service >/dev/null 2>&1 || true
bash container/security/firewall.sh remove
rm -rf /etc/systemd/system/workspace-portal-firewall.service /usr/local/libexec/workspace-portal /etc/workspace-portal
systemctl daemon-reload
if systemctl is-active --quiet firewalld; then firewalld_rules remove; fi

log "removing portal-hostd"
bash hostd/install.sh uninstall >/dev/null 2>&1 || warn "could not remove portal-hostd; see: sudo bash hostd/install.sh uninstall"

log "removing the images"
{
  docker image ls --filter 'reference=workspace-portal/*' --format '{{.Repository}}:{{.Tag}}'
  # Earlier builds, left without a tag by a rebuild.
  for label in com.docker.compose.project=workspace-portal workspace-portal.agent; do
    docker image ls -q --filter dangling=true --filter "label=$label"
  done
} | xargs -r docker image rm >/dev/null || warn "could not remove every image; see: docker image ls"

semanage fcontext -d "$DATA_DIR(/.*)?" 2>/dev/null || true

if [[ $# -eq 1 ]]; then
  log "deleting $DATA_DIR"
  rm -rf --one-file-system "$DATA_DIR"
  echo "Workspace Portal is removed, including all data."
else
  echo "Workspace Portal is removed. The data is still in $DATA_DIR (delete it with --purge-data)."
fi
