#!/usr/bin/env bash
# Workspace Portal installer. Run on the server, as root, from the project directory:
#   sudo bash deploy/install.sh
# Idempotent: re-running rebuilds the images (the agents' current versions: the ones chosen in the
# admin console or with update-image.sh, else those in .env) and restarts the stack, keeping .env,
# the Qwen Code settings and all data.
set -euo pipefail
# shellcheck source=deploy/lib.sh
source "$(dirname "${BASH_SOURCE[0]}")/lib.sh"
cd "$ROOT"
OWNER=${SUDO_USER:-root}

require_root
# Not while the admin console runs an agent update: the image rebuild below would race it, and `docker
# compose up` (which recreates a changed gateway) would abandon it. A gateway that isn't running (a first
# install) answers nothing, so this passes.
console_update_running && die "the admin console is running an update right now (Admin > Updates): wait for it to finish, or cancel it there; then run this again"
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
set_if_missing HOSTD_PORTAL_TOKEN "$(openssl rand -hex 32)"
# The containers run in UTC unless told otherwise, and the daily totals (Home's usage today, the energy per day
# on Admin > Usage) begin at their midnight: give them the host's time zone.
if ! env_value "$ENV_FILE" TZ >/dev/null; then
  zone=$(timedatectl show -p Timezone --value 2>/dev/null || true)
  if [[ -z $zone ]]; then
    zone=$(readlink /etc/localtime 2>/dev/null || true)
    zone=${zone##*/zoneinfo/}
  fi
  if [[ $zone =~ ^[A-Za-z0-9_+-]+(/[A-Za-z0-9_+-]+)*$ ]]; then
    env_set TZ "$zone"
    log "recorded the host's time zone in .env: TZ=${zone}"
  else
    warn "could not tell the host's time zone, so days begin at midnight UTC; set TZ in .env (e.g. America/New_York)"
  fi
fi

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
# Since every user has a Private and an Online workspace: the portal-wide switch, written out so the admin
# finds it in .env (the rest of the ONLINE_* settings keep their defaults until set).
set_if_missing ONLINE_WORKSPACES "$(env_value .env.example ONLINE_WORKSPACES)"
for key in WORKSPACE_IMAGE LLM_MODEL_ID LLM_MODEL_NAME LLM_CONTEXT_WINDOW LLM_MAX_TOKENS LLM_INPUT LLM_REASONING; do
  if grep -qE "^${key}=" "$ENV_FILE"; then
    sed -i "s|^${key}=|# no longer used: ${key}=|" "$ENV_FILE"
    log "commented out the setting ${key} in .env (no longer used)"
  fi
done

PORTAL_DATA_DIR=$(env_get PORTAL_DATA_DIR)
load_enabled_agents
for agent in "${ENABLED_AGENTS[@]}"; do
  valid_version "$(env_get "$(agent_version_key "$agent")")" || die "$(agent_version_key "$agent") in .env is not a version (like 0.27.0)"
done
WEB_PORT=$(web_port)
AGENT_PORTS=$(agent_port_range)
ONLINE_AGENT_PORTS=$(online_agent_port_range)
case $(env_get ONLINE_WORKSPACES | tr '[:upper:]' '[:lower:]') in
  true | on | yes | 1 | false | off | no | 0) ;;
  *) die "ONLINE_WORKSPACES in .env must be on or off (got \"$(env_get ONLINE_WORKSPACES)\")" ;;
esac
# The gateway refuses these too, but only once the stack has been restarted: say so before anything changes.
# A port names a user and a kind, and a UID owns one kind's files: the kinds may share neither.
port_count=$(env_get AGENT_PORT_COUNT)
private_base=$(env_get AGENT_PORT_BASE)
online_base=$(online_agent_port_base)
if ((private_base < online_base + port_count - 1 && online_base < private_base + port_count - 1)); then
  die "the Private and Online workspace ports overlap (${AGENT_PORTS} and ${ONLINE_AGENT_PORTS}): set ONLINE_AGENT_PORT_BASE in .env to at least $((private_base + port_count - 1)), or leave it empty"
fi
# UIDs stay clear of system and human accounts, and below systemd's foreign UID range (2147352576: all users have
# access to files owned there; past 2^31 some code takes UIDs for negative numbers), as in gateway/src/config.ts.
for uid_key in WORKSPACE_UID_BASE ONLINE_UID_BASE; do
  uid_base=$(env_get "$uid_key")
  [[ $uid_base =~ ^[1-9][0-9]{0,9}$ ]] && ((uid_base >= 100000 && uid_base + port_count - 1 < 2147352576)) ||
    die "$uid_key in .env must be a number of at least 100000, with $uid_key + AGENT_PORT_COUNT below 2147352576 (got \"${uid_base}\")"
