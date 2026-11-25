#!/bin/sh
# The build fails when a row of the lockdown doesn't apply to this dsh version (dsh would only warn), when a setting a
# row gives isn't one its plugin has (dsh would say nothing), when default-profile.mjs no longer finds what it uses
# of dsh, or when dsh no longer looks for the portal's instructions.
set -eu
sh "$(dirname "$0")/check-lockdown.sh" /usr/local/share/workspace-portal/dsh/lockdown.patch.yml
node /usr/local/lib/workspace-portal/dsh-default-profile.mjs /usr/local/lib/node_modules/@deepseek-ai/dsh --check
# The variable that points dsh at the folder with the portal's instructions (env.sh, start.sh) is still one it reads.
grep -rqF --include='*.js' DSH_AGENTS_HOME /usr/local/lib/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai ||
  { echo "check: this dsh does not read DSH_AGENTS_HOME" >&2; exit 1; }
