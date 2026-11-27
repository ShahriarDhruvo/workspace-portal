#!/bin/sh
# Installs llama-swap VERSION (a release number, such as 277) into DEST, a directory that does not exist yet: the
# linux_amd64 binary of its GitHub release, checked against the release's checksums. portal-hostd runs it for an
# update (llm-server/apps.json); docs/GUIDE.md runs it once by hand.
set -eu
version=${1:?usage: install.sh VERSION DEST}
dest=${2:?usage: install.sh VERSION DEST}
case $version in *[!0-9]*) echo "VERSION must be a release number, such as 277" >&2; exit 2 ;; esac
base=https://github.com/mostlygeek/llama-swap/releases/download/v$version
archive=llama-swap_${version}_linux_amd64.tar.gz
mkdir "$dest"
echo "Downloading $archive"
curl -fsSL --retry 3 -o "$dest/$archive" "$base/$archive"
curl -fsSL --retry 3 -o "$dest/checksums.txt" "$base/llama-swap_${version}_checksums.txt"
echo "Checking its SHA-256"
(cd "$dest" && grep "  $archive\$" checksums.txt | sha256sum --check --strict -)
tar -xzf "$dest/$archive" -C "$dest" llama-swap
rm "$dest/$archive" "$dest/checksums.txt"
"$dest/llama-swap" --version
