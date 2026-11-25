# Sourced first by every harness's start script (harnesses/<name>/image/start.sh, installed as start-harness): refuses
# to run as root, sets the harness's environment, gives Go a folder it can run programs from, and sets IP, the
# container's own address, where the harness has to listen for the gateway to reach it.
if [ "$(id -u)" = "0" ]; then
  echo "start-harness: refusing to run as root; the gateway runs each workspace as a UID of its own" >&2
  exit 1
fi
. /usr/local/lib/workspace-portal/harness-env.sh
# `go run` and `go test` build what they run in Go's temporary folder; /tmp is noexec.
export GOTMPDIR="$HOME/.cache/go-tmp"
mkdir -p "$GOTMPDIR"
IP=$(hostname -i | awk '{print $1}')
