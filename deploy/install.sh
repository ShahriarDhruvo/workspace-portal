#!/usr/bin/env bash
# Workspace Portal installer. Run on the server, as root, from the project directory:
#   sudo bash deploy/install.sh
# Idempotent: re-running rebuilds the images (same versions as in .env) and restarts the stack,
# keeping .env, the Qwen Code settings and all data.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
OWNER=${SUDO_USER:-root}

require_root
command -v docker >/dev/null || die "docker is not installed"
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
command -v nft >/dev/null || die "nftables (the nft command) is not installed: dnf install nftables / apt install nftables"
docker_version_ok || die "Docker $(docker version --format '{{.Server.Version}}' 2>/dev/null || echo '?') is too old: 25.0.5 or newer is required (older engines let containers on internal networks resolve internet names, CVE-2024-29018)"

# The stack restarts itself after a reboot only if dockerd starts at boot; a socket-activated
# Docker (the Fedora default) would wait for the first client instead.
if ! systemctl is-enabled --quiet docker.service 2>/dev/null; then
  log "enabling docker.service at boot"
  systemctl enable docker.service >/dev/null
fi

# ---------------------------------------------------------------- .env
if [[ ! -f $ENV_FILE ]]; then
  log "creating .env from .env.example"
  (umask 077 && cp .env.example "$ENV_FILE")
fi
chmod 600 "$ENV_FILE"
chown "$OWNER": "$ENV_FILE"
set_if_missing() { env_value "$ENV_FILE" "$1" >/dev/null || env_set "$1" "$2"; }
set_if_missing GATEWAY_CONTROL_SECRET "$(openssl rand -hex 32)"
set_if_missing ADMIN_PASSWORD "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"

# Settings from earlier versions: image tags are now derived from the agent versions, users choose
# between the agents in WORKSPACE_AGENTS, and the models are defined in Qwen Code's
# system-defaults.json (for every agent).
if ! env_value "$ENV_FILE" QWEN_CODE_VERSION >/dev/null; then
  old_image=$(env_value "$ENV_FILE" WORKSPACE_IMAGE || true)
  if [[ $old_image == workspace-portal/workspace:qwen-* ]]; then
    env_set QWEN_CODE_VERSION "${old_image##*:qwen-}"
  else
    env_set QWEN_CODE_VERSION "$(env_value .env.example QWEN_CODE_VERSION)"
  fi
fi
set_if_missing DSH_VERSION "$(env_value .env.example DSH_VERSION)"
set_if_missing WORKSPACE_AGENTS "$(env_value .env.example WORKSPACE_AGENTS)"
for key in WORKSPACE_IMAGE LLM_MODEL_ID LLM_MODEL_NAME LLM_CONTEXT_WINDOW LLM_MAX_TOKENS LLM_INPUT LLM_REASONING; do
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=|# no longer used: ${key}=|" "$ENV_FILE"
    log "commented out the setting ${key} in .env (no longer used)"
  fi
done

PORTAL_DATA_DIR=$(env_get PORTAL_DATA_DIR)
load_enabled_agents
for agent in "${ENABLED_AGENTS[@]}"; do
  valid_version "$(agent_version "$agent")" || die "$(agent_version_key "$agent") in .env is not a version (like 0.27.0)"
done
WEB_PORT=$(web_port)
AGENT_PORTS=$(agent_port_range)

# ---------------------------------------------------------------- host checks
# Workspace UIDs must not fall inside a range /etc/subuid or /etc/subgid hands to a host account:
# that account could then read workspace files through a user namespace (podman unshare).
uid_first=$(env_get WORKSPACE_UID_BASE)
uid_last=$((uid_first + $(env_get AGENT_PORT_COUNT)))
for file in /etc/subuid /etc/subgid; do
  [[ -r $file ]] || continue
  while IFS=: read -r name start size; do
    [[ $start =~ ^[0-9]+$ && $size =~ ^[0-9]+$ ]] || continue
    if ((start <= uid_last && start + size - 1 >= uid_first)); then
      die "workspace UIDs ${uid_first}-${uid_last} overlap ${name}'s range in ${file} (${start}-$((start + size - 1))). Set WORKSPACE_UID_BASE in .env to a free range."
    fi
  done <"$file"
done

if command -v selinuxenabled >/dev/null && selinuxenabled &&
  ! docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q 'name=selinux'; then
  warn "SELinux is on, but Docker's SELinux support is off, so containers are not SELinux-confined."
  warn "To turn it on, add \"selinux-enabled\": true to /etc/docker/daemon.json and restart Docker (affects every Docker container)."
fi

# ---------------------------------------------------------------- data dirs
# Ownership is the access model:
#   db/          the web app's service account (10001) only; the gateway reaches it as root.
#   users/<id>/  created by the gateway, owned by that user's own UID (WORKSPACE_UID_BASE + id).
#   config/      root only; the Qwen Code settings an admin installs for every workspace.
log "preparing ${PORTAL_DATA_DIR}"
install -d -m 0755 -o root -g root "${PORTAL_DATA_DIR}"
install -d -m 0700 -o 10001 -g 10001 "${PORTAL_DATA_DIR}/db"
install -d -m 0711 -o root -g root "${PORTAL_DATA_DIR}/users"
install -d -m 0700 -o root -g root "${PORTAL_DATA_DIR}/config" "${PORTAL_DATA_DIR}/config/qwen"
# An older install ran the web app as uid 1000.
if [[ -f "${PORTAL_DATA_DIR}/db/portal.sqlite" ]]; then chown 10001:10001 "${PORTAL_DATA_DIR}"/db/portal.sqlite*; fi
# Starter Qwen Code settings for every workspace (never overwrites an admin's own files).
for file in settings.json system-defaults.json; do
  if [[ ! -f "${PORTAL_DATA_DIR}/config/qwen/${file}" ]]; then
    log "installing the example Qwen Code ${file}"
    install -m 0600 -o root -g root "qwen-config/${file}" "${PORTAL_DATA_DIR}/config/qwen/${file}"
  fi
