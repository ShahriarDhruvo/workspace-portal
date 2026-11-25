#!/bin/sh
# install.sh <version>: DeepSeek Harness, with two edits of its files, each failing the build when it no longer
# fits. The YAML parser the first uses is in /tmp and does not stay in the image.
#   adapt-presets.mjs: its agent presets without the built-in web tools the lockdown turns off;
#   portal-theme.mjs: its dark theme in the blacks of Qwen Code's Web Shell and the portal.
set -eu
here=$(dirname "$0")
npm install -g "@deepseek-ai/dsh@$1"
dsh=$(npm root -g)/@deepseek-ai/dsh
npm install --prefix /tmp/wp-tools yaml@2.9.1
cp "$here/adapt-presets.mjs" /tmp/wp-tools/
node /tmp/wp-tools/adapt-presets.mjs "$dsh"
node "$here/portal-theme.mjs" "$dsh"
# /etc/workspace-portal/dsh: where the gateway mounts portal.patch.yml.
# dsh-cwd: dsh's launch directory, empty and root's, because dsh loads <cwd>/.env.
mkdir -p /etc/workspace-portal/dsh /usr/local/share/workspace-portal/dsh /usr/local/lib/workspace-portal/dsh-cwd
install -m 0644 "$here/lockdown.patch.yml" /usr/local/share/workspace-portal/dsh/lockdown.patch.yml
# start.sh runs it: Auto review switched on once in each person's profile.
install -m 0644 "$here/default-profile.mjs" /usr/local/lib/workspace-portal/dsh-default-profile.mjs
