#!/bin/sh
# install.sh <version>: Qwen Code, with its Web Shell trimmed in place as trim-web-shell.mjs says (Qwen Code has no
# setting for it). When a change no longer fits a Qwen Code version, the script names the change and fails the build.
# /etc/workspace-portal/qwen: where the gateway mounts settings.json and system-defaults.json.
set -eu
npm install -g "@qwen-code/qwen-code@$1"
node "$(dirname "$0")/trim-web-shell.mjs" "$(npm root -g)/@qwen-code/qwen-code"
mkdir -p /etc/workspace-portal/qwen