done

# SELinux (Fedora/RHEL): containers run as container_t and may only touch files labelled
# container_file_t. Label the data dir once (persistently) instead of relabelling on every mount.
if command -v selinuxenabled >/dev/null && selinuxenabled; then
  log "labelling ${PORTAL_DATA_DIR} for containers (SELinux)"
  if command -v semanage >/dev/null; then
    semanage fcontext -a -t container_file_t "${PORTAL_DATA_DIR}(/.*)?" 2>/dev/null ||
      semanage fcontext -m -t container_file_t "${PORTAL_DATA_DIR}(/.*)?"
    restorecon -R "${PORTAL_DATA_DIR}"
  else
    chcon -R -t container_file_t "${PORTAL_DATA_DIR}"
  fi
fi

# ---------------------------------------------------------------- images
# Every enabled agent's image (they share the base stage, so the second one builds quickly).
for agent in "${ENABLED_AGENTS[@]}"; do
  version=$(agent_version "$agent")
  build_workspace_image "$agent" "$version"
  installed=$(image_agent_version "$agent" "$(workspace_image "$agent")")
  [[ $installed == "$version" ]] || die "$(workspace_image "$agent") reports $(agent_name "$agent") \"$installed\", expected $version"
done
log "building web and gateway"
docker compose build --pull

# ---------------------------------------------------------------- firewall
log "installing the workspace firewall (nftables table inet workspace_portal)"
# systemd gets its own copy of the script and settings: under SELinux it may not read /home.
install -d -m 0755 /usr/local/libexec/workspace-portal /etc/workspace-portal
install -m 0755 deploy/firewall.sh /usr/local/libexec/workspace-portal/firewall.sh
{
  echo "# Generated by deploy/install.sh from ${ENV_FILE}"
  for key in WORKSPACE_SUBNET WORKSPACE_GATEWAY_IP WORKSPACE_BRIDGE SERVICE_PORT; do
    echo "${key}=$(env_get "$key")"
  done
} >/etc/workspace-portal/firewall.env
chmod 0644 /etc/workspace-portal/firewall.env
# Before docker.service, so the rules exist before any workspace starts; after nftables.service and
# firewalld, which may load whole rulesets of their own at boot.
cat >/etc/systemd/system/workspace-portal-firewall.service <<'UNIT'
[Unit]
Description=Workspace Portal workspace firewall (nftables)
After=nftables.service firewalld.service
Before=docker.service

[Service]
Type=oneshot
RemainAfterExit=yes
EnvironmentFile=/etc/workspace-portal/firewall.env
ExecStart=/usr/local/libexec/workspace-portal/firewall.sh apply
ExecReload=/usr/local/libexec/workspace-portal/firewall.sh apply
ExecStop=/usr/local/libexec/workspace-portal/firewall.sh remove

[Install]
WantedBy=multi-user.target docker.service
UNIT
systemctl daemon-reload
systemctl enable workspace-portal-firewall.service >/dev/null
# Reload when it is already running: "apply" swaps the rules atomically, while a restart would remove
# them for a moment.
systemctl reload-or-restart workspace-portal-firewall.service

# Let the LAN (and Tailscale, when present) reach the portal and the workspace ports, when a host
# firewall is active. FIREWALL_ALLOW_SOURCE in .env overrides the detected sources.
sources=$(portal_sources)
if systemctl is-active --quiet firewalld; then
  [[ -n ${sources// /} ]] || warn "firewalld is active but no LAN was detected: set FIREWALL_ALLOW_SOURCE in .env and re-run"
  while IFS= read -r rule; do
    [[ -n $rule ]] || continue
    if ! firewall-cmd --permanent --query-rich-rule="$rule" >/dev/null 2>&1; then
      log "firewalld: ${rule}"
      firewall-cmd --permanent --add-rich-rule="$rule" >/dev/null
    fi
  done < <(portal_rich_rules)
  firewall-cmd --reload >/dev/null
elif command -v ufw >/dev/null && ufw status | grep -q "Status: active"; then
  [[ -n ${sources// /} ]] || warn "ufw is active but no LAN was detected: set FIREWALL_ALLOW_SOURCE in .env and re-run"
  for source in $sources; do
    ufw allow from "$source" to any port "${WEB_PORT}" proto tcp >/dev/null
    ufw allow from "$source" to any port "${AGENT_PORTS/-/:}" proto tcp >/dev/null
  done
fi

# ---------------------------------------------------------------- start
log "starting the stack"
docker compose up -d --remove-orphans

log "waiting for the web app"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null || die "web app did not become healthy; see: docker compose logs web gateway"

cat <<DONE

  Workspace Portal is running.

    Portal:     http://$(host_ip || echo '<server-ip>'):${WEB_PORT}
    Workspaces: ports ${AGENT_PORTS} (one per user)
    Admin:      $(env_get ADMIN_USERNAME)   (first sign-in: grep ^ADMIN_PASSWORD ${ENV_FILE}; you choose a new one then)
$(for agent in "${ENABLED_AGENTS[@]}"; do printf '    Agent:      %s %s\n' "$(agent_name "$agent")" "$(agent_version "$agent")"; done)
    Models:     ${PORTAL_DATA_DIR}/config/qwen (deploy/qwen-config.sh; used by every agent)

  Check the workspace isolation at any time:  sudo bash deploy/verify-isolation.sh

DONE
