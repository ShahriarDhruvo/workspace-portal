#!/bin/sh
# install.sh <version>: OpenCode, which is one program, and the plugins and skills a workspace starts with.
# npm installs each of OpenCode's builds for this kind of machine (four for x64: for glibc and for musl, with and
# without AVX2), and its package links the one this system and CPU run as `opencode`: the image is for the host that
# builds it. The builds' own packages are then removed; the link keeps the chosen one.
# HOME: its package starts it once, and it opens its log in its home even to say its version.
# /etc/opencode: OpenCode's directory for managed settings, where the gateway mounts opencode.json.
set -eu
. /usr/local/lib/workspace-portal/fetch.sh
HOME=/tmp npm install -g "@opencode/cli@$1"
rm -rf "$(npm root -g)/@opencode/cli/node_modules"
HOME=/tmp opencode --version
mkdir -p /etc/opencode

# The plugins and skills, in the folders the gateway's settings name (../settings.ts): OpenCode loads them from
# there, so a Private workspace, which can download nothing, has them too. Each is pinned by its SHA-256.
share=/usr/local/share/workspace-portal/opencode

# Superpowers: skills for working in steps (brainstorm, plan, test first, debug, review), and the plugin that tells
# every session about them.
SUPERPOWERS=7.0.2
fetch "https://github.com/obra/superpowers/archive/refs/tags/v$SUPERPOWERS.tar.gz" a0bd5d862537ae2caa9a7b5546b7e597eeabda1b9ca8aa67abbbc967c9f2005e
unpack "$share/plugins/superpowers" --strip-components=1 \
  "superpowers-$SUPERPOWERS/index.js" "superpowers-$SUPERPOWERS/package.json" "superpowers-$SUPERPOWERS/LICENSE" \
  "superpowers-$SUPERPOWERS/.opencode/plugins" "superpowers-$SUPERPOWERS/skills"

# Safety Net: refuses the commands that destroy work (rm -rf of a home or a repository, git reset --hard, an install
# script piped from the internet) and reads of keys and credentials.
SAFETY_NET=2.8.3
fetch "https://registry.npmjs.org/cc-safety-net/-/cc-safety-net-$SAFETY_NET.tgz" 7b0103f509f7057eaf7cd1f0a944893732f122e8cffd9be3667de8559ac5eee2
unpack "$share/plugins/safety-net" --strip-components=1

# skill <repository> <commit> <SHA-256> <path in it>: that folder of the repository, as a skill named after it.
# Stripped from every path: the archive's top folder and the folders above the skill's files.
skill() {
  fetch "https://codeload.github.com/$1/tar.gz/$2" "$3"
  unpack "$share/skills/${4##*/}" --strip-components="$(($(echo "$4" | tr -cd / | wc -c) + 2))" "${1##*/}-$2/$4"
}
skill anthropics/skills e4bb5d960d87126ff3b3a8af1a104b7db67560ba 287d5d39770a929db26f35fd13833b53f1ac3db58b96c76602b3487f8f573e19 skills/frontend-design
skill vercel-labs/agent-skills 5a37a6329fbad3666c3207392a6a7c0110e92efb 3fa11f3c03f7506ac164a4f9f41c296e1a62ca6fe6c035347861489a8ccf6f5a skills/react-best-practices
skill shadcn-ui/ui 055aa6b7837b1808456a24beb4c97a677864aa82 3c58f5aee57e9079576eccb1a0b93ec559c458e166bdb250c274b983a4ac9e78 skills/shadcn
skill mattpocock/skills d65391149dbb5fe76478e76fa8d5122b2aa5a70e 1bd2d67bf2c909de9773606aab6fce367e1813392b3a2fcd286047385b1b76c3 skills/engineering/research
