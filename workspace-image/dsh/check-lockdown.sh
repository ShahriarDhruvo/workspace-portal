#!/bin/sh
# Build-time check (Dockerfile, dsh stage): every row of the lockdown must apply to the installed dsh.
# dsh skips a patch row whose target is gone with only a warning ("patch: entry X not found"), so after a
# dsh update that renamed or removed a row the image would ship a silently weaker lockdown. This fails the
# build instead, and the current image stays in use. `dsh --dump-config` composes the web profile with the
# lockdown without booting it or evaluating `!!js`, and prints those warnings on stderr.
# A row marked `# optional` (a plugin some supported dsh versions no longer have) may be missing.
#
# The check relies on dsh's wording, so it first proves it still can: it checks a copy of the lockdown with
# one more row whose id exists nowhere (the canary) and fails unless dsh reports that row exactly the way
# this script looks for missing rows. A dsh release that rewords its warnings fails the build here instead
# of passing every lockdown.
#
# Usage: check-lockdown.sh <lockdown.patch.yml>
set -eu
lockdown=$1
canary=workspace-portal-canary
# How dsh reports a row whose id doesn't exist.
missing() { printf 'patch: entry "%s" not found' "$1"; }

work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
mkdir "$work/home"
{ cat "$lockdown"; printf '\n- id: %s\n  disabled: true\n' "$canary"; } >"$work/lockdown.patch.yml"

# A fresh DSH_HOME holds no user patch, so every warning comes from the lockdown. dsh loads <cwd>/.env:
# run from the empty launch directory, as start-dsh does.
if ! output=$(cd /usr/local/lib/workspace-portal/dsh-cwd && DSH_HOME="$work/home" \
    dsh --profile web --patch "$work/lockdown.patch.yml" --dump-config 2>&1 >/dev/null); then
  printf 'check-lockdown: dsh --dump-config failed:\n%s\n' "$output" >&2
  exit 1
fi
# Only patch warnings count ("patch: entry … not found", "patch: name mismatch …", "patch insert: …"); other
# notices dsh may print on stderr must not block an update.
warnings=$(printf '%s\n' "$output" | grep -E 'patch( insert)?:' || true)
if ! printf '%s\n' "$warnings" | grep -qF "$(missing "$canary")"; then
  printf "check-lockdown: dsh's patch warnings changed; check-lockdown can't validate (dsh %s didn't report a test row as '%s'). It printed:\n%s\n" \
    "$(dsh --version)" "$(missing "$canary")" "$output" >&2
  exit 1
fi
# The canary and the optional rows may be missing; the optional ones that are get named below.
skipped=""
for id in "$canary" $(sed -n 's/^- id: \([A-Za-z0-9_-]*\) *# optional\b.*/\1/p' "$lockdown"); do
  if [ "$id" != "$canary" ] && printf '%s\n' "$warnings" | grep -qF "$(missing "$id")"; then
    skipped="${skipped:+$skipped, }$id"
  fi
  warnings=$(printf '%s\n' "$warnings" | grep -vF "$(missing "$id")" || true)
done
if [ -n "$warnings" ]; then
  printf 'check-lockdown: %s does not fit dsh %s:\n%s\n' "$lockdown" "$(dsh --version)" "$warnings" >&2
  exit 1
fi
if [ -n "$skipped" ]; then
  echo "check-lockdown: every required row of $lockdown applies to dsh $(dsh --version) (optional rows missing: $skipped)"
else
  echo "check-lockdown: every row of $lockdown applies to dsh $(dsh --version)"
fi
