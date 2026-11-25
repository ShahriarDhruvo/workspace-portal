#!/bin/sh
# No file of OpenCode is edited, so nothing here can stop fitting it; what can change is how it reads the gateway's
# settings and answers the gateway's requests. check-serve.mjs says what it checks: OpenCode has to start, take a
# turn and open a terminal without a network.
set -eu
here=$(dirname "$0")
node "$here/check-serve.mjs" "$here/check-settings.json"
