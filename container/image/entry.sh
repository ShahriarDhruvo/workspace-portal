# Sourced first by every harness's start script (harnesses/<name>/image/start.sh, installed as start-harness): refuses
# to run as root, sets the harness's environment, puts the temporary folder where programs can run, and sets IP, the
# container's own address, where the harness has to listen for the gateway to reach it.
if [ "$(id -u)" = "0" ]; then
  echo "start-harness: refusing to run as root; the gateway runs each workspace as a UID of its own" >&2
  exit 1
fi
. /usr/local/lib/workspace-portal/harness-env.sh
# Compilers build programs in the temporary folder and run them there (`go run`, a Rust doc test, `cargo install`),
# and /tmp is noexec: the folder is in the home, emptied at every start as /tmp is.
export TMPDIR="$HOME/.cache/tmp"
rm -rf "$TMPDIR"
mkdir -p "$TMPDIR"
IP=$(hostname -i | awk '{print $1}')