done
private_uid_base=$(env_get WORKSPACE_UID_BASE)
online_uid_base=$(env_get ONLINE_UID_BASE)
if ((private_uid_base < online_uid_base + port_count - 1 && online_uid_base < private_uid_base + port_count - 1)); then
  die "the Private and Online workspace UIDs overlap (WORKSPACE_UID_BASE ${private_uid_base}, ONLINE_UID_BASE ${online_uid_base}): the bases must be at least AGENT_PORT_COUNT (${port_count}) apart"
fi
for key in WORKSPACE_SUBNET ONLINE_SUBNET; do
  [[ $(env_get "$key") =~ ^[0-9]+(\.[0-9]+){3}/[0-9]+$ ]] || die "$key in .env is not an IPv4 subnet (like 172.28.0.0/16)"
done
for key in WORKSPACE_GATEWAY_IP ONLINE_GATEWAY_IP; do
  # These go into the firewall rules as they are.
  [[ $(env_get "$key") =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "$key in .env is not an IPv4 address"
done
[[ $(env_get WORKSPACE_BRIDGE) != "$(env_get ONLINE_BRIDGE)" ]] || die "WORKSPACE_BRIDGE and ONLINE_BRIDGE in .env must differ"
command -v python3 >/dev/null || die "python3 is not installed (the installer works out the firewall's address sets with it)"
# What the Online workspaces, the reader and SearXNG may never reach, whatever its address, on top of every private
# one (the firewall's `never` set, see never_reach in deploy/lib.sh): this host's networks and router, the servers
# the portal talks to, FIREWALL_NEVER_REACH.
NEVER_REACH=$(never_reach) || die "FIREWALL_NEVER_REACH in .env must list IPv4 addresses or CIDRs (see above)"
# The resolvers of the Online workspaces, the reader and SearXNG go into the firewall rules as they are. The rules
# drop every private address and `never` before they let DNS through, so another resolver would not answer (and
# one on the LAN would be a way into it); the gateway refuses Online ones that are not public, too.
for key in ONLINE_DNS_1 ONLINE_DNS_2 READER_DNS_1 READER_DNS_2 SEARXNG_DNS_1 SEARXNG_DNS_2; do
  resolver=$(env_get "$key")
  [[ $resolver =~ ^[0-9]+(\.[0-9]+){3}$ ]] || die "$key in .env is not an IPv4 address"
  ipv4_public "$resolver" || die "$key in .env (${resolver}) is not a public address: the firewall lets what uses it reach no private address, your router included. Use a public resolver, such as 1.1.1.1 or 9.9.9.9."
  ipv4_outside "$resolver" "$NEVER_REACH" ||
    die "$key in .env (${resolver}) is on this host's network or is a server the portal talks to (${NEVER_REACH}), which the firewall keeps the workspaces off. Use another public resolver, such as 1.1.1.1 or 9.9.9.9."
done

# ---------------------------------------------------------------- host checks
# Workspace UIDs (both kinds') must not fall inside a range /etc/subuid or /etc/subgid hands to a host
# account: that account could then read workspace files through a user namespace (podman unshare).
for uid_key in WORKSPACE_UID_BASE ONLINE_UID_BASE; do
  uid_first=$(env_get "$uid_key")
  uid_last=$((uid_first + port_count))
  for file in /etc/subuid /etc/subgid; do
    [[ -r $file ]] || continue
    while IFS=: read -r name start size; do
      [[ $start =~ ^[0-9]+$ && $size =~ ^[0-9]+$ ]] || continue
      if ((start <= uid_last && start + size - 1 >= uid_first)); then
        die "workspace UIDs ${uid_first}-${uid_last} overlap ${name}'s range in ${file} (${start}-$((start + size - 1))). Set ${uid_key} in .env to a free range."
      fi
    done <"$file"
  done
done

if command -v selinuxenabled >/dev/null && selinuxenabled &&
  ! docker info --format '{{.SecurityOptions}}' 2>/dev/null | grep -q 'name=selinux'; then
  warn "SELinux is on, but Docker's SELinux support is off, so containers are not SELinux-confined."
  warn "To turn it on, add \"selinux-enabled\": true to /etc/docker/daemon.json and restart Docker (affects every Docker container)."
fi

# ---------------------------------------------------------------- data dirs
# Ownership is the access model:
#   db/          the web app's service account (10001) only; the gateway reaches it as root.
#   users/<id>/  created by the gateway: private/ and online/, each kind's home and workspace owned by that
#                kind's own UID (WORKSPACE_UID_BASE + id, ONLINE_UID_BASE + id). The gateway moves the files
#                of an older install (users/<id>/home, workspace) into private/ while that user has no container.
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
log "building web, gateway, searxng and reader"
docker compose build --pull

# ---------------------------------------------------------------- firewall
log "installing the workspace, search and page reader firewall (nftables table inet workspace_portal)"
# systemd gets its own copy of the script and settings: under SELinux it may not read /home.
install -d -m 0755 /usr/local/libexec/workspace-portal /etc/workspace-portal
install -m 0755 deploy/firewall.sh /usr/local/libexec/workspace-portal/firewall.sh
{
  echo "# Generated by deploy/install.sh from ${ENV_FILE}"
  for key in WORKSPACE_SUBNET WORKSPACE_GATEWAY_IP WORKSPACE_BRIDGE SERVICE_PORT \
    ONLINE_SUBNET ONLINE_GATEWAY_IP ONLINE_BRIDGE ONLINE_DNS_1 ONLINE_DNS_2 \
    READER_SUBNET READER_BRIDGE READER_DNS_1 READER_DNS_2 SEARXNG_SUBNET SEARXNG_BRIDGE SEARXNG_DNS_1 SEARXNG_DNS_2; do
    echo "${key}=$(env_get "$key")"
  done
  # Worked out above (never_reach): addresses as they were at this run. Run the installer again when the LLM
  # server or the LAN changes address.
  echo "NEVER_REACH=${NEVER_REACH}"
} >/etc/workspace-portal/firewall.env
chmod 0644 /etc/workspace-portal/firewall.env
log "the Online workspaces, the reader and SearXNG never reach, besides every private address: ${NEVER_REACH}"
# Before docker.service, so the rules exist before any workspace starts; after nftables.service and
# firewalld, which may load whole rulesets of their own at boot.
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
# Docker requires it: when "apply" fails, Docker (and with it every container) stays down rather than running
# workspaces without their fence. A drop-in rather than RequiredBy= in the unit above, so that disabling the unit
# can't undo it. It also means a restart of the firewall unit restarts Docker (systemd stops Docker first, so no
# container runs without the rules): to load changed rules, reload it, as below.
install -d -m 0755 /etc/systemd/system/docker.service.d
cat >/etc/systemd/system/docker.service.d/workspace-portal-firewall.conf <<'UNIT'
# Workspace Portal (deploy/install.sh): Docker starts only once the workspace firewall is loaded.
[Unit]
Requires=workspace-portal-firewall.service
After=workspace-portal-firewall.service
UNIT
systemctl daemon-reload
# reenable: drops the docker.service.wants link earlier versions installed (the drop-in requires the unit now).
systemctl reenable workspace-portal-firewall.service >/dev/null 2>&1
# Reload when it is already running: "apply" swaps the rules atomically, while a restart would remove
# them for a moment (and restart Docker).
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
    ufw allow from "$source" to any port "${ONLINE_AGENT_PORTS/-/:}" proto tcp >/dev/null
  done
fi

# ---------------------------------------------------------------- portal-hostd
# This server's live readings and energy meter for Admin > Usage (hostd/README.md); before the stack starts,
# so the gateway finds it at once. It listens on loopback only. The token goes on stdin, not the command line.
HOSTD_PORTAL_URL=$(env_get HOSTD_PORTAL_URL)
if [[ ${HOSTD_PORTAL_URL,,} == off ]]; then
  HOSTD_STATE="off (HOSTD_PORTAL_URL=off)"
elif [[ $HOSTD_PORTAL_URL =~ ^http://127\.0\.0\.1:([0-9]+)/?$ ]]; then
  log "installing portal-hostd (live server readings)"
  bash hostd/install.sh portal --token-stdin --port "${BASH_REMATCH[1]}" <<<"$(env_get HOSTD_PORTAL_TOKEN)"
  HOSTD_STATE="this server: portal-hostd on ${HOSTD_PORTAL_URL}"
else
  warn "HOSTD_PORTAL_URL (${HOSTD_PORTAL_URL}) is not http://127.0.0.1:<port>, so portal-hostd is not installed here; set it so, or to off"
  HOSTD_STATE="this server: ${HOSTD_PORTAL_URL} (not installed by this script)"
fi
if [[ -n $(env_get HOSTD_LLM_TOKEN) ]]; then
  HOSTD_STATE="${HOSTD_STATE}; LLM server: $(env_get HOSTD_LLM_URL)"
else
  HOSTD_STATE="${HOSTD_STATE}; LLM server: not set up (README: \"Server monitoring and LLM engine updates\")"
fi

# ---------------------------------------------------------------- start
# SearXNG and the page reader are published on loopback ports. A program that already holds one
# would stop the stack halfway through its start: most likely a SearXNG installed by hand for an
# earlier version of the portal, which had none of its own. Checked here, after the builds, so that
# such a SearXNG can serve until the moment the new one is ready to take its place.
SEARXNG_PORT=$(env_get SEARXNG_PORT)
READER_PORT=$(env_get READER_PORT)
if ! stack_port_available searxng "$SEARXNG_PORT"; then
  holder=$(loopback_port_holder "$SEARXNG_PORT")
  die "port ${SEARXNG_PORT} on 127.0.0.1 is taken by another program${holder:+ (${holder})}, and the portal now starts its own SearXNG there. Nothing was restarted. If that is a SearXNG installed for an earlier version of the portal: stop and disable it, then run this again (it is quick now, the images are built; web search is down in between). To keep using it instead: set SEARXNG_PORT in .env to a free port and SEARXNG_URL to its address (http://127.0.0.1:${SEARXNG_PORT}). Anything else on that port: set SEARXNG_PORT to a free port."
fi
if ! stack_port_available reader "$READER_PORT"; then
  holder=$(loopback_port_holder "$READER_PORT")
  die "port ${READER_PORT} on 127.0.0.1 is taken by another program${holder:+ (${holder})}. Nothing was restarted: set READER_PORT in .env to a free port and run this again."
fi
# The old .env.example set SEARXNG_URL to the address the stack's own SearXNG now has. Left in place it
# would keep the gateway on that address after a later change of SEARXNG_PORT.
if env_value "$ENV_FILE" SEARXNG_URL >/dev/null && searxng_is_builtin; then
  sed -i "s|^SEARXNG_URL=|# now the default (the portal's own SearXNG): SEARXNG_URL=|" "$ENV_FILE"
  log "commented out SEARXNG_URL in .env: it named the portal's own SearXNG, which is the default now"
fi
# Only now, with the firewall in place: without a key SearXNG gets its example key, which it refuses
# to start with, so no earlier "docker compose up" can start it unfenced.
set_if_missing SEARXNG_SECRET "$(openssl rand -hex 32)"

log "starting the stack"
docker compose up -d --remove-orphans

log "waiting for the web app"
for _ in $(seq 1 60); do
  if curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 2
done
curl -fsS "http://127.0.0.1:${WEB_PORT}/api/health" >/dev/null || die "web app did not become healthy; see: docker compose logs web gateway"
# Waits up to 30 s for a loopback service of the stack to answer.
answers() { # url
  local _
  for _ in $(seq 1 15); do
    if curl -fsS --max-time 3 "$1" >/dev/null 2>&1; then return 0; fi
    sleep 2
  done
  return 1
}
if searxng_is_builtin; then
  SEARCH_STATE="the built-in SearXNG ($(searxng_builtin_url))"
  answers "$(searxng_builtin_url)/healthz" || warn "SearXNG is not answering; agents will see web_search fail. See: docker compose logs searxng"
else
  SEARCH_STATE="$(searxng_url) (SEARXNG_URL in .env; the built-in SearXNG runs unused)"
  searxng_answers "$(searxng_url)" || warn "the SearXNG at $(searxng_url) (SEARXNG_URL in .env) is not answering; agents will see web_search fail. Remove SEARXNG_URL from .env to use the portal's own."
fi
READER_STATE="off (READER_URL=off)"
if [[ $(env_get READER_URL | tr '[:upper:]' '[:lower:]') != off ]]; then
  READER_STATE="on (read_page)"
  answers "http://127.0.0.1:${READER_PORT}/healthz" || warn "the page reader is not answering; agents will see read_page fail. See: docker compose logs reader"
fi
ONLINE_STATE="off for everyone (ONLINE_WORKSPACES=off)"
if online_enabled; then ONLINE_STATE="on (ONLINE_WORKSPACES; Admin > Users switches it off per user)"; fi

cat <<DONE

  Workspace Portal is running.

    Portal:     http://$(host_ip || echo '<server-ip>'):${WEB_PORT}
    Workspaces: Private ports ${AGENT_PORTS}, Online ports ${ONLINE_AGENT_PORTS} (one per user and kind)
    Online:     ${ONLINE_STATE}
    Admin:      $(env_get ADMIN_USERNAME)   (first sign-in: grep ^ADMIN_PASSWORD ${ENV_FILE}; you choose a new one then)
$(for agent in "${ENABLED_AGENTS[@]}"; do printf '    Agent:      %s %s\n' "$(agent_name "$agent")" "$(agent_version "$agent")"; done)
    Models:     ${PORTAL_DATA_DIR}/config/qwen (deploy/qwen-config.sh; used by every agent)
    Web:        web_search through ${SEARCH_STATE}; page reader ${READER_STATE}
    Monitoring: ${HOSTD_STATE}

  Check the workspace isolation at any time:  sudo bash deploy/verify-isolation.sh

DONE
