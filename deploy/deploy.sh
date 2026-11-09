#!/usr/bin/env bash
# Copies the project to a server and runs the installer there.
#   deploy/deploy.sh user@host [remote-dir]        (remote-dir defaults to ~/workspace-portal)
# You'll be asked for the sudo password on the server.
set -euo pipefail

TARGET=${1:?usage: deploy/deploy.sh user@host [remote-dir]}
REMOTE_DIR=${2:-workspace-portal}
ROOT=$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)

rsync -az --delete \
  --exclude node_modules --exclude .next --exclude dist --exclude .git \
  --exclude '.env' \
  "$ROOT/" "$TARGET:$REMOTE_DIR/"

ssh -t "$TARGET" "cd '$REMOTE_DIR' && sudo bash deploy/install.sh"
