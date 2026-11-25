#!/bin/sh
# The build fails when a row of the lockdown doesn't apply to this dsh version (dsh would only warn), when a setting a
# row gives isn't one its plugin has (dsh would say nothing), or when default-profile.mjs no longer finds what it uses
# of dsh.
set -eu
sh "$(dirname "$0")/check-lockdown.sh" /usr/local/share/workspace-portal/dsh/lockdown.patch.yml
node /usr/local/lib/workspace-portal/dsh-default-profile.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh --check
