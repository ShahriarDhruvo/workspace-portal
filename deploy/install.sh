#!/usr/bin/env bash
# Installs Workspace Portal on this server, or brings it up to date:  sudo bash deploy/install.sh
# A re-run rebuilds the images (the agents at their versions in use) and restarts what changed. It keeps .env,
# adding the settings it lacks, the model settings, your instructions and all data.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"

require_root
for tool in docker nft python3 openssl curl; do
  command -v "$tool" >/dev/null || die "$tool is not installed"
done
docker compose version >/dev/null 2>&1 || die "the docker compose plugin is not installed"
docker_version_ok || die "Docker 25.0.5 or newer is required: older ones let containers on internal networks resolve internet names (CVE-2024-29018)"
no_console_update "then run this again"
# A socket-activated Docker (Fedora's default) would not start the stack at boot.
systemctl enable --quiet docker.service

[[ -f $ENV_FILE ]] || { log "creating .env from .env.example"; cp .env.example "$ENV_FILE"; }
chmod 600 "$ENV_FILE"
chown "${SUDO_USER:-root}": "$ENV_FILE"
# docker compose also reads "export KEY=value" and " KEY = value", and a key's last line counts: a default added
# below would replace such a line's value.
other=$(grep -nvE '^([^[:space:]=#]+=|[[:space:]]*(#|$))' "$ENV_FILE" | cut -d= -f1) &&
  die ".env: write each setting as KEY=value from the start of its line (no \"export\", no spaces); see line ${other//$'\n'/, line }"
while IFS= read -r line; do
  grep -q "^${line%%=*}=" "$ENV_FILE" || { env_set "${line%%=*}" "${line#*=}"; log "added ${line%%=*} to .env"; }
done < <(grep -E '^[A-Z0-9_]+=' .env.example)
set_if_missing() { env_value "$ENV_FILE" "$1" >/dev/null || env_set "$1" "$2"; }
set_if_missing GATEWAY_CONTROL_SECRET "$(openssl rand -hex 32)"
set_if_missing ADMIN_PASSWORD "$(tr -dc 'A-Za-z0-9' </dev/urandom | head -c 20)"
set_if_missing HOSTD_PORTAL_TOKEN "$(openssl rand -hex 32)"
set_if_missing TZ "$(timedatectl show -p Timezone --value 2>/dev/null || true)"

# What only this host can tell, and what would otherwise fail after the builds. The gateway checks the rest of
# .env when it starts.
docker compose config -q || die "docker compose does not accept .env (see above)"
load_enabled_agents
for agent in "${ENABLED_AGENTS[@]}"; do
  valid_version "$(env_get "${AGENT_VERSION_KEY[$agent]}")" || die "${AGENT_VERSION_KEY[$agent]} in .env is not a version such as 0.27.0"
