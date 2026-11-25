export DSH_HOME=/home/user/.dsh
# The folder whose AGENTS.md and skills dsh reads for every session: start.sh puts it together.
export DSH_AGENTS_HOME=/tmp/dsh-agents
# dsh's own default for new sessions, here Full access (its danger-full-access preset: the agent's commands write
# anything the workspace's user can, without asking; the container is the boundary). A person picks another mode per
# session, and another default under Settings.
export DSH_PERMISSION_MODE=danger-full-access
export DSH_TELEMETRY_DISABLED=1
export DSH_TELEMETRY_MODE=DISABLED
# dsh would copy its native addons to /tmp, which is noexec, and not start.
export NARB_DISABLE_NATIVE_CACHE=1
