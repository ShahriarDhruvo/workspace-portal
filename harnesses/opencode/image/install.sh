#!/bin/sh
# install.sh <version>: OpenCode, which is one program. npm installs each of its builds for this kind of machine (four
# for x64: for glibc and for musl, with and without AVX2), and its package links the one this system and CPU run as
# `opencode`: the image is for the host that builds it. The builds' own packages are then removed; the link keeps the
# chosen one.
# HOME: its package starts it once, and it opens its log in its home even to say its version.
# /etc/opencode: OpenCode's directory for managed settings, where the gateway mounts opencode.json.
set -eu
HOME=/tmp npm install -g "@opencode/cli@$1"
rm -rf "$(npm root -g)/@opencode/cli/node_modules"
HOME=/tmp opencode --version
mkdir -p /etc/opencode
