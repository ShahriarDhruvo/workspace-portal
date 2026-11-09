#!/usr/bin/env bash
# Removes Workspace Portal from this host: the stack, every workspace container, the workspace
# network, the firewall unit and rules, the images and the SELinux label rule.
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
# docker-compose.yml needs QWEN_CODE_VERSION even to stop; any value will do here.
QWEN_CODE_VERSION=$(env_get QWEN_CODE_VERSION 0) docker compose down --remove-orphans 2>/dev/null || true
log "removing workspace containers and the workspace network"
docker ps -aq --filter label=workspace-portal.workspace=1 | xargs -r docker rm -f >/dev/null
docker network rm "$(env_get WORKSPACE_NETWORK)" >/dev/null 2>&1 || true

log "removing the firewall"
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
  range=$(agent_port_range)
  for source in $(portal_sources); do
    ufw delete allow from "$source" to any port "$(web_port)" proto tcp >/dev/null 2>&1 || true
    ufw delete allow from "$source" to any port "${range/-/:}" proto tcp >/dev/null 2>&1 || true
  done
fi

log "removing images"
docker image ls --format '{{.Repository}}:{{.Tag}}' | grep '^workspace-portal/' | xargs -r docker image rm >/dev/null 2>&1 || true

if command -v semanage >/dev/null; then semanage fcontext -d "${DATA_DIR}(/.*)?" 2>/dev/null || true; fi

if $purge; then
  log "deleting ${DATA_DIR}"
  rm -rf --one-file-system "$DATA_DIR"
  echo "Workspace Portal is removed, including all data."
else
  echo "Workspace Portal is removed. The data is still in ${DATA_DIR} (delete it with --purge-data)."
fi
