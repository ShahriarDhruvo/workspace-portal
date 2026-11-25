#!/bin/sh
# What the portal changes of Qwen Code is checked where it is made (trim-web-shell.mjs, at install); here only that
# it runs with no network and no home but /tmp, as the version checks run it.
set -eu
HOME=/tmp qwen --version
# The setting that makes it read the portal's instructions (../settings.ts) is still one of its own.
grep -rqF loadFromIncludeDirectories "$(npm root -g)/@qwen-code/qwen-code" ||
  { echo "check: this Qwen Code has no context.loadFromIncludeDirectories setting" >&2; exit 1; }