done
NEVER_REACH=$(never_reach) || die "FIREWALL_NEVER_REACH in .env must list IPv4 addresses or CIDRs"
resolvers=$(bad_resolvers "$NEVER_REACH")
[[ -z $resolvers ]] || die "in .env:$resolvers must be public IPv4 resolvers such as 1.1.1.1 or 9.9.9.9, outside $NEVER_REACH: the firewall lets what uses them reach nothing else"
mapfile -t FIREWALL_ENV < <(
  for key in WORKSPACE_SUBNET WORKSPACE_GATEWAY_IP WORKSPACE_BRIDGE SERVICE_PORT \
    ONLINE_SUBNET ONLINE_GATEWAY_IP ONLINE_BRIDGE ONLINE_DNS_1 ONLINE_DNS_2 \
    READER_SUBNET READER_BRIDGE READER_DNS_1 READER_DNS_2 SEARXNG_SUBNET SEARXNG_BRIDGE SEARXNG_DNS_1 SEARXNG_DNS_2; do
    echo "$key=$(env_get "$key")"
  done
  echo "NEVER_REACH=$NEVER_REACH"
)
env "${FIREWALL_ENV[@]}" bash container/security/firewall.sh check || die "the firewall rules do not load with the settings in .env (see above)"
overlaps=$(subid_overlaps)
[[ -z $overlaps ]] || die "the workspace UIDs (WORKSPACE_UID_BASE in .env) overlap the ranges of:$overlaps. Those accounts could read workspace files: set WORKSPACE_UID_BASE to a free range"
# A port of the stack among the workspaces': the gateway refuses to start with one of its own there
# (numberingProblems in gateway/src/config.ts), and the reader's or SearXNG's there is one a workspace needs. (A
# value that is no number is docker compose's or the gateway's to report.)
read -r WORKSPACE_PORTS PREVIEW_PORTS < <(port_ranges)
inside=""
for key in WEB_PORT CONTROL_PORT SERVICE_PORT SEARXNG_PORT READER_PORT; do
  port=$(env_get "$key")
  [[ $port =~ ^[0-9]+$ ]] || continue
  for range in "$WORKSPACE_PORTS" "$PREVIEW_PORTS"; do
    ((10#$port < ${range%-*} || 10#$port > ${range#*-})) || inside+=" $key ($port)"
  done
done
[[ -z $inside ]] || die "in .env:$inside must lie outside the workspaces' ports ($WORKSPACE_PORTS) and their previews' ($PREVIEW_PORTS). AGENT_PORT_BASE and AGENT_PORT_COUNT give those ranges: set them as .env.example does ($(env_value .env.example AGENT_PORT_BASE) and $(env_value .env.example AGENT_PORT_COUNT)) or to another free range, then run this again. Behind deploy/tailscale-https.sh, a change of these ports has that script run with \"off\" before it and again after it. An install from before every agent had its own workspaces: see \"Update and uninstall\" in README.md"
# A program holding a loopback port of the stack would stop it halfway through its start.
for service in searxng reader; do
  port=$(env_get "${service^^}_PORT")
  [[ $(docker compose port "$service" 8080 2>/dev/null) == "127.0.0.1:$port" ]] && continue
  holder=$(ss -Hltnp "sport = :$port" | awk '$4 ~ /^(127\.0\.0\.1|0\.0\.0\.0|\*|\[::\]):/')
  [[ -z $holder ]] || die "port $port on 127.0.0.1 is taken: stop what holds it or set ${service^^}_PORT in .env to a free port. $holder"
done
if selinux_on && [[ $(docker info --format '{{.SecurityOptions}}') != *name=selinux* ]]; then
  warn "SELinux is on but Docker's SELinux support is off, so containers are not confined: add \"selinux-enabled\": true to /etc/docker/daemon.json and restart Docker"
fi

# db/ belongs to the web app's account, config/ to root; the gateway creates users/<id>/ for each workspace's UID.
PORTAL_DATA_DIR=$(env_get PORTAL_DATA_DIR)
log "preparing $PORTAL_DATA_DIR"
install -d -m 0755 -o root -g root "$PORTAL_DATA_DIR"
install -d -m 0700 -o 10001 -g 10001 "$PORTAL_DATA_DIR/db"
install -d -m 0711 -o root -g root "$PORTAL_DATA_DIR/users"
install -d -m 0700 -o root -g root "$PORTAL_DATA_DIR/config"
# An install from before the model list had a name of its own keeps its files.
if [[ -d $PORTAL_DATA_DIR/config/qwen && ! -e $PORTAL_DATA_DIR/config/models ]]; then
  mv "$PORTAL_DATA_DIR/config/qwen" "$PORTAL_DATA_DIR/config/models"
  log "moved $PORTAL_DATA_DIR/config/qwen to $PORTAL_DATA_DIR/config/models"
fi
install -d -m 0700 -o root -g root "$PORTAL_DATA_DIR/config/models"
for file in settings.json system-defaults.json; do
  [[ -f $PORTAL_DATA_DIR/config/models/$file ]] || install -m 0600 -o root -g root "models/$file" "$PORTAL_DATA_DIR/config/models/$file"
done
INSTRUCTIONS="$PORTAL_DATA_DIR/config/instructions.md"
[[ -f $INSTRUCTIONS ]] || install -m 0600 -o root -g root harnesses/instructions.md "$INSTRUCTIONS"
if selinux_on; then
  log "labelling $PORTAL_DATA_DIR for containers (SELinux)"
  if command -v semanage >/dev/null; then
    semanage fcontext -a -t container_file_t "$PORTAL_DATA_DIR(/.*)?" 2>/dev/null || semanage fcontext -m -t container_file_t "$PORTAL_DATA_DIR(/.*)?"
    restorecon -R "$PORTAL_DATA_DIR"
  else
    chcon -R -t container_file_t "$PORTAL_DATA_DIR"
  fi
fi

for agent in "${ENABLED_AGENTS[@]}"; do
  build_workspace_image "$agent" "$(agent_version "$agent")"
done
log "building web, gateway, searxng and reader"
docker compose build --pull

log "installing the firewall (nftables table inet workspace_portal); never reached besides every private address: $NEVER_REACH"
# systemd gets copies: under SELinux it may not read the project directory.
install -d -m 0755 /usr/local/libexec/workspace-portal /etc/workspace-portal
install -m 0755 container/security/firewall.sh /usr/local/libexec/workspace-portal/firewall.sh
{
  echo "# Written by deploy/install.sh from $ENV_FILE. NEVER_REACH holds the addresses as they were then."
  printf '%s\n' "${FIREWALL_ENV[@]}"
} >/etc/workspace-portal/firewall.env
# After nftables.service and firewalld, which load whole rulesets of their own at boot.
cat >/etc/systemd/system/workspace-portal-firewall.service <<'UNIT'
[Unit]
Description=Workspace Portal workspace, search and page reader firewall (nftables)
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
WantedBy=multi-user.target
UNIT
# Docker requires the unit, so no container runs without the rules. A drop-in, which disabling the unit can't undo.
install -d -m 0755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/workspace-portal-firewall.conf <<'UNIT'
# Workspace Portal (deploy/install.sh): Docker starts only once the workspace firewall is loaded.
[Unit]
Requires=workspace-portal-firewall.service
After=workspace-portal-firewall.service
UNIT
systemctl daemon-reload
systemctl enable --quiet workspace-portal-firewall.service
# Reload swaps the rules in one transaction; a restart would stop Docker first.
systemctl reload-or-restart workspace-portal-firewall.service

WEB_PORT=$(env_get WEB_PORT)
PORTS="$WEB_PORT $WORKSPACE_PORTS $PREVIEW_PORTS"
if systemctl is-active --quiet firewalld; then
  sources=$(portal_sources)
  [[ -n $sources ]] || warn "firewalld: no LAN found: set FIREWALL_ALLOW_SOURCE in .env and run this again"
  log "firewalld: opening TCP $PORTS to ${sources:-nobody}"
  firewalld_rules add
else
  log "firewalld is not active: if another firewall is, open TCP $PORTS to the portal's users"
fi

# This server's readings for Admin > Usage and Energy, on loopback. The token goes in on stdin, not on a command line.
HOSTD_PORTAL_URL=$(env_get HOSTD_PORTAL_URL)
if [[ ${HOSTD_PORTAL_URL,,} == off ]]; then
  MONITORING="this server: off (HOSTD_PORTAL_URL=off)"
elif [[ $HOSTD_PORTAL_URL =~ ^http://127\.0\.0\.1:([0-9]+)/?$ ]]; then
  log "installing portal-hostd"
  bash hostd/install.sh portal --token-stdin --port "${BASH_REMATCH[1]}" <<<"$(env_get HOSTD_PORTAL_TOKEN)"
  MONITORING="this server: portal-hostd on $HOSTD_PORTAL_URL"
else
  warn "HOSTD_PORTAL_URL ($HOSTD_PORTAL_URL) is not http://127.0.0.1:<port>, so portal-hostd is not installed here"
  MONITORING="this server: $HOSTD_PORTAL_URL (not installed by this script)"
fi
if [[ -n $(env_get HOSTD_LLM_TOKEN) ]]; then
  MONITORING+="; AI server: $(env_get HOSTD_LLM_URL)"
else
  MONITORING+="; AI server: not set up (hostd/README.md)"
fi

# Only now, behind the firewall: without a key of its own SearXNG gets its example key and refuses to start.
set_if_missing SEARXNG_SECRET "$(openssl rand -hex 32)"
log "starting the stack"
docker compose up -d --remove-orphans --wait || die "the stack did not become healthy; see: docker compose ps, docker compose logs gateway"

if searxng_is_builtin; then
  SEARCH="the built-in SearXNG ($(searxng_builtin_url))"
else
  SEARCH="$(searxng_url) (SEARXNG_URL in .env; the built-in SearXNG runs unused)"
  searxng_answers "$(searxng_url)" || warn "the SearXNG at $(searxng_url) (SEARXNG_URL in .env) is not answering: web_search will fail"
fi
! exa_enabled || SEARCH="Exa (EXA_SEARCH: searches leave this server for exa.ai), then $SEARCH"
READER="on (read_page)"
if env_is READER_URL off; then READER="off (READER_URL=off)"; fi
ONLINE="on (ONLINE_WORKSPACES; Admin > Users switches it off per user)"
online_enabled || ONLINE="off for everyone (ONLINE_WORKSPACES=off)"

cat <<DONE

  Workspace Portal is running.

    Portal:     $(portal_url)
    Workspaces: ports $WORKSPACE_PORTS (each workspace has its own: one per user, agent and kind)
    Previews:   ports $PREVIEW_PORTS (the apps running in a workspace, $PREVIEW_PORT_OFFSET above its port)
    Online:     $ONLINE
    Admin:      $(env_get ADMIN_USERNAME)   (first sign-in: grep ^ADMIN_PASSWORD $ENV_FILE; you choose a new one then)
$(for agent in "${ENABLED_AGENTS[@]}"; do printf '    Agent:      %s %s\n' "${AGENT_NAME[$agent]}" "$(agent_version "$agent")"; done)
    Models:       $PORTAL_DATA_DIR/config/models (deploy/models.sh; used by every agent)
    Instructions: $INSTRUCTIONS (every agent is told them)
    Web:        web_search through $SEARCH; page reader $READER
    Monitoring: $MONITORING

  Check the workspace isolation at any time:  sudo bash deploy/verify-isolation.sh

DONE
