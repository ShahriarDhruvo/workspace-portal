#!/usr/bin/env bash
# Removes Workspace Portal from this host: the stack, every workspace container (both kinds), the two
# workspace networks, the firewall unit, its rules and Docker's requirement of it, portal-hostd, the images and
# the SELinux label rule.
# User data (PORTAL_DATA_DIR) is kept unless --purge-data is given.
#
#   sudo bash deploy/uninstall.sh                 keep the data directory
#   sudo bash deploy/uninstall.sh --purge-data    also delete every account and workspace file
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
require_root

purge=false
case "${1:-}" in
  "") ;;
  --purge-data) purge=true ;;
  *) die "usage: $0 [--purge-data]" ;;
esac
DATA_DIR=$(env_get PORTAL_DATA_DIR)

log "stopping the stack"
docker compose down --remove-orphans 2>/dev/null || true
log "removing workspace containers and the workspace networks"
docker ps -aq --filter label=workspace-portal.workspace=1 | xargs -r docker rm -f >/dev/null
# A version check the gateway ran on a new agent image, if the gateway died during it.
docker ps -aq --filter label=workspace-portal.verify | xargs -r docker rm -f >/dev/null
docker network rm "$(env_get WORKSPACE_NETWORK)" >/dev/null 2>&1 || true
docker network rm "$(env_get ONLINE_NETWORK)" >/dev/null 2>&1 || true

log "removing the firewall"
# Docker's requirement first: with it in place, stopping the firewall unit would stop Docker too, and Docker
# could not start again without the unit.
rm -f /etc/systemd/system/docker.service.d/workspace-portal-firewall.conf
rmdir /etc/systemd/system/docker.service.d 2>/dev/null || true
systemctl daemon-reload
systemctl disable --now workspace-portal-firewall.service >/dev/null 2>&1 || true
/usr/local/libexec/workspace-portal/firewall.sh remove >/dev/null 2>&1 || bash deploy/firewall.sh remove >/dev/null
rm -f /etc/systemd/system/workspace-portal-firewall.service
systemctl daemon-reload
rm -rf /usr/local/libexec/workspace-portal /etc/workspace-portal

if systemctl is-active --quiet firewalld; then
  while IFS= read -r rule; do
    [[ -n $rule ]] || continue
    firewall-cmd --permanent --remove-rich-rule="$rule" >/dev/null 2>&1 && log "firewalld: removed ${rule}"
  done < <(portal_rich_rules)
  firewall-cmd --reload >/dev/null
elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  for source in $(portal_sources); do
    ufw delete allow from "$source" to any port "$(web_port)" proto tcp >/dev/null 2>&1 || true
    for range in "$(agent_port_range)" "$(online_agent_port_range)"; do
      ufw delete allow from "$source" to any port "${range/-/:}" proto tcp >/dev/null 2>&1 || true
    done
  done
fi

log "removing portal-hostd (the live server readings)"
bash hostd/install.sh uninstall >/dev/null 2>&1 || warn "could not remove portal-hostd; see: sudo bash hostd/install.sh uninstall"

log "removing images"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^workspace-portal/' | xargs -r docker image rm >/dev/null 2>&1 || true
# Old agent builds a rebuild left without a tag (workspace-image/Dockerfile labels them).
docker image ls -q --filter dangling=true --filter label=workspace-portal.agent | xargs -r docker image rm >/dev/null 2>&1 || true

if command -v semanage >/dev/null; then semanage fcontext -d "${DATA_DIR}(/.*)?" 2>/dev/null || true; fi

if $purge; then
  log "deleting ${DATA_DIR}"
  rm -rf --one-file-system "$DATA_DIR"
  echo "Workspace Portal is removed, including all data."
else
  echo "Workspace Portal is removed. The data is still in ${DATA_DIR} (delete it with --purge-data)."
fi
