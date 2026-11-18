#!/bin/sh
# check-lockdown.sh <lockdown.patch.yml>
# Fails the image build unless every row of the lockdown applies to the installed dsh, which only warns about a row
# whose target is gone. Rows marked "# optional" may be missing. dsh --dump-config composes the web profile with
# the lockdown, without starting it, and prints those warnings. The check reads dsh's wording, so it adds a row
# that exists nowhere (the canary) and fails unless dsh reports it the way missing() expects.
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
