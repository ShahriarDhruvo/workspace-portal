# shellcheck shell=bash
# spec.ts's sandbox() as `docker run` options, for the scripts that start a container from a workspace image
# (spec.test.ts compares the two). A size goes after the tmpfs options: --tmpfs "/tmp:$SANDBOX_TMPFS,size=16m".
SANDBOX=(--read-only --cap-drop ALL --security-opt no-new-privileges)
SANDBOX_TMPFS=rw,nosuid,nodev
